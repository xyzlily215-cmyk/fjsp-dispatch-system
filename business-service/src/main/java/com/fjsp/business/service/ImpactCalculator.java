package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

import com.fjsp.business.common.BizException;
import com.fjsp.business.common.LookupSupport;
import com.fjsp.business.config.FjspProperties;
import com.fjsp.business.dto.ImpactSummaryResponse;
import com.fjsp.business.dto.ReschedulePreviewResponse;
import com.fjsp.business.entity.Event;
import com.fjsp.business.entity.EventImpact;
import com.fjsp.business.entity.ExecutionRecord;
import com.fjsp.business.entity.OrderOperation;
import com.fjsp.business.entity.PlanVersion;
import com.fjsp.business.entity.ScheduleOperation;
import com.fjsp.business.repository.EventImpactRepository;
import com.fjsp.business.repository.ExecutionRecordRepository;
import com.fjsp.business.repository.OrderOperationRepository;
import com.fjsp.business.repository.PlanVersionRepository;
import com.fjsp.business.repository.ScheduleOperationRepository;
import org.springframework.stereotype.Service;

@Service
public class ImpactCalculator {

    public static final String NEW_ORDER = "NEW_ORDER";
    public static final String MACHINE_BREAKDOWN = "MACHINE_BREAKDOWN";
    public static final String SUCCESSOR = "SUCCESSOR";
    public static final String SAME_MACHINE_CONFLICT = "SAME_MACHINE_CONFLICT";
    public static final String CALENDAR_CONFLICT = "CALENDAR_CONFLICT";

    private final ScheduleOperationRepository scheduleOperationRepository;
    private final OrderOperationRepository orderOperationRepository;
    private final ExecutionRecordRepository executionRecordRepository;
    private final PlanVersionRepository planVersionRepository;
    private final EventImpactRepository eventImpactRepository;
    private final FjspProperties properties;

    public ImpactCalculator(ScheduleOperationRepository scheduleOperationRepository,
                            OrderOperationRepository orderOperationRepository,
                            ExecutionRecordRepository executionRecordRepository,
                            PlanVersionRepository planVersionRepository,
                            EventImpactRepository eventImpactRepository,
                            FjspProperties properties) {
        this.scheduleOperationRepository = scheduleOperationRepository;
        this.orderOperationRepository = orderOperationRepository;
        this.executionRecordRepository = executionRecordRepository;
        this.planVersionRepository = planVersionRepository;
        this.eventImpactRepository = eventImpactRepository;
        this.properties = properties;
    }

    public PlanVersion currentPublishedPlan() {
        return planVersionRepository.findByStatusIn(List.of("PUBLISHED", "EXECUTING")).stream()
                .max((a, b) -> a.getPublishedAt() != null && b.getPublishedAt() != null
                        ? a.getPublishedAt().compareTo(b.getPublishedAt()) : 0)
                .orElse(null);
    }

    public void recordNewOrderImpacts(Event event, String orderId) {
        for (OrderOperation op : orderOperationRepository.findByOrderIdOrderBySequenceNo(orderId)) {
            EventImpact impact = base(event, op.getId(), NEW_ORDER, "新订单的全部工序进入重调度范围");
            impact.setLockType("ADJUSTABLE");
            impact.setReasonCode("NEW_OPERATION");
            eventImpactRepository.save(impact);
        }
    }

