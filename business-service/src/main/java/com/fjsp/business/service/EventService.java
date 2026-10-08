package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import com.fjsp.business.common.BizException;
import com.fjsp.business.common.HashUtil;
import com.fjsp.business.common.LookupSupport;
import com.fjsp.business.common.PageResponse;
import com.fjsp.business.common.PageSupport;
import com.fjsp.business.dto.BreakdownEventRequest;
import com.fjsp.business.dto.BreakdownEventResponse;
import com.fjsp.business.dto.EventDetailResponse;
import com.fjsp.business.dto.EventImpactItem;
import com.fjsp.business.dto.EventRelatedTaskItem;
import com.fjsp.business.dto.EventResponse;
import com.fjsp.business.dto.EventRevisionItem;
import com.fjsp.business.dto.EventRevisionResponse;
import com.fjsp.business.dto.NewOrderEventRequest;
import com.fjsp.business.dto.NewOrderEventResponse;
import com.fjsp.business.dto.ReschedulePreviewResponse;
import com.fjsp.business.dto.ReviseEventRequest;
import com.fjsp.business.entity.Event;
import com.fjsp.business.entity.EventImpact;
import com.fjsp.business.entity.OrderOperation;
import com.fjsp.business.entity.PlanVersion;
import com.fjsp.business.entity.ProcessOperation;
import com.fjsp.business.entity.ProcessTemplate;
import com.fjsp.business.entity.ProductionOrder;
import com.fjsp.business.entity.ScheduleOperation;
import com.fjsp.business.entity.TaskStatus;
import com.fjsp.business.repository.EventImpactRepository;
import com.fjsp.business.repository.EventRepository;
import com.fjsp.business.repository.MachineRepository;
import com.fjsp.business.repository.OrderOperationRepository;
import com.fjsp.business.repository.ProcessOperationRepository;
import com.fjsp.business.repository.ProcessTemplateRepository;
import com.fjsp.business.repository.ProductionOrderRepository;
import com.fjsp.business.repository.ScheduleOperationRepository;
import com.fjsp.business.repository.ScheduleTaskRepository;
import jakarta.persistence.criteria.Predicate;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.jpa.domain.Specification;
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
    public NewOrderEventResponse createNewOrderEvent(String idempotencyKey, NewOrderEventRequest req) {
        return idempotencyService.execute(idempotencyKey, req, () -> doCreateNewOrderEvent(req),
                NewOrderEventResponse.class);
    }

    private NewOrderEventResponse doCreateNewOrderEvent(NewOrderEventRequest req) {
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
        String fingerprint = HashUtil.sha256("NEW_ORDER|" + orderCode + "|" + occurredAt);
        if (eventRepository.existsByFingerprint(fingerprint)) {
            throw BizException.duplicate("相同订单号与发生时间的插单事件已登记，请勿重复提交: " + orderCode);
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
        event.setEventCode(codeGenerator.next("EVT"));
        event.setEventType(Event.TYPE_NEW_ORDER);
        event.setSubType(req.subType());
        event.setOrderId(order.getId());
        event.setOccurredAt(occurredAt);
        event.setNote(req.note());
        event.setStatus(Event.STATUS_CONFIRMED);
        event.setFingerprint(fingerprint);
        eventRepository.save(event);

        impactCalculator.recordNewOrderImpacts(event, order.getId());
        auditService.record("EVENT_NEW_ORDER", "event", event.getId(),
                "orderCode=" + orderCode + ", subType=" + req.subType());

        return new NewOrderEventResponse(event.getId(), event.getEventCode(), order.getId(),
                order.getOrderCode(), operationIds,
                impactCalculator.summarize(eventImpactRepository.findByEventId(event.getId())));
    }

    @Transactional
    public BreakdownEventResponse createBreakdownEvent(String idempotencyKey, BreakdownEventRequest req) {
        return idempotencyService.execute(idempotencyKey, req, () -> doCreateBreakdownEvent(req),
                BreakdownEventResponse.class);
    }

    private BreakdownEventResponse doCreateBreakdownEvent(BreakdownEventRequest req) {
        if (req == null || req.machineId() == null || req.occurredAt() == null
                || req.repairDurationMinutes() == null || req.repairDurationMinutes() <= 0) {
            throw BizException.validation("machineId/occurredAt/repairDurationMinutes 必填且 repairDurationMinutes>0");
        }
        machineRepository.findById(req.machineId())
                .orElseThrow(() -> BizException.notFound("设备不存在: " + req.machineId()));
        OffsetDateTime occurredAt = OffsetDateTime.parse(req.occurredAt());
        OffsetDateTime repairEndAt = occurredAt.plusMinutes(req.repairDurationMinutes());

        assertBreakdownNotInProcess(req.machineId(), occurredAt);
        assertBreakdownNotOverlapping(req.machineId(), occurredAt, repairEndAt, null);
        String fingerprint = HashUtil.sha256(
                "BREAKDOWN|" + req.machineId() + "|" + occurredAt + "|" + req.repairDurationMinutes());
        if (eventRepository.existsByFingerprint(fingerprint)) {
            throw BizException.duplicate("相同设备与发生时间的故障事件已登记，请勿重复提交: " + req.machineId());
        }

        Event event = new Event();
        event.setId(UUID.randomUUID().toString());
        event.setEventCode(codeGenerator.next("EVT"));
        event.setEventType(Event.TYPE_BREAKDOWN);
        event.setMachineId(req.machineId());
        event.setOccurredAt(occurredAt);
        event.setRepairDurationMinutes(req.repairDurationMinutes());
        event.setRepairEndAt(repairEndAt);
        event.setSource(req.source());
        event.setNote(req.note());
        event.setStatus(Event.STATUS_CONFIRMED);
        event.setFingerprint(fingerprint);
        eventRepository.save(event);

        List<EventImpact> impacts = impactCalculator.computeBreakdownImpacts(event);
        auditService.record("EVENT_BREAKDOWN", "event", event.getId(),
                "machine=" + req.machineId() + ", repairMinutes=" + req.repairDurationMinutes());

        return new BreakdownEventResponse(event.getId(), event.getEventCode(), req.machineId(),
                occurredAt, repairEndAt, impactCalculator.summarize(impacts));
    }

    /** F-08 重调度向导：影响范围预览（硬/软锁定数、影响工序与订单、两种模式预计求解规模）。 */
    public ReschedulePreviewResponse reschedulePreview(String eventIdOrCode, String planVersionIdOrCode,
                                                       Integer freezeWindowMinutes) {
        Event event = LookupSupport.byIdOrCode(eventIdOrCode, eventRepository::findById,
                eventRepository::findByEventCode, "事件不存在");
        if (Event.STATUS_CLOSED.equals(event.getStatus())) {
            throw BizException.stateConflict("事件已关闭，不可再触发重调度: " + event.getEventCode());
        }
        return impactCalculator.reschedulePreview(event, planVersionIdOrCode, freezeWindowMinutes);
    }

    /** F-07 事件生命周期：关闭事件。存在未终态关联任务（PENDING/RUNNING/RETRY_WAIT）时拒绝。 */
    @Transactional
    public EventResponse closeEvent(String eventIdOrCode) {
        Event event = LookupSupport.byIdOrCode(eventIdOrCode,
                eventRepository::findById, eventRepository::findByEventCode, "事件不存在");
        if (Event.STATUS_CLOSED.equals(event.getStatus())) {
            throw BizException.stateConflict("事件已关闭: " + event.getEventCode());
        }
        assertNoPendingTasks(event);
        String prevStatus = event.getStatus();
        event.setStatus(Event.STATUS_CLOSED);
        event.setClosedAt(OffsetDateTime.now());
        eventRepository.save(event);
        auditService.record("EVENT_CLOSE", "event", event.getId(),
                "eventCode=" + event.getEventCode() + ", prevStatus=" + prevStatus);
        return toResponse(event);
    }

    /**
     * F-07 事件修订：已用于求解的事件不可静默编辑，更正必须创建新事件。
     * 新事件携带 revisionOf 指向原事件并保存修订原因；原事件自动关闭（存在未终态任务时整体拒绝）。
     */
    @Transactional
    public EventRevisionResponse reviseEvent(String idempotencyKey, String eventIdOrCode,
                                             ReviseEventRequest req) {
        return idempotencyService.execute(idempotencyKey, req, () -> doReviseEvent(eventIdOrCode, req),
                EventRevisionResponse.class);
    }

    private EventRevisionResponse doReviseEvent(String eventIdOrCode, ReviseEventRequest req) {
        Event original = LookupSupport.byIdOrCode(eventIdOrCode,
                eventRepository::findById, eventRepository::findByEventCode, "事件不存在");
        if (req == null || req.reason() == null || req.reason().isBlank()) {
            throw BizException.validation("修订原因 reason 必填");
        }
        if (Event.STATUS_CLOSED.equals(original.getStatus())) {
            throw BizException.stateConflict("已关闭事件不可再修订: " + original.getEventCode());
        }
        assertNoPendingTasks(original);

        Event revision = new Event();
        revision.setId(UUID.randomUUID().toString());
        revision.setEventCode(codeGenerator.next("EVT"));
        revision.setEventType(original.getEventType());
        revision.setStatus(Event.STATUS_CONFIRMED);
        revision.setRevisionOf(original.getId());
        revision.setRevisionReason(req.reason());
        revision.setOccurredAt(req.occurredAt() != null && !req.occurredAt().isBlank()
                ? OffsetDateTime.parse(req.occurredAt()) : original.getOccurredAt());
        revision.setNote(req.note() != null ? req.note() : original.getNote());
        revision.setSource(req.source() != null ? req.source() : original.getSource());

        List<EventImpact> impacts;
        if (Event.TYPE_BREAKDOWN.equals(original.getEventType())) {
            revision.setMachineId(original.getMachineId());
            int repairMinutes = req.repairDurationMinutes() != null
                    ? req.repairDurationMinutes() : original.getRepairDurationMinutes();
            if (repairMinutes <= 0) {
                throw BizException.validation("repairDurationMinutes 必须大于 0");
            }
            revision.setRepairDurationMinutes(repairMinutes);
            revision.setRepairEndAt(revision.getOccurredAt().plusMinutes(repairMinutes));
            assertBreakdownNotInProcess(revision.getMachineId(), revision.getOccurredAt());
            assertBreakdownNotOverlapping(revision.getMachineId(), revision.getOccurredAt(),
                    revision.getRepairEndAt(), original.getId());
            revision.setFingerprint(HashUtil.sha256("BREAKDOWN|" + revision.getMachineId() + "|"
                    + revision.getOccurredAt() + "|" + repairMinutes + "|REV_OF|" + original.getId()));
            eventRepository.save(revision);
            impacts = impactCalculator.computeBreakdownImpacts(revision);
        } else {
            String subType = req.subType() != null ? req.subType() : original.getSubType();
            if (subType == null || !NEW_ORDER_SUBTYPES.contains(subType)) {
                throw BizException.validation("subType 必须是 URGENT_INSERT / NORMAL_APPEND");
            }
            revision.setSubType(subType);
            revision.setOrderId(original.getOrderId());
            revision.setFingerprint(HashUtil.sha256("NEW_ORDER|" + original.getOrderId() + "|"
                    + revision.getOccurredAt() + "|REV_OF|" + original.getId()));
            eventRepository.save(revision);
            impactCalculator.recordNewOrderImpacts(revision, original.getOrderId());
            impacts = eventImpactRepository.findByEventId(revision.getId());
        }

        original.setStatus(Event.STATUS_CLOSED);
        original.setClosedAt(OffsetDateTime.now());
        eventRepository.save(original);
        auditService.record("EVENT_REVISE", "event", original.getId(),
                "eventCode=" + original.getEventCode() + ", newEventCode=" + revision.getEventCode()
                        + ", reason=" + req.reason());

        return EventRevisionResponse.of(toResponse(revision), impactCalculator.summarize(impacts));
    }

    /** 关闭/修订前置校验：存在未终态关联任务时拒绝（409），保护进行中的求解。 */
    private void assertNoPendingTasks(Event event) {
        List<String> pending = scheduleTaskRepository.findByEventId(event.getId()).stream()
                .filter(task -> !TaskStatus.isTerminal(task.getStatus()))
                .map(task -> task.getTaskCode() + "(" + task.getStatus() + ")")
                .toList();
        if (!pending.isEmpty()) {
            throw BizException.stateConflict("事件存在待处理任务，请先取消或等待完成: " + String.join(", ", pending));
        }
    }

    /** 故障时间落在已开始未完成的加工区间内时拒绝登记（工序边界生效，V1 不支持暂停续作）。 */
    private void assertBreakdownNotInProcess(String machineId, OffsetDateTime occurredAt) {
        PlanVersion published = impactCalculator.currentPublishedPlan();
        if (published == null) {
            return;
        }
        for (var running : impactCalculator.runningExecutions()) {
            ScheduleOperation planned = scheduleOperationRepository
                    .findByPlanVersionIdAndOperationId(published.getId(), running.getOperationId())
                    .orElse(null);
            if (planned != null && planned.getMachineId().equals(machineId)
                    && !occurredAt.isBefore(planned.getStartAt())
                    && occurredAt.isBefore(planned.getEndAt())) {
                throw BizException.eventInProcess(
                        "故障时间落在执行中工序 " + planned.getOperationId() + " 的计划区间内，不允许登记");
            }
        }
    }

    /** 故障去重：同设备未关闭事件的维修区间与新区间重叠时拒绝；excludeId 用于修订时排除原事件。 */
    private void assertBreakdownNotOverlapping(String machineId, OffsetDateTime occurredAt,
                                               OffsetDateTime repairEndAt, String excludeId) {
        for (Event other : eventRepository.findByMachineIdAndEventType(machineId, Event.TYPE_BREAKDOWN)) {
            if (Event.STATUS_CLOSED.equals(other.getStatus()) || other.getId().equals(excludeId)
                    || other.getRepairEndAt() == null) {
                continue;
            }
            if (occurredAt.isBefore(other.getRepairEndAt()) && repairEndAt.isAfter(other.getOccurredAt())) {
                throw BizException.duplicate("同设备存在维修区间重叠的未关闭故障事件: " + other.getEventCode()
                        + " [" + other.getOccurredAt() + ", " + other.getRepairEndAt() + ")");
            }
        }
    }

    public EventDetailResponse getEvent(String eventIdOrCode) {
        Event event = LookupSupport.byIdOrCode(eventIdOrCode,
                eventRepository::findById, eventRepository::findByEventCode, "事件不存在");
        List<EventImpact> eventImpacts = eventImpactRepository.findByEventId(event.getId());
        List<EventImpactItem> impacts = new ArrayList<>();
        for (EventImpact impact : eventImpacts) {
            impacts.add(new EventImpactItem(impact.getOperationId(), impact.getImpactType(),
                    impact.getImpactReason(), impact.getLockType(), impact.getReasonCode()));
        }

        List<EventRelatedTaskItem> tasks = new ArrayList<>();
        for (var task : scheduleTaskRepository.findByEventId(event.getId())) {
            tasks.add(new EventRelatedTaskItem(task.getId(), task.getTaskCode(), task.getMode(),
                    task.getStatus()));
        }

        List<EventRevisionItem> revisions = new ArrayList<>();
        for (Event rev : eventRepository.findByRevisionOf(event.getId())) {
            revisions.add(new EventRevisionItem(rev.getId(), rev.getEventCode(), rev.getStatus(),
                    rev.getRevisionReason(), rev.getRecordedAt()));
        }
        return EventDetailResponse.of(toResponse(event), impacts,
                impactCalculator.summarize(eventImpacts), tasks, revisions);
    }

    private EventResponse toResponse(Event event) {
        return new EventResponse(event.getId(), event.getEventCode(), event.getEventType(),
                event.getSubType(), event.getMachineId(), event.getOrderId(), event.getOccurredAt(),
                event.getRecordedAt(), event.getRepairDurationMinutes(), event.getRepairEndAt(),
                event.getSource(), event.getNote(), event.getStatus(), event.getRevisionOf(),
                event.getRevisionReason(), event.getClosedAt());
    }

    /** 事件列表：分页 + 可选过滤（status / eventType / occurredAt 时间范围 from-to）。 */
    public PageResponse<EventResponse> listEvents(String status, String eventType,
                                                  String from, String to,
                                                  Integer page, Integer size) {
        PageRequest pageable = PageSupport.of(page, size, PageSupport.DEFAULT_MAX_SIZE,
                Sort.by(Sort.Direction.DESC, "occurredAt"));
        Specification<Event> spec = (root, query, cb) -> {
            List<Predicate> predicates = new ArrayList<>();
            if (status != null && !status.isBlank()) {
                predicates.add(cb.equal(root.get("status"), status));
            }
            if (eventType != null && !eventType.isBlank()) {
                predicates.add(cb.equal(root.get("eventType"), eventType));
            }
            if (from != null && !from.isBlank()) {
                predicates.add(cb.greaterThanOrEqualTo(root.get("occurredAt"), OffsetDateTime.parse(from)));
            }
            if (to != null && !to.isBlank()) {
                predicates.add(cb.lessThanOrEqualTo(root.get("occurredAt"), OffsetDateTime.parse(to)));
            }
            return cb.and(predicates.toArray(new Predicate[0]));
        };
        return PageResponse.of(eventRepository.findAll(spec, pageable), this::toResponse);
    }
}
