package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.fjsp.business.common.BizException;
import com.fjsp.business.common.LookupSupport;
import com.fjsp.business.dto.DashboardBreakdownItem;
import com.fjsp.business.dto.DashboardEventItem;
import com.fjsp.business.dto.DashboardExceptions;
import com.fjsp.business.dto.DashboardMachineItem;
import com.fjsp.business.dto.DashboardOrderStats;
import com.fjsp.business.dto.DashboardPlanResponse;
import com.fjsp.business.dto.DashboardResponse;
import com.fjsp.business.dto.DashboardTaskItem;
import com.fjsp.business.dto.DashboardTimeWindow;
import com.fjsp.business.dto.DelayedOrderItem;
import com.fjsp.business.dto.ExecutionDeviationItem;
import com.fjsp.business.entity.Event;
import com.fjsp.business.entity.ExecutionRecord;
import com.fjsp.business.entity.Machine;
import com.fjsp.business.entity.OrderStatus;
import com.fjsp.business.entity.PlanVersion;
import com.fjsp.business.entity.ProductionOrder;
import com.fjsp.business.entity.ScheduleOperation;
import com.fjsp.business.entity.ScheduleTask;
import com.fjsp.business.entity.TaskStatus;
import com.fjsp.business.repository.EventImpactRepository;
import com.fjsp.business.repository.EventRepository;
import com.fjsp.business.repository.ExecutionRecordRepository;
import com.fjsp.business.repository.MachineRepository;
import com.fjsp.business.repository.PlanVersionRepository;
import com.fjsp.business.repository.ProductionOrderRepository;
import com.fjsp.business.repository.ScheduleOperationRepository;
import com.fjsp.business.repository.ScheduleTaskRepository;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;

@Service
public class DashboardService {

    /** F-01 看板列表条数口径：最近事件 20 条、算法任务 10 条、各类异常 20 条。 */
    private static final int RECENT_EVENT_LIMIT = 20;
    private static final int RECENT_TASK_LIMIT = 10;
    private static final int EXCEPTION_LIMIT = 20;
    private static final int BREAKDOWN_LIMIT = 50;

    /** "当前班次"按 Asia/Shanghai 墙钟的 8 小时班次（00-08 / 08-16 / 16-24）切分。 */
    private static final ZoneId SHIFT_ZONE = ZoneId.of("Asia/Shanghai");
    private static final int SHIFT_HOURS = 8;

    /** 异常严重级别（数值越大越严重，用于统一排序）。 */
    static final int SEVERITY_HIGH = 3;
    static final int SEVERITY_MEDIUM = 2;
    static final int SEVERITY_LOW = 1;

    private final MachineRepository machineRepository;
    private final ProductionOrderRepository productionOrderRepository;
    private final EventRepository eventRepository;
    private final EventImpactRepository eventImpactRepository;
    private final ScheduleTaskRepository scheduleTaskRepository;
    private final ScheduleOperationRepository scheduleOperationRepository;
    private final ExecutionRecordRepository executionRecordRepository;
    private final PlanVersionRepository planVersionRepository;
    private final ImpactCalculator impactCalculator;

    public DashboardService(MachineRepository machineRepository,
                            ProductionOrderRepository productionOrderRepository,
                            EventRepository eventRepository,
                            EventImpactRepository eventImpactRepository,
                            ScheduleTaskRepository scheduleTaskRepository,
                            ScheduleOperationRepository scheduleOperationRepository,
                            ExecutionRecordRepository executionRecordRepository,
                            PlanVersionRepository planVersionRepository,
                            ImpactCalculator impactCalculator) {
        this.machineRepository = machineRepository;
        this.productionOrderRepository = productionOrderRepository;
        this.eventRepository = eventRepository;
        this.eventImpactRepository = eventImpactRepository;
        this.scheduleTaskRepository = scheduleTaskRepository;
        this.scheduleOperationRepository = scheduleOperationRepository;
        this.executionRecordRepository = executionRecordRepository;
        this.planVersionRepository = planVersionRepository;
        this.impactCalculator = impactCalculator;
    }

    /** 兼容旧调用：不选版本、不加时间窗口。 */
    public DashboardResponse dashboard() {
        return dashboard(null, null, null, null);
    }