    public List<EventImpact> computeBreakdownImpacts(Event event) {
        List<EventImpact> impacts = new ArrayList<>();
        PlanVersion published = currentPublishedPlan();
        if (published == null) {
            return impacts;
        }
        OffsetDateTime occurredAt = event.getOccurredAt();
        OffsetDateTime repairEnd = event.getRepairEndAt();
        OffsetDateTime freezeEnd = occurredAt.plus(properties.getFreezeWindow());

        List<ScheduleOperation> planOps = scheduleOperationRepository.findByPlanVersionId(published.getId());
        Map<String, ScheduleOperation> byOpId = new LinkedHashMap<>();
        for (ScheduleOperation op : planOps) {
            byOpId.put(op.getOperationId(), op);
        }
        // 一次性拉回计划全部工序的执行记录，内存分组，替代逐工序 exists/findFirst 的 N+1
        List<String> planOpIds = planOps.stream().map(ScheduleOperation::getOperationId).toList();
        Map<String, List<ExecutionRecord>> recordsByOp = planOpIds.isEmpty() ? Map.of()
                : executionRecordRepository.findByOperationIdIn(planOpIds).stream()
                        .collect(Collectors.groupingBy(ExecutionRecord::getOperationId));

        // set 2/4/5: unfinished ops on the broken machine, split by repair-window overlap
        Map<String, EventImpact> impacted = new LinkedHashMap<>();
        for (ScheduleOperation op : planOps) {
            if (!op.getMachineId().equals(event.getMachineId())) {
                continue;
            }
            if (hasCompleted(recordsByOp.get(op.getOperationId()))) {
                continue;
            }
            boolean overlapsRepair = op.getStartAt().isBefore(repairEnd) && op.getEndAt().isAfter(occurredAt);
            EventImpact impact;
            if (overlapsRepair) {
                impact = base(event, op.getOperationId(), SAME_MACHINE_CONFLICT,
                        "计划区间与维修区间 [" + occurredAt + ", " + repairEnd + ") 冲突");
                impact.setReasonCode("BREAKDOWN_OVERLAP");
                // 与维修区间重叠的工序必须重排，不能因为冻结窗口被硬锁定
                boolean running = hasRunning(recordsByOp.get(op.getOperationId()));
                impact.setLockType(running ? "HARD_LOCKED" : "ADJUSTABLE");
            } else if (!op.getEndAt().isBefore(occurredAt)) {
                impact = base(event, op.getOperationId(), MACHINE_BREAKDOWN,
                        "故障设备上的未完成工序");
                impact.setReasonCode("MACHINE_DOWN");
                impact.setLockType(lockTypeOf(op, occurredAt, freezeEnd, recordsByOp));
            } else {
                continue;
            }
            impacted.put(op.getOperationId(), impact);
        }

        // set 3: all successors of impacted ops within the same order
        Map<String, List<OrderOperation>> opsByOrder = new LinkedHashMap<>();
        for (String opId : new ArrayList<>(impacted.keySet())) {
            OrderOperation oo = orderOperationRepository.findById(opId).orElse(null);
            if (oo == null) {
                continue;
            }
            List<OrderOperation> orderOps = opsByOrder.computeIfAbsent(oo.getOrderId(),
                    orderOperationRepository::findByOrderIdOrderBySequenceNo);
            for (OrderOperation successor : orderOps) {
                if (successor.getSequenceNo() <= oo.getSequenceNo() || impacted.containsKey(successor.getId())) {
                    continue;
                }
                ScheduleOperation planned = byOpId.get(successor.getId());
                EventImpact impact = base(event, successor.getId(), SUCCESSOR,
                        "受影响工序 " + opId + " 的后继工序");
                impact.setReasonCode("SUCCESSOR_OF_AFFECTED");
                impact.setLockType(planned != null ? lockTypeOf(planned, occurredAt, freezeEnd, recordsByOp)
                        : "ADJUSTABLE");
                impacted.put(successor.getId(), impact);
            }
        }

        for (EventImpact impact : impacted.values()) {
            eventImpactRepository.save(impact);
            impacts.add(impact);
        }
        return impacts;
    }

    private String lockTypeOf(ScheduleOperation op, OffsetDateTime occurredAt, OffsetDateTime freezeEnd,
                              Map<String, List<ExecutionRecord>> recordsByOp) {
        List<ExecutionRecord> records = recordsByOp.get(op.getOperationId());
        if (hasCompleted(records) || hasRunning(records)) {
            return "HARD_LOCKED";
        }
        if (!op.getStartAt().isBefore(occurredAt) && op.getStartAt().isBefore(freezeEnd)) {
            return "HARD_LOCKED";
        }
        return "ADJUSTABLE";
    }

    private static boolean hasCompleted(List<ExecutionRecord> records) {
        return records != null && records.stream().anyMatch(r -> "COMPLETED".equals(r.getStatus()));
    }

    private static boolean hasRunning(List<ExecutionRecord> records) {
        return records != null && records.stream()
                .anyMatch(r -> "RUNNING".equals(r.getStatus()) && r.getActualEndAt() == null);
    }

    public List<ExecutionRecord> runningExecutions() {
        return executionRecordRepository.findByStatusAndActualEndAtIsNull("RUNNING");
    }

    private EventImpact base(Event event, String operationId, String type, String reason) {
        EventImpact impact = new EventImpact();
        impact.setId(UUID.randomUUID().toString());
        impact.setEventId(event.getId());
        impact.setOperationId(operationId);
        impact.setImpactType(type);
        impact.setImpactReason(reason);
        return impact;
    }

