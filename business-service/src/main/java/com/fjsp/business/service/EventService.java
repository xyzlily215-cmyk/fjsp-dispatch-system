package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fjsp.business.common.BizException;
import com.fjsp.business.common.HashUtil;
import com.fjsp.business.dto.BreakdownEventRequest;
import com.fjsp.business.dto.NewOrderEventRequest;
import com.fjsp.business.entity.Event;
import com.fjsp.business.entity.EventImpact;
import com.fjsp.business.entity.OrderOperation;
import com.fjsp.business.entity.PlanVersion;
import com.fjsp.business.entity.ProcessOperation;
import com.fjsp.business.entity.ProcessTemplate;
import com.fjsp.business.entity.ProductionOrder;
import com.fjsp.business.entity.ScheduleOperation;
import com.fjsp.business.repository.EventImpactRepository;
import com.fjsp.business.repository.EventRepository;
import com.fjsp.business.repository.MachineRepository;
import com.fjsp.business.repository.OrderOperationRepository;
import com.fjsp.business.repository.ProcessOperationRepository;
import com.fjsp.business.repository.ProcessTemplateRepository;
import com.fjsp.business.repository.ProductionOrderRepository;
import com.fjsp.business.repository.ScheduleOperationRepository;
import com.fjsp.business.repository.ScheduleTaskRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class EventService {

    private static final List<String> NEW_ORDER_SUBTYPES = List.of("URGENT_INSERT", "NORMAL_APPEND");

    private final EventRepository eventRepository;
    private final EventImpactRepository eventImpactRepository;
    private final ProductionOrderRepository productionOrderRepository;
    private final OrderOperationRepository orderOperationRepository;
    private final ProcessTemplateRepository processTemplateRepository;
    private final ProcessOperationRepository processOperationRepository;
    private final MachineRepository machineRepository;
    private final ScheduleOperationRepository scheduleOperationRepository;
    private final ScheduleTaskRepository scheduleTaskRepository;
    private final ImpactCalculator impactCalculator;
    private final CodeGenerator codeGenerator;
    private final AuditService auditService;
    private final IdempotencyService idempotencyService;

    public EventService(EventRepository eventRepository,
                        EventImpactRepository eventImpactRepository,
                        ProductionOrderRepository productionOrderRepository,
                        OrderOperationRepository orderOperationRepository,
                        ProcessTemplateRepository processTemplateRepository,
                        ProcessOperationRepository processOperationRepository,
                        MachineRepository machineRepository,
                        ScheduleOperationRepository scheduleOperationRepository,
                        ScheduleTaskRepository scheduleTaskRepository,
                        ImpactCalculator impactCalculator,
                        CodeGenerator codeGenerator,
                        AuditService auditService,
                        IdempotencyService idempotencyService) {
        this.eventRepository = eventRepository;
        this.eventImpactRepository = eventImpactRepository;
        this.productionOrderRepository = productionOrderRepository;
        this.orderOperationRepository = orderOperationRepository;
        this.processTemplateRepository = processTemplateRepository;
        this.processOperationRepository = processOperationRepository;
        this.machineRepository = machineRepository;
        this.scheduleOperationRepository = scheduleOperationRepository;
        this.scheduleTaskRepository = scheduleTaskRepository;
        this.impactCalculator = impactCalculator;
        this.codeGenerator = codeGenerator;
        this.auditService = auditService;
        this.idempotencyService = idempotencyService;
    }

    @Transactional
    public Map<String, Object> createNewOrderEvent(String idempotencyKey, NewOrderEventRequest req) {
        var replay = idempotencyService.findReplay(idempotencyKey, req);
        if (replay.isPresent()) {
            @SuppressWarnings("unchecked")
            Map<String, Object> stored = (Map<String, Object>) replay.get();
            return stored;
        }
        if (req == null || req.subType() == null || !NEW_ORDER_SUBTYPES.contains(req.subType())) {
            throw BizException.validation("subType 必须是 URGENT_INSERT / NORMAL_APPEND");
        }
        if (req.productFamily() == null || req.quantity() == null || req.quantity() <= 0
                || req.dueAt() == null || req.priority() == null) {
            throw BizException.validation("productFamily/quantity/dueAt/priority 必填且 quantity>0");
        }
        if (req.priority() < 1 || req.priority() > 5) {
            throw BizException.validation("priority 必须在 1-5 之间");
        }
        String orderCode = req.orderCode();
        if (orderCode == null || orderCode.isBlank()) {
            orderCode = "ORD-" + OffsetDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd"))
                    + "-" + UUID.randomUUID().toString().substring(0, 6).toUpperCase();
        }
        if (productionOrderRepository.existsByOrderCode(orderCode)) {
            throw BizException.duplicate("同车间订单号重复: " + orderCode);
        }
        ProcessTemplate template = processTemplateRepository
                .findFirstByProductFamilyAndStatusOrderByTemplateVersionDesc(req.productFamily(), "ACTIVE")
                .orElseThrow(() -> BizException.validation("产品族无可用工艺模板: " + req.productFamily()));
        List<ProcessOperation> templateOps = processOperationRepository
                .findByTemplateIdOrderBySequenceNo(template.getId());
        if (templateOps.isEmpty()) {
            throw BizException.validation("工艺模板没有工序定义: " + template.getTemplateCode());
        }

        OffsetDateTime occurredAt = req.occurredAt() != null
                ? OffsetDateTime.parse(req.occurredAt()) : OffsetDateTime.now();
        OffsetDateTime arrivalAt = req.arrivalAt() != null
                ? OffsetDateTime.parse(req.arrivalAt()) : occurredAt;
        OffsetDateTime dueAt = OffsetDateTime.parse(req.dueAt());
        if (!dueAt.isAfter(arrivalAt)) {
            throw BizException.validation("dueAt 必须晚于 arrivalAt");
        }

        ProductionOrder order = new ProductionOrder();
        order.setId(orderCode);
        order.setOrderCode(orderCode);
        order.setProductFamily(req.productFamily());
        order.setQuantity(req.quantity());
        order.setArrivalAt(arrivalAt);
        order.setDueAt(dueAt);
        order.setPriority(req.priority());
        order.setStatus("WAITING");
        order.setTemplateId(template.getId());
        productionOrderRepository.save(order);

        List<String> operationIds = new ArrayList<>();
        for (ProcessOperation po : templateOps) {
            OrderOperation oo = new OrderOperation();
            oo.setId(orderCode + "-" + po.getSequenceNo());
            oo.setOrderId(order.getId());
            oo.setSequenceNo(po.getSequenceNo());
            oo.setStatus("NOT_STARTED");
            oo.setCandidates(po.getDefaultCandidates());
            orderOperationRepository.save(oo);
            operationIds.add(oo.getId());
        }

        Event event = new Event();
        event.setId(UUID.randomUUID().toString());
        event.setEventCode(codeGenerator.next("EVT", eventRepository.findMaxEventCode()));
        event.setEventType(Event.TYPE_NEW_ORDER);
        event.setSubType(req.subType());
        event.setOrderId(order.getId());
        event.setOccurredAt(occurredAt);
        event.setNote(req.note());
        event.setStatus("CONFIRMED");
        event.setFingerprint(HashUtil.sha256("NEW_ORDER|" + orderCode + "|" + occurredAt));
        eventRepository.save(event);

        impactCalculator.recordNewOrderImpacts(event, order.getId());
        auditService.record("EVENT_NEW_ORDER", "event", event.getId(),
                "orderCode=" + orderCode + ", subType=" + req.subType());

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("eventId", event.getId());
        data.put("eventCode", event.getEventCode());
        data.put("orderId", order.getId());
        data.put("orderCode", order.getOrderCode());
        data.put("operationIds", operationIds);
        data.put("impactSummary", impactCalculator.summarize(eventImpactRepository.findByEventId(event.getId())));
        idempotencyService.store(idempotencyKey, req, data);
        return data;
    }

    @Transactional
    public Map<String, Object> createBreakdownEvent(String idempotencyKey, BreakdownEventRequest req) {
        var replay = idempotencyService.findReplay(idempotencyKey, req);
        if (replay.isPresent()) {
            @SuppressWarnings("unchecked")
            Map<String, Object> stored = (Map<String, Object>) replay.get();
            return stored;
        }
        if (req == null || req.machineId() == null || req.occurredAt() == null
                || req.repairDurationMinutes() == null || req.repairDurationMinutes() <= 0) {
            throw BizException.validation("machineId/occurredAt/repairDurationMinutes 必填且 repairDurationMinutes>0");
        }
        machineRepository.findById(req.machineId())
                .orElseThrow(() -> BizException.notFound("设备不存在: " + req.machineId()));
        OffsetDateTime occurredAt = OffsetDateTime.parse(req.occurredAt());
        OffsetDateTime repairEndAt = occurredAt.plusMinutes(req.repairDurationMinutes());

        PlanVersion published = impactCalculator.currentPublishedPlan();
        if (published != null) {
            for (var running : impactCalculator.runningExecutions()) {
                ScheduleOperation planned = scheduleOperationRepository
                        .findByPlanVersionIdAndOperationId(published.getId(), running.getOperationId())
                        .orElse(null);
                if (planned != null && planned.getMachineId().equals(req.machineId())
                        && !occurredAt.isBefore(planned.getStartAt())
                        && occurredAt.isBefore(planned.getEndAt())) {
                    throw BizException.eventInProcess(
                            "故障时间落在执行中工序 " + planned.getOperationId() + " 的计划区间内，不允许登记");
                }
            }
        }

        Event event = new Event();
        event.setId(UUID.randomUUID().toString());
        event.setEventCode(codeGenerator.next("EVT", eventRepository.findMaxEventCode()));
        event.setEventType(Event.TYPE_BREAKDOWN);
        event.setMachineId(req.machineId());
        event.setOccurredAt(occurredAt);
        event.setRepairDurationMinutes(req.repairDurationMinutes());
        event.setRepairEndAt(repairEndAt);
        event.setSource(req.source());
        event.setNote(req.note());
        event.setStatus("CONFIRMED");
        event.setFingerprint(HashUtil.sha256(
                "BREAKDOWN|" + req.machineId() + "|" + occurredAt + "|" + req.repairDurationMinutes()));
        eventRepository.save(event);

        List<EventImpact> impacts = impactCalculator.computeBreakdownImpacts(event);
        auditService.record("EVENT_BREAKDOWN", "event", event.getId(),
                "machine=" + req.machineId() + ", repairMinutes=" + req.repairDurationMinutes());

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("eventId", event.getId());
        data.put("eventCode", event.getEventCode());
        data.put("machineId", req.machineId());
        data.put("occurredAt", occurredAt);
        data.put("repairEndAt", repairEndAt);
        data.put("impactSummary", impactCalculator.summarize(impacts));
        idempotencyService.store(idempotencyKey, req, data);
        return data;
    }

    public Map<String, Object> getEvent(String eventIdOrCode) {
        Event event = eventRepository.findById(eventIdOrCode)
                .or(() -> eventRepository.findByEventCode(eventIdOrCode))
                .orElseThrow(() -> BizException.notFound("事件不存在: " + eventIdOrCode));
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("eventId", event.getId());
        data.put("eventCode", event.getEventCode());
        data.put("eventType", event.getEventType());
        data.put("subType", event.getSubType());
        data.put("machineId", event.getMachineId());
        data.put("orderId", event.getOrderId());
        data.put("occurredAt", event.getOccurredAt());
        data.put("recordedAt", event.getRecordedAt());
        data.put("repairDurationMinutes", event.getRepairDurationMinutes());
        data.put("repairEndAt", event.getRepairEndAt());
        data.put("source", event.getSource());
        data.put("note", event.getNote());
        data.put("status", event.getStatus());
        data.put("revisionOf", event.getRevisionOf());

        List<Map<String, Object>> impacts = new ArrayList<>();
        for (EventImpact impact : eventImpactRepository.findByEventId(event.getId())) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("operationId", impact.getOperationId());
            entry.put("impactType", impact.getImpactType());
            entry.put("impactReason", impact.getImpactReason());
            entry.put("lockType", impact.getLockType());
            entry.put("reasonCode", impact.getReasonCode());
            impacts.add(entry);
        }
        data.put("impacts", impacts);
        data.put("impactSummary", impactCalculator.summarize(eventImpactRepository.findByEventId(event.getId())));

        List<Map<String, Object>> tasks = new ArrayList<>();
        for (var task : scheduleTaskRepository.findByEventId(event.getId())) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("taskId", task.getId());
            entry.put("taskCode", task.getTaskCode());
            entry.put("mode", task.getMode());
            entry.put("status", task.getStatus());
            tasks.add(entry);
        }
        data.put("relatedTasks", tasks);
        return data;
    }
}
