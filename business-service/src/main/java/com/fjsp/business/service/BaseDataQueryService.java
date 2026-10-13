package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.fjsp.business.common.LookupSupport;
import com.fjsp.business.dto.MachineResponse;
import com.fjsp.business.dto.OrderListItemResponse;
import com.fjsp.business.dto.OrderOperationItem;
import com.fjsp.business.dto.OrderPositionResponse;
import com.fjsp.business.dto.ProcessTemplateResponse;
import com.fjsp.business.entity.ExecutionRecord;
import com.fjsp.business.entity.ExecutionStatus;
import com.fjsp.business.entity.Machine;
import com.fjsp.business.entity.OperationStatus;
import com.fjsp.business.entity.OrderOperation;
import com.fjsp.business.entity.OrderStatus;
import com.fjsp.business.entity.PlanVersion;
import com.fjsp.business.entity.ProcessOperation;
import com.fjsp.business.entity.ProcessTemplate;
import com.fjsp.business.entity.ProductionOrder;
import com.fjsp.business.entity.ScheduleOperation;
import com.fjsp.business.repository.ExecutionRecordRepository;
import com.fjsp.business.repository.MachineRepository;
import com.fjsp.business.repository.OrderOperationRepository;
import com.fjsp.business.repository.ProcessOperationRepository;
import com.fjsp.business.repository.ProcessTemplateRepository;
import com.fjsp.business.repository.ProductionOrderRepository;
import com.fjsp.business.repository.ScheduleOperationRepository;
import org.springframework.stereotype.Service;

/** 基础数据查询聚合：设备列表、订单列表（含工序与 scheduled 标记）、工艺模板列表。 */
@Service
public class BaseDataQueryService {

    private final MachineRepository machineRepository;
    private final ProductionOrderRepository productionOrderRepository;
    private final OrderOperationRepository orderOperationRepository;
    private final ProcessTemplateRepository processTemplateRepository;
    private final ProcessOperationRepository processOperationRepository;
    private final ScheduleOperationRepository scheduleOperationRepository;
    private final ExecutionRecordRepository executionRecordRepository;
    private final ImpactCalculator impactCalculator;

    public BaseDataQueryService(MachineRepository machineRepository,
                                ProductionOrderRepository productionOrderRepository,
                                OrderOperationRepository orderOperationRepository,
                                ProcessTemplateRepository processTemplateRepository,
                                ProcessOperationRepository processOperationRepository,
                                ScheduleOperationRepository scheduleOperationRepository,
                                ExecutionRecordRepository executionRecordRepository,
                                ImpactCalculator impactCalculator) {
        this.machineRepository = machineRepository;
        this.productionOrderRepository = productionOrderRepository;
        this.orderOperationRepository = orderOperationRepository;
        this.processTemplateRepository = processTemplateRepository;
        this.processOperationRepository = processOperationRepository;
        this.scheduleOperationRepository = scheduleOperationRepository;
        this.executionRecordRepository = executionRecordRepository;
        this.impactCalculator = impactCalculator;
    }

    public List<MachineResponse> listMachines() {
        List<MachineResponse> result = new ArrayList<>();
        for (Machine machine : machineRepository.findAll()) {
            result.add(new MachineResponse(machine.getId(), machine.getMachineCode(),
                    machine.getMachineName(), machine.getWorkCenterId(), machine.getCalendarId(),
                    machine.getProductFamilies(), machine.getStatus(), machine.getRemark()));
        }
        result.sort(Comparator.comparing(MachineResponse::machineId));
        return result;
    }

    public List<OrderListItemResponse> listOrders() {
        List<ProductionOrder> orders = productionOrderRepository.findAll();
        // 批量取回全部工序后按订单分组，避免每单一次查询（N+1）
        List<String> orderIds = orders.stream().map(ProductionOrder::getId).toList();
        Map<String, List<OrderOperation>> opsByOrder = new LinkedHashMap<>();
        for (OrderOperation op : orderOperationRepository.findByOrderIdIn(orderIds)) {
            opsByOrder.computeIfAbsent(op.getOrderId(), k -> new ArrayList<>()).add(op);
        }
        opsByOrder.values().forEach(list -> list.sort(Comparator.comparing(OrderOperation::getSequenceNo)));
        // 已排程订单集合（工序已进入任一计划版本）：前端据此走修订流程而非直接编辑
        Set<String> scheduledOrderIds = new HashSet<>(scheduleOperationRepository.findScheduledOrderIds());

        List<OrderListItemResponse> result = new ArrayList<>();
        for (ProductionOrder order : orders) {
            boolean scheduled = !OrderStatus.WAITING.equals(order.getStatus())
                    || scheduledOrderIds.contains(order.getId());
            List<OrderOperationItem> ops = new ArrayList<>();
            for (OrderOperation op : opsByOrder.getOrDefault(order.getId(), List.of())) {
                ops.add(new OrderOperationItem(op.getId(), op.getSequenceNo(), op.getStatus(),
                        op.getCandidates()));
            }
            result.add(new OrderListItemResponse(order.getId(), order.getOrderCode(),
                    order.getProductFamily(), order.getQuantity(), order.getArrivalAt(), order.getDueAt(),
                    order.getPriority(), order.getStatus(), order.getTemplateId(), order.getRemark(),
                    order.getRevisionNo(), scheduled, ops));
        }
        result.sort(Comparator.comparing(OrderListItemResponse::orderId));
        return result;
    }