    /**
     * F-01 看板聚合。
     *
     * @param planVersionIdOrCode 可选，按计划版本 id 或 versionCode 指定看板展示的版本；
     *                            缺省取当前 PUBLISHED/EXECUTING 版本
     * @param window              可选时间窗口：SHIFT（当前班次）/ LAST_24H（最近 24 小时）/
     *                            CUSTOM（自定义，需 from/to）；缺省不过滤
     * @param from                CUSTOM 窗口起点（ISO 8601，含）
     * @param to                  CUSTOM 窗口终点（ISO 8601，不含）
     */
    public DashboardResponse dashboard(String planVersionIdOrCode, String window, String from, String to) {
        OffsetDateTime[] range = resolveWindow(window, from, to, OffsetDateTime.now());

        PlanVersion plan = planVersionIdOrCode != null && !planVersionIdOrCode.isBlank()
                ? LookupSupport.byIdOrCode(planVersionIdOrCode, planVersionRepository::findById,
                        planVersionRepository::findByVersionCode, "计划版本不存在")
                : impactCalculator.currentPublishedPlan();
        DashboardPlanResponse currentPlan = plan != null
                ? new DashboardPlanResponse(plan.getId(), plan.getVersionCode(), plan.getStatus(),
                        plan.getCandidateType(), plan.getPublishedAt(), plan.getKpi())
                : null;

        DashboardTimeWindow appliedWindow = new DashboardTimeWindow(
                range != null ? window.trim().toUpperCase() : null,
                range != null ? range[0] : null,
                range != null ? range[1] : null);

        Map<String, Long> orderStats = new LinkedHashMap<>();
        for (Object[] row : productionOrderRepository.countGroupedByStatus()) {
            orderStats.put((String) row[0], (Long) row[1]);
        }
        DashboardOrderStats ordersCard = new DashboardOrderStats(productionOrderRepository.count(),
                orderStats);

        List<DashboardMachineItem> machines = new ArrayList<>();
        for (Machine machine : machineRepository.findAll()) {
            machines.add(new DashboardMachineItem(machine.getId(), machine.getWorkCenterId(),
                    machine.getStatus(), machine.getProductFamilies()));
        }
        machines.sort(Comparator.comparing(DashboardMachineItem::machineId));

        List<Event> events = range != null
                ? eventRepository.findByOccurredAtGreaterThanEqualAndOccurredAtLessThanOrderByOccurredAtDesc(
                        range[0], range[1], PageRequest.of(0, RECENT_EVENT_LIMIT))
                : eventRepository.findAllByOrderByOccurredAtDesc(PageRequest.of(0, RECENT_EVENT_LIMIT));
        // 影响工序数一次 group by 取回，替代逐事件 count 的 N+1
        List<String> eventIds = events.stream().map(Event::getId).toList();
        Map<String, Long> impactCounts = new HashMap<>();
        if (!eventIds.isEmpty()) {
            for (Object[] row : eventImpactRepository.countGroupedByEventIdIn(eventIds)) {
                impactCounts.put((String) row[0], (Long) row[1]);
            }
        }
        List<DashboardEventItem> recentEvents = new ArrayList<>();
        for (Event event : events) {
            recentEvents.add(new DashboardEventItem(event.getId(), event.getEventCode(),
                    event.getEventType(), event.getSubType(), event.getMachineId(), event.getOrderId(),
                    event.getOccurredAt(), event.getStatus(),
                    impactCounts.getOrDefault(event.getId(), 0L)));
        }

        List<DashboardTaskItem> recentTasks = new ArrayList<>();
        for (ScheduleTask task : scheduleTaskRepository.findAllByOrderByCreatedAtDesc(
                PageRequest.of(0, RECENT_TASK_LIMIT))) {
            recentTasks.add(taskEntry(task));
        }

        List<DelayedOrderItem> delayedOrders = new ArrayList<>();
        if (plan != null) {
            Map<String, ScheduleOperation> lastEndByOrder = new LinkedHashMap<>();
            for (ScheduleOperation op : scheduleOperationRepository.findByPlanVersionId(plan.getId())) {
                // 依赖 operationId 命名约定 "{orderCode}-{sequenceNo}"（建单时生成，见 OrderCommandService）：
                // 截掉最后一段序号得到 orderId；不改 schema 的前提下只能这样归属订单
                String orderId = op.getOperationId().contains("-")
                        ? op.getOperationId().substring(0, op.getOperationId().lastIndexOf('-'))
                        : op.getOperationId();
                ScheduleOperation existing = lastEndByOrder.get(orderId);
                if (existing == null || op.getEndAt().isAfter(existing.getEndAt())) {
                    lastEndByOrder.put(orderId, op);
                }
            }
            List<String> orderIds = new ArrayList<>(lastEndByOrder.keySet());
            Map<String, ProductionOrder> ordersById = new HashMap<>();
            productionOrderRepository.findAllById(orderIds).forEach(o -> ordersById.put(o.getId(), o));
            for (Map.Entry<String, ScheduleOperation> e : lastEndByOrder.entrySet()) {
                ProductionOrder order = ordersById.get(e.getKey());
                if (order != null && e.getValue().getEndAt().isAfter(order.getDueAt())
                        && !OrderStatus.COMPLETED.equals(order.getStatus())) {
                    delayedOrders.add(new DelayedOrderItem(order.getId(), order.getOrderCode(),
                            order.getDueAt(), e.getValue().getEndAt()));
                }
            }
        }

        List<DashboardBreakdownItem> breakdowns = new ArrayList<>();
        List<Event> breakdownEvents = range != null
                ? eventRepository.findByEventTypeAndOccurredAtGreaterThanEqualAndOccurredAtLessThanOrderByOccurredAtDesc(
                        Event.TYPE_BREAKDOWN, range[0], range[1], PageRequest.of(0, BREAKDOWN_LIMIT))
                : eventRepository.findByEventTypeOrderByOccurredAtDesc(
                        Event.TYPE_BREAKDOWN, PageRequest.of(0, BREAKDOWN_LIMIT));
        for (Event event : breakdownEvents) {
            breakdowns.add(new DashboardBreakdownItem(event.getEventCode(), event.getMachineId(),
                    event.getOccurredAt(), event.getRepairEndAt()));
        }

        List<ExecutionDeviationItem> executionDeviations = new ArrayList<>();
        List<ExecutionRecord> deviationRecords = range != null
                ? executionRecordRepository
                        .findTop20ByReasonCodeAndCreatedAtGreaterThanEqualAndCreatedAtLessThanOrderByCreatedAtDesc(
                                ExecutionService.REASON_EXECUTION_DEVIATION, range[0], range[1])
                : executionRecordRepository
                        .findTop20ByReasonCodeOrderByCreatedAtDesc(ExecutionService.REASON_EXECUTION_DEVIATION);
        for (ExecutionRecord record : deviationRecords) {
            executionDeviations.add(new ExecutionDeviationItem(record.getOperationId(),
                    record.getStatus(), record.getDeviationMinutes(), record.getActualStartAt(),
                    record.getActualEndAt(), record.getCreatedAt()));
        }

        List<DashboardTaskItem> infeasibleTasks = new ArrayList<>();
        for (ScheduleTask task : scheduleTaskRepository.findTop20ByStatusOrderByCreatedAtDesc(
                TaskStatus.INFEASIBLE.name())) {
            infeasibleTasks.add(taskEntry(task));
        }

        DashboardExceptions exceptions = new DashboardExceptions(delayedOrders, breakdowns,
                executionDeviations, infeasibleTasks,
                sortedExceptionItems(delayedOrders, breakdowns, executionDeviations, infeasibleTasks));
        return new DashboardResponse(currentPlan, appliedWindow, ordersCard, machines, recentEvents,
                recentTasks, exceptions);
    }