    public ImpactSummaryResponse summarize(List<EventImpact> impacts) {
        Map<String, Long> byType = new LinkedHashMap<>();
        for (EventImpact impact : impacts) {
            byType.merge(impact.getImpactType(), 1L, Long::sum);
        }
        return new ImpactSummaryResponse(impacts.size(), byType);
    }

    /**
     * 重调度影响范围预览（F-08 向导第三步）：基于原计划版本与事件已落库的影响记录，
     * 按 SnapshotBuilder 实际生成求解输入的口径重算锁定分类
     * （已完成/加工中/冻结窗口内且未受影响 = 硬锁定，其余非影响工序 = 软锁定），
     * 并估算局部/完全两种模式的求解规模。冻结窗口可用 freezeWindowMinutes 覆盖默认值。
     */
    public ReschedulePreviewResponse reschedulePreview(Event event, String planVersionIdOrCode,
                                                       Integer freezeWindowMinutes) {
        PlanVersion plan = planVersionIdOrCode != null && !planVersionIdOrCode.isBlank()
                ? LookupSupport.byIdOrCode(planVersionIdOrCode, planVersionRepository::findById,
                        planVersionRepository::findByVersionCode, "计划版本不存在")
                : currentPublishedPlan();
        if (plan == null) {
            throw BizException.stateConflict("当前没有已发布的计划版本，无法进行影响范围预览");
        }
        int freezeMinutes = freezeWindowMinutes != null
                ? freezeWindowMinutes : (int) properties.getFreezeWindow().toMinutes();
        if (freezeMinutes < 0 || freezeMinutes > 1440) {
            throw BizException.validation("freezeWindowMinutes 必须在 0-1440 之间");
        }

        List<EventImpact> impacts = eventImpactRepository.findByEventId(event.getId());
        Set<String> impactedIds = impacts.stream().map(EventImpact::getOperationId)
                .collect(Collectors.toCollection(LinkedHashSet::new));

        OffsetDateTime freezeStart = event.getOccurredAt();
        OffsetDateTime freezeEnd = freezeStart.plusMinutes(freezeMinutes);

        List<ScheduleOperation> planOps = scheduleOperationRepository.findByPlanVersionId(plan.getId());
        List<String> planOpIds = planOps.stream().map(ScheduleOperation::getOperationId).toList();
        Map<String, List<ExecutionRecord>> recordsByOp = planOpIds.isEmpty() ? Map.of()
                : executionRecordRepository.findByOperationIdIn(planOpIds).stream()
                        .collect(Collectors.groupingBy(ExecutionRecord::getOperationId));

        int hardLocked = 0;
        int softLocked = 0;
        int localAdjustable = 0;
        Set<String> planOpIdSet = planOps.stream().map(ScheduleOperation::getOperationId)
                .collect(Collectors.toSet());
        for (ScheduleOperation op : planOps) {
            List<ExecutionRecord> records = recordsByOp.get(op.getOperationId());
            boolean affected = impactedIds.contains(op.getOperationId());
            boolean hard = hasCompleted(records) || hasRunning(records)
                    || (!affected && !op.getStartAt().isBefore(freezeStart)
                            && op.getStartAt().isBefore(freezeEnd));
            if (hard) {
                hardLocked++;
            } else if (affected) {
                localAdjustable++;
            } else {
                softLocked++;
            }
        }
        // 影响集合中不在原计划内的工序（新订单工序）一律未开始，两种模式都要排
        int external = (int) impactedIds.stream().filter(id -> !planOpIdSet.contains(id)).count();
        int localEstimate = localAdjustable + external;
        int fullEstimate = localAdjustable + softLocked + external;

        List<String> impactedOrders = impactedIds.isEmpty() ? List.of()
                : orderOperationRepository.findAllById(impactedIds).stream()
                        .map(OrderOperation::getOrderId).distinct().sorted().toList();

        Map<String, ReschedulePreviewResponse.ModeEstimate> modes = new LinkedHashMap<>();
        modes.put("LOCAL_RESCHEDULE", new ReschedulePreviewResponse.ModeEstimate(localEstimate));
        modes.put("FULL_RESCHEDULE", new ReschedulePreviewResponse.ModeEstimate(fullEstimate));

        return new ReschedulePreviewResponse(event.getId(), event.getEventCode(), event.getEventType(),
                event.getOccurredAt(), plan.getId(), plan.getVersionCode(), freezeMinutes,
                hardLocked, softLocked, impactedIds.size(), impactedOrders.size(), impactedOrders,
                summarize(impacts), modes);
    }
}
