package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fjsp.business.config.FjspProperties;
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
        OffsetDateTime freezeEnd = occurredAt.plusMinutes(properties.getFreezeWindowMinutes());

        List<ScheduleOperation> planOps = scheduleOperationRepository.findByPlanVersionId(published.getId());
        Map<String, ScheduleOperation> byOpId = new LinkedHashMap<>();
        for (ScheduleOperation op : planOps) {
            byOpId.put(op.getOperationId(), op);
        }

        // set 2/4/5: unfinished ops on the broken machine, split by repair-window overlap
        Map<String, EventImpact> impacted = new LinkedHashMap<>();
        for (ScheduleOperation op : planOps) {
            if (!op.getMachineId().equals(event.getMachineId())) {
                continue;
            }
            if (executionRecordRepository.existsByOperationIdAndStatus(op.getOperationId(), "COMPLETED")) {
                continue;
            }
            boolean overlapsRepair = op.getStartAt().isBefore(repairEnd) && op.getEndAt().isAfter(occurredAt);
            EventImpact impact;
            if (overlapsRepair) {
                impact = base(event, op.getOperationId(), SAME_MACHINE_CONFLICT,
                        "计划区间与维修区间 [" + occurredAt + ", " + repairEnd + ") 冲突");
                impact.setReasonCode("BREAKDOWN_OVERLAP");
                // 与维修区间重叠的工序必须重排，不能因为冻结窗口被硬锁定
                boolean running = executionRecordRepository
                        .findFirstByOperationIdAndStatusAndActualEndAtIsNull(op.getOperationId(), "RUNNING")
                        .isPresent();
                impact.setLockType(running ? "HARD_LOCKED" : "ADJUSTABLE");
            } else if (!op.getEndAt().isBefore(occurredAt)) {
                impact = base(event, op.getOperationId(), MACHINE_BREAKDOWN,
                        "故障设备上的未完成工序");
                impact.setReasonCode("MACHINE_DOWN");
                impact.setLockType(lockTypeOf(op, occurredAt, freezeEnd));
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
                impact.setLockType(planned != null ? lockTypeOf(planned, occurredAt, freezeEnd) : "ADJUSTABLE");
                impacted.put(successor.getId(), impact);
            }
        }

        for (EventImpact impact : impacted.values()) {
            eventImpactRepository.save(impact);
            impacts.add(impact);
        }
        return impacts;
    }

    private String lockTypeOf(ScheduleOperation op, OffsetDateTime occurredAt, OffsetDateTime freezeEnd) {
        String opId = op.getOperationId();
        if (executionRecordRepository.existsByOperationIdAndStatus(opId, "COMPLETED")) {
            return "HARD_LOCKED";
        }
        var running = executionRecordRepository
                .findFirstByOperationIdAndStatusAndActualEndAtIsNull(opId, "RUNNING");
        if (running.isPresent()) {
            return "HARD_LOCKED";
        }
        if (!op.getStartAt().isBefore(occurredAt) && op.getStartAt().isBefore(freezeEnd)) {
            return "HARD_LOCKED";
        }
        return "ADJUSTABLE";
    }

    public List<ExecutionRecord> runningExecutions() {
        return executionRecordRepository.findAll().stream()
                .filter(r -> "RUNNING".equals(r.getStatus()) && r.getActualEndAt() == null)
                .toList();
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

    public Map<String, Object> summarize(List<EventImpact> impacts) {
        Map<String, Long> byType = new LinkedHashMap<>();
        for (EventImpact impact : impacts) {
            byType.merge(impact.getImpactType(), 1L, Long::sum);
        }
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("total", impacts.size());
        summary.put("byType", byType);
        return summary;
    }
}