    /**
     * 统一异常列表（F-01）：延期订单 / 设备故障 / 不可行任务 / 执行偏差，
     * 按严重级别降序、同级别按时间倒序。数据错误（导入失败批次）本期暂不纳入。
     * 条目字段随类型而异构，保持 Map 结构（键名与各分类列表项一致）。
     */
    private List<Map<String, Object>> sortedExceptionItems(List<DelayedOrderItem> delayedOrders,
                                                           List<DashboardBreakdownItem> breakdowns,
                                                           List<ExecutionDeviationItem> executionDeviations,
                                                           List<DashboardTaskItem> infeasibleTasks) {
        List<Map<String, Object>> items = new ArrayList<>();
        for (DelayedOrderItem o : delayedOrders) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("orderId", o.orderId());
            item.put("orderCode", o.orderCode());
            item.put("dueAt", o.dueAt());
            item.put("plannedCompletionAt", o.plannedCompletionAt());
            item.put("type", "DELAYED_ORDER");
            item.put("severity", SEVERITY_MEDIUM);
            item.put("at", o.dueAt());
            items.add(item);
        }
        for (DashboardBreakdownItem b : breakdowns) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("eventCode", b.eventCode());
            item.put("machineId", b.machineId());
            item.put("occurredAt", b.occurredAt());
            item.put("repairEndAt", b.repairEndAt());
            item.put("type", Event.TYPE_BREAKDOWN);
            item.put("severity", SEVERITY_HIGH);
            item.put("at", b.occurredAt());
            items.add(item);
        }
        for (DashboardTaskItem t : infeasibleTasks) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("type", "INFEASIBLE_TASK");
            item.put("severity", SEVERITY_HIGH);
            item.put("at", t.createdAt());
            item.put("taskId", t.taskId());
            item.put("taskCode", t.taskCode());
            item.put("mode", t.mode());
            item.put("errorMessage", t.errorMessage());
            items.add(item);
        }
        for (ExecutionDeviationItem d : executionDeviations) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("operationId", d.operationId());
            item.put("status", d.status());
            item.put("deviationMinutes", d.deviationMinutes());
            item.put("actualStartAt", d.actualStartAt());
            item.put("actualEndAt", d.actualEndAt());
            item.put("createdAt", d.createdAt());
            item.put("type", "EXECUTION_DEVIATION");
            item.put("severity", SEVERITY_LOW);
            item.put("at", d.createdAt());
            items.add(item);
        }
        items.sort(Comparator
                .comparingInt((Map<String, Object> m) -> (Integer) m.get("severity")).reversed()
                .thenComparing(m -> (OffsetDateTime) m.get("at"),
                        Comparator.nullsLast(Comparator.reverseOrder())));
        return items;
    }

    private DashboardTaskItem taskEntry(ScheduleTask task) {
        return new DashboardTaskItem(task.getId(), task.getTaskCode(), task.getMode(), task.getStatus(),
                task.getProgress(), task.getElapsedMs(), task.getResultStatus(), task.getErrorMessage(),
                task.getPlanVersionId(), task.getCreatedAt(), task.getStartedAt(), task.getFinishedAt());
    }

    /**
     * 解析时间窗口；返回 null 表示不过滤。
     * SHIFT = 当前班次（Asia/Shanghai 8 小时班次），LAST_24H = [now-24h, now]，
     * CUSTOM 必须同时给出 from/to 且 from < to。
     */
    static OffsetDateTime[] resolveWindow(String window, String from, String to, OffsetDateTime now) {
        if (window == null || window.isBlank() || "ALL".equalsIgnoreCase(window.trim())) {
            return null;
        }
        switch (window.trim().toUpperCase()) {
            case "SHIFT":
                return shiftWindow(now);
            case "LAST_24H":
                return new OffsetDateTime[]{now.minusHours(24), now};
            case "CUSTOM": {
                if (from == null || from.isBlank() || to == null || to.isBlank()) {
                    throw BizException.validation("自定义时间窗口必须同时提供 from 和 to");
                }
                OffsetDateTime fromTs;
                OffsetDateTime toTs;
                try {
                    fromTs = OffsetDateTime.parse(from.trim());
                    toTs = OffsetDateTime.parse(to.trim());
                } catch (Exception e) {
                    throw BizException.validation("from/to 必须是 ISO 8601 时间（如 2026-10-08T00:00:00+08:00）");
                }
                if (!fromTs.isBefore(toTs)) {
                    throw BizException.validation("时间窗口起点必须早于终点");
                }
                return new OffsetDateTime[]{fromTs, toTs};
            }
            default:
                throw BizException.validation("不支持的时间窗口: " + window + "（可选 SHIFT / LAST_24H / CUSTOM）");
        }
    }

    /** 当前 8 小时班次窗口 [shiftStart, shiftStart+8h)，按 Asia/Shanghai 墙钟切分。 */
    static OffsetDateTime[] shiftWindow(OffsetDateTime now) {
        ZonedDateTime local = now.atZoneSameInstant(SHIFT_ZONE);
        ZonedDateTime start = local.toLocalDate()
                .atTime((local.getHour() / SHIFT_HOURS) * SHIFT_HOURS, 0)
                .atZone(SHIFT_ZONE);
        return new OffsetDateTime[]{start.toOffsetDateTime(), start.plusHours(SHIFT_HOURS).toOffsetDateTime()};
    }
}