    /**
     * 订单加工位置聚合（orderRef 支持订单 id 或 orderCode）：工序进度计数 +
     * 当前 RUNNING/PAUSED 工序与下一道 NOT_STARTED 工序（计划设备与时间取自当前已发布计划版本）。
     * 无已发布计划时计划相关字段为 null，planPublished=false。
     */
    public OrderPositionResponse orderPosition(String orderRef) {
        ProductionOrder order = LookupSupport.byIdOrCode(orderRef, productionOrderRepository::findById,
                productionOrderRepository::findByOrderCode, "订单不存在");
        List<OrderOperation> ops = orderOperationRepository.findByOrderIdOrderBySequenceNo(order.getId());

        PlanVersion plan = impactCalculator.currentPublishedPlan();
        Map<String, ScheduleOperation> scheduledByOp = new LinkedHashMap<>();
        if (plan != null) {
            for (ScheduleOperation so : scheduleOperationRepository.findByPlanVersionId(plan.getId())) {
                scheduledByOp.put(so.getOperationId(), so);
            }
        }

        OrderOperation current = null;
        OrderOperation next = null;
        int completed = 0;
        List<OrderPositionResponse.OperationItem> items = new ArrayList<>();
        for (OrderOperation op : ops) {
            if (OperationStatus.COMPLETED.equals(op.getStatus())) {
                completed++;
            } else if (OperationStatus.RUNNING.equals(op.getStatus())
                    || OperationStatus.PAUSED.equals(op.getStatus())) {
                if (current == null) {
                    current = op;
                }
            } else if (next == null) {
                next = op;
            }
            ScheduleOperation scheduled = scheduledByOp.get(op.getId());
            items.add(operationItem(op, scheduled, null));
        }

        OrderPositionResponse.OperationItem currentItem = null;
        if (current != null) {
            // 当前工序的实际开工时间：取该工序未闭合的 RUNNING 执行记录，取不到则为 null
            var openRunning = executionRecordRepository
                    .findFirstByOperationIdAndStatusAndActualEndAtIsNull(current.getId(), ExecutionStatus.RUNNING);
            currentItem = operationItem(current, scheduledByOp.get(current.getId()),
                    openRunning.map(ExecutionRecord::getActualStartAt).orElse(null));
        }
        OrderPositionResponse.OperationItem nextItem = next == null ? null
                : operationItem(next, scheduledByOp.get(next.getId()), null);

        int total = ops.size();
        int remaining = total - completed;
        int progressPercent = total == 0 ? 0 : (int) Math.round(completed * 100.0 / total);
        return new OrderPositionResponse(order.getId(), order.getOrderCode(), order.getProductFamily(),
                order.getQuantity(), order.getPriority(), order.getStatus(), plan != null,
                plan == null ? null : plan.getId(), total, completed, remaining, progressPercent,
                currentItem, nextItem, items);
    }

    private OrderPositionResponse.OperationItem operationItem(OrderOperation op, ScheduleOperation scheduled,
                                                              OffsetDateTime actualStartAt) {
        return new OrderPositionResponse.OperationItem(op.getId(), op.getSequenceNo(), op.getStatus(),
                scheduled == null ? null : scheduled.getMachineId(),
                scheduled == null ? null : scheduled.getStartAt(),
                scheduled == null ? null : scheduled.getEndAt(),
                actualStartAt);
    }

    public List<ProcessTemplateResponse> listProcessTemplates() {
        List<ProcessTemplateResponse> result = new ArrayList<>();
        for (ProcessTemplate template : processTemplateRepository.findAll()) {
            result.add(new ProcessTemplateResponse(template.getId(), template.getTemplateCode(),
                    template.getProductFamily(), template.getTemplateVersion(), template.getStatus(),
                    templateOperations(template.getId())));
        }
        result.sort(Comparator.comparing(ProcessTemplateResponse::templateCode));
        return result;
    }

    private List<ProcessTemplateResponse.TemplateOperationItem> templateOperations(String templateId) {
        List<ProcessTemplateResponse.TemplateOperationItem> ops = new ArrayList<>();
        for (ProcessOperation po : processOperationRepository.findByTemplateIdOrderBySequenceNo(templateId)) {
            ops.add(new ProcessTemplateResponse.TemplateOperationItem(po.getSequenceNo(),
                    po.getOperationCode(), po.getDefaultCandidates()));
        }
        return ops;
    }
}
