package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import com.fjsp.business.common.BizException;
import com.fjsp.business.dto.BreakdownEventRequest;
import com.fjsp.business.dto.BreakdownEventResponse;
import com.fjsp.business.dto.EventResponse;
import com.fjsp.business.dto.EventRevisionResponse;
import com.fjsp.business.dto.ImpactSummaryResponse;
import com.fjsp.business.dto.NewOrderEventRequest;
import com.fjsp.business.dto.NewOrderEventResponse;
import com.fjsp.business.dto.ReviseEventRequest;
import com.fjsp.business.entity.Event;
import com.fjsp.business.entity.ExecutionRecord;
import com.fjsp.business.entity.Machine;
import com.fjsp.business.entity.OrderOperation;
import com.fjsp.business.entity.PlanVersion;
import com.fjsp.business.entity.ProcessOperation;
import com.fjsp.business.entity.ProcessTemplate;
import com.fjsp.business.entity.ProductionOrder;
import com.fjsp.business.entity.ScheduleOperation;
import com.fjsp.business.entity.ScheduleTask;
import com.fjsp.business.repository.EventImpactRepository;
import com.fjsp.business.repository.EventRepository;
import com.fjsp.business.repository.MachineRepository;
import com.fjsp.business.repository.OrderOperationRepository;
import com.fjsp.business.repository.ProcessOperationRepository;
import com.fjsp.business.repository.ProcessTemplateRepository;
import com.fjsp.business.repository.ProductionOrderRepository;
import com.fjsp.business.repository.ScheduleOperationRepository;
import com.fjsp.business.repository.ScheduleTaskRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class EventServiceTest {

    @Mock
    private EventRepository eventRepository;
    @Mock
    private EventImpactRepository eventImpactRepository;
    @Mock
    private ProductionOrderRepository productionOrderRepository;
    @Mock
    private OrderOperationRepository orderOperationRepository;
    @Mock
    private ProcessTemplateRepository processTemplateRepository;
    @Mock
    private ProcessOperationRepository processOperationRepository;
    @Mock
    private MachineRepository machineRepository;
    @Mock
    private ScheduleOperationRepository scheduleOperationRepository;
    @Mock
    private ScheduleTaskRepository scheduleTaskRepository;
    @Mock
    private ImpactCalculator impactCalculator;
    @Mock
    private CodeGenerator codeGenerator;
    @Mock
    private AuditService auditService;
    @Mock
    private IdempotencyService idempotencyService;

    @InjectMocks
    private EventService eventService;

    // ---------- 紧急订单插入 ----------

    /** 写接口统一走 idempotencyService.execute 模板：测试替身直接执行 action（回放场景单独打桩）。 */
    private void stubExecuteRunsAction() {
        when(idempotencyService.execute(anyString(), any(), any(), any()))
                .thenAnswer(inv -> ((java.util.function.Supplier<Object>) inv.getArgument(2)).get());
    }

    private NewOrderEventRequest newOrderRequest() {
        return new NewOrderEventRequest("URGENT_INSERT", "ORD-NEW-1", "FAM-A", 10,
                "2026-09-16T09:00:00+08:00", "2026-09-20T08:00:00+08:00", 5,
                "2026-09-16T09:00:00+08:00", null);
    }

    private ProcessTemplate activeTemplate() {
        ProcessTemplate template = new ProcessTemplate();
        template.setId("TPL-1");
        template.setTemplateCode("TPL-A");
        template.setProductFamily("FAM-A");
        template.setStatus("ACTIVE");
        return template;
    }

    private List<ProcessOperation> templateOperations() {
        ProcessOperation op1 = new ProcessOperation();
        op1.setId("PO-1");
        op1.setTemplateId("TPL-1");
        op1.setSequenceNo(1);
        op1.setDefaultCandidates(List.of(Map.of("machineId", "M1", "processMinutes", 60)));
        ProcessOperation op2 = new ProcessOperation();
        op2.setId("PO-2");
        op2.setTemplateId("TPL-1");
        op2.setSequenceNo(2);
        op2.setDefaultCandidates(List.of(Map.of("machineId", "M2", "processMinutes", 30)));
        return List.of(op1, op2);
    }

    private void stubNewOrderHappyPath(NewOrderEventRequest req) {
        stubExecuteRunsAction();
        when(productionOrderRepository.existsByOrderCode("ORD-NEW-1")).thenReturn(false);
        when(processTemplateRepository.findFirstByProductFamilyAndStatusOrderByTemplateVersionDesc(
                "FAM-A", "ACTIVE")).thenReturn(Optional.of(activeTemplate()));
        when(processOperationRepository.findByTemplateIdOrderBySequenceNo("TPL-1"))
                .thenReturn(templateOperations());
        when(codeGenerator.next("EVT")).thenReturn("EVT-001");
        when(eventImpactRepository.findByEventId(anyString())).thenReturn(List.of());
        when(impactCalculator.summarize(any())).thenReturn(new ImpactSummaryResponse(2, Map.of()));
    }

    @Test
    void createNewOrderEvent_success() {
        NewOrderEventRequest req = newOrderRequest();
        stubNewOrderHappyPath(req);

        NewOrderEventResponse data = eventService.createNewOrderEvent("key-1", req);

        ArgumentCaptor<ProductionOrder> orderCaptor = ArgumentCaptor.forClass(ProductionOrder.class);
        verify(productionOrderRepository).save(orderCaptor.capture());
        ProductionOrder order = orderCaptor.getValue();
        assertEquals("ORD-NEW-1", order.getOrderCode());
        assertEquals("WAITING", order.getStatus());
        assertEquals("FAM-A", order.getProductFamily());
        assertEquals(5, order.getPriority());

        ArgumentCaptor<OrderOperation> opCaptor = ArgumentCaptor.forClass(OrderOperation.class);
        verify(orderOperationRepository, times(2)).save(opCaptor.capture());
        List<OrderOperation> ops = opCaptor.getAllValues();
        assertEquals("ORD-NEW-1-1", ops.get(0).getId());
        assertEquals("ORD-NEW-1-2", ops.get(1).getId());
        assertTrue(ops.stream().allMatch(o -> "NOT_STARTED".equals(o.getStatus())));

        ArgumentCaptor<Event> eventCaptor = ArgumentCaptor.forClass(Event.class);
        verify(eventRepository).save(eventCaptor.capture());
        Event event = eventCaptor.getValue();
        assertEquals(Event.TYPE_NEW_ORDER, event.getEventType());
        assertEquals("URGENT_INSERT", event.getSubType());
        assertEquals("CONFIRMED", event.getStatus());
        assertNotNull(event.getFingerprint());

        verify(impactCalculator).recordNewOrderImpacts(any(Event.class), eq("ORD-NEW-1"));
        verify(idempotencyService).execute(eq("key-1"), eq(req), any(), any());

        assertEquals(List.of("ORD-NEW-1-1", "ORD-NEW-1-2"), data.operationIds());
        assertEquals("EVT-001", data.eventCode());
    }

    @Test
    void createNewOrderEvent_duplicateOrderCode_rejected() {
        NewOrderEventRequest req = newOrderRequest();
        stubExecuteRunsAction();
        when(productionOrderRepository.existsByOrderCode("ORD-NEW-1")).thenReturn(true);

        BizException e = assertThrows(BizException.class,
                () -> eventService.createNewOrderEvent("key-1", req));
        assertEquals("E_DUPLICATE", e.getCode());
        verify(eventRepository, never()).save(any());
    }

    @Test
    void createNewOrderEvent_idempotencyReplay_returnsStoredResponse() {
        NewOrderEventRequest req = newOrderRequest();
        NewOrderEventResponse stored = new NewOrderEventResponse("e-old", "EVT-OLD", "ORD-NEW-1",
                "ORD-NEW-1", List.of(), null);
        when(idempotencyService.execute(eq("key-1"), eq(req), any(), eq(NewOrderEventResponse.class)))
                .thenReturn(stored);

        NewOrderEventResponse data = eventService.createNewOrderEvent("key-1", req);

        assertEquals("e-old", data.eventId());
        verify(eventRepository, never()).save(any());
        verify(productionOrderRepository, never()).save(any());
    }

    @Test
    void createNewOrderEvent_noActiveTemplate_rejected() {
        NewOrderEventRequest req = newOrderRequest();
        stubExecuteRunsAction();
        when(productionOrderRepository.existsByOrderCode("ORD-NEW-1")).thenReturn(false);
        when(processTemplateRepository.findFirstByProductFamilyAndStatusOrderByTemplateVersionDesc(
                "FAM-A", "ACTIVE")).thenReturn(Optional.empty());

        BizException e = assertThrows(BizException.class,
                () -> eventService.createNewOrderEvent("key-1", req));
        assertEquals("E_VALIDATION", e.getCode());
    }

    @Test
    void createNewOrderEvent_invalidPriority_rejected() {
        NewOrderEventRequest req = new NewOrderEventRequest("URGENT_INSERT", "ORD-NEW-1", "FAM-A",
                10, "2026-09-16T09:00:00+08:00", "2026-09-20T08:00:00+08:00", 9,
                "2026-09-16T09:00:00+08:00", null);
        stubExecuteRunsAction();

        BizException e = assertThrows(BizException.class,
                () -> eventService.createNewOrderEvent("key-1", req));
        assertEquals("E_VALIDATION", e.getCode());
    }

    @Test
    void createNewOrderEvent_dueAtNotAfterArrival_rejected() {
        NewOrderEventRequest req = new NewOrderEventRequest("URGENT_INSERT", "ORD-NEW-1", "FAM-A",
                10, "2026-09-16T09:00:00+08:00", "2026-09-16T09:00:00+08:00", 5,
                "2026-09-16T09:00:00+08:00", null);
        stubExecuteRunsAction();
        when(productionOrderRepository.existsByOrderCode("ORD-NEW-1")).thenReturn(false);
        when(processTemplateRepository.findFirstByProductFamilyAndStatusOrderByTemplateVersionDesc(
                "FAM-A", "ACTIVE")).thenReturn(Optional.of(activeTemplate()));
        when(processOperationRepository.findByTemplateIdOrderBySequenceNo("TPL-1"))
                .thenReturn(templateOperations());

        BizException e = assertThrows(BizException.class,
                () -> eventService.createNewOrderEvent("key-1", req));
        assertEquals("E_VALIDATION", e.getCode());
    }

    // ---------- 设备故障登记 ----------

    private BreakdownEventRequest breakdownRequest(String occurredAt) {
        return new BreakdownEventRequest("M1", occurredAt, 60, "MANUAL", null);
    }

    private Machine machine() {
        Machine machine = new Machine();
        machine.setId("M1");
        machine.setMachineCode("MC-01");
        return machine;
    }

    private PlanVersion publishedPlan() {
        PlanVersion plan = new PlanVersion();
        plan.setId("PV-1");
        plan.setVersionCode("PV-001");
        plan.setStatus("PUBLISHED");
        plan.setPublishedAt(OffsetDateTime.parse("2026-09-16T08:00:00+08:00"));
        return plan;
    }

    private ExecutionRecord runningRecord(String operationId) {
        ExecutionRecord record = new ExecutionRecord();
        record.setId("EX-1");
        record.setOperationId(operationId);
        record.setStatus("RUNNING");
        record.setActualStartAt(OffsetDateTime.parse("2026-09-16T09:30:00+08:00"));
        return record;
    }

    private ScheduleOperation plannedOp(String operationId, String start, String end) {
        ScheduleOperation op = new ScheduleOperation();
        op.setId("SO-1");
        op.setPlanVersionId("PV-1");
        op.setOperationId(operationId);
        op.setMachineId("M1");
        op.setStartAt(OffsetDateTime.parse(start));
        op.setEndAt(OffsetDateTime.parse(end));
        return op;
    }

    @Test
    void createBreakdownEvent_success() {
        BreakdownEventRequest req = breakdownRequest("2026-09-16T10:00:00+08:00");
        stubExecuteRunsAction();
        when(machineRepository.findById("M1")).thenReturn(Optional.of(machine()));
        when(impactCalculator.currentPublishedPlan()).thenReturn(null);
        when(codeGenerator.next("EVT")).thenReturn("EVT-002");
        when(impactCalculator.computeBreakdownImpacts(any(Event.class))).thenReturn(List.of());
        when(impactCalculator.summarize(any())).thenReturn(new ImpactSummaryResponse(0, Map.of()));

        BreakdownEventResponse data = eventService.createBreakdownEvent("key-1", req);

        ArgumentCaptor<Event> eventCaptor = ArgumentCaptor.forClass(Event.class);
        verify(eventRepository).save(eventCaptor.capture());
        Event event = eventCaptor.getValue();
        assertEquals(Event.TYPE_BREAKDOWN, event.getEventType());
        assertEquals("M1", event.getMachineId());
        assertEquals(60, event.getRepairDurationMinutes());
        assertEquals(OffsetDateTime.parse("2026-09-16T11:00:00+08:00"), event.getRepairEndAt());
        assertEquals("CONFIRMED", event.getStatus());
        assertNotNull(event.getFingerprint());

        verify(impactCalculator).computeBreakdownImpacts(any(Event.class));
        verify(idempotencyService).execute(eq("key-1"), eq(req), any(), any());
        assertEquals(OffsetDateTime.parse("2026-09-16T11:00:00+08:00"), data.repairEndAt());
    }

    @Test
    void createBreakdownEvent_machineNotFound_rejected() {
        BreakdownEventRequest req = breakdownRequest("2026-09-16T10:00:00+08:00");
        stubExecuteRunsAction();
        when(machineRepository.findById("M1")).thenReturn(Optional.empty());

        BizException e = assertThrows(BizException.class,
                () -> eventService.createBreakdownEvent("key-1", req));
        assertEquals("E_NOT_FOUND", e.getCode());
    }

    @Test
    void createBreakdownEvent_invalidDuration_rejected() {
        BreakdownEventRequest req = new BreakdownEventRequest("M1", "2026-09-16T10:00:00+08:00",
                0, "MANUAL", null);
        stubExecuteRunsAction();

        BizException e = assertThrows(BizException.class,
                () -> eventService.createBreakdownEvent("key-1", req));
        assertEquals("E_VALIDATION", e.getCode());
    }

    @Test
    void createBreakdownEvent_hitsRunningOperation_rejected() {
        BreakdownEventRequest req = breakdownRequest("2026-09-16T10:00:00+08:00");
        stubExecuteRunsAction();
        when(machineRepository.findById("M1")).thenReturn(Optional.of(machine()));
        when(impactCalculator.currentPublishedPlan()).thenReturn(publishedPlan());
        when(impactCalculator.runningExecutions()).thenReturn(List.of(runningRecord("OP-1")));
        when(scheduleOperationRepository.findByPlanVersionIdAndOperationId("PV-1", "OP-1"))
                .thenReturn(Optional.of(plannedOp("OP-1", "2026-09-16T09:30:00+08:00",
                        "2026-09-16T10:30:00+08:00")));

        BizException e = assertThrows(BizException.class,
                () -> eventService.createBreakdownEvent("key-1", req));
        assertEquals("E_EVENT_IN_PROCESS", e.getCode());
        verify(eventRepository, never()).save(any());
    }

    @Test
    void createBreakdownEvent_completedOperation_allowed() {
        // 已完成工序没有 RUNNING 执行记录，故障登记不被拦截
        BreakdownEventRequest req = breakdownRequest("2026-09-16T10:00:00+08:00");
        stubExecuteRunsAction();
        when(machineRepository.findById("M1")).thenReturn(Optional.of(machine()));
        when(impactCalculator.currentPublishedPlan()).thenReturn(publishedPlan());
        when(impactCalculator.runningExecutions()).thenReturn(List.of());
        when(codeGenerator.next("EVT")).thenReturn("EVT-003");
        when(impactCalculator.computeBreakdownImpacts(any(Event.class))).thenReturn(List.of());
        when(impactCalculator.summarize(any())).thenReturn(new ImpactSummaryResponse(0, Map.of()));

        BreakdownEventResponse data = eventService.createBreakdownEvent("key-1", req);

        assertNotNull(data.eventId());
        verify(eventRepository).save(any(Event.class));
    }

    @Test
    void createBreakdownEvent_idleWindow_allowed() {
        // 故障发生在 12:00，而执行中工序计划区间是 09:30-10:30，不在区间内
        BreakdownEventRequest req = breakdownRequest("2026-09-16T12:00:00+08:00");
        stubExecuteRunsAction();
        when(machineRepository.findById("M1")).thenReturn(Optional.of(machine()));
        when(impactCalculator.currentPublishedPlan()).thenReturn(publishedPlan());
        when(impactCalculator.runningExecutions()).thenReturn(List.of(runningRecord("OP-1")));
        when(scheduleOperationRepository.findByPlanVersionIdAndOperationId("PV-1", "OP-1"))
                .thenReturn(Optional.of(plannedOp("OP-1", "2026-09-16T09:30:00+08:00",
                        "2026-09-16T10:30:00+08:00")));
        when(codeGenerator.next("EVT")).thenReturn("EVT-004");
        when(impactCalculator.computeBreakdownImpacts(any(Event.class))).thenReturn(List.of());
        when(impactCalculator.summarize(any())).thenReturn(new ImpactSummaryResponse(0, Map.of()));

        BreakdownEventResponse data = eventService.createBreakdownEvent("key-1", req);

        assertNotNull(data.eventId());
        verify(eventRepository).save(any(Event.class));
    }

    @Test
    void createBreakdownEvent_idempotencyReplay_returnsStoredResponse() {
        BreakdownEventRequest req = breakdownRequest("2026-09-16T10:00:00+08:00");
        BreakdownEventResponse stored = new BreakdownEventResponse("e-old", "EVT-OLD", "M1",
                null, null, null);
        when(idempotencyService.execute(eq("key-1"), eq(req), any(), eq(BreakdownEventResponse.class)))
                .thenReturn(stored);

        BreakdownEventResponse data = eventService.createBreakdownEvent("key-1", req);

        assertEquals("e-old", data.eventId());
        verify(eventRepository, never()).save(any());
    }

    // ---- 事件列表分页 + 过滤 ----

    private Event sampleEvent(String id, String status, String type) {
        Event event = new Event();
        event.setId(id);
        event.setEventCode("EVT-" + id);
        event.setEventType(type);
        event.setStatus(status);
        event.setOccurredAt(OffsetDateTime.parse("2026-10-04T08:00:00+08:00"));
        return event;
    }

    @Test
    void listEvents_pagedEnvelopeWithFilters() {
        Event event = sampleEvent("e1", "CONFIRMED", "BREAKDOWN");
        var pageable = com.fjsp.business.common.PageSupport.of(0, 10,
                com.fjsp.business.common.PageSupport.DEFAULT_MAX_SIZE,
                org.springframework.data.domain.Sort.by(org.springframework.data.domain.Sort.Direction.DESC,
                        "occurredAt"));
        when(eventRepository.findAll(any(org.springframework.data.jpa.domain.Specification.class),
                any(org.springframework.data.domain.Pageable.class)))
                .thenReturn(new org.springframework.data.domain.PageImpl<>(List.of(event), pageable, 1));

        var resp = eventService.listEvents("CONFIRMED", "BREAKDOWN",
                "2026-10-04T00:00:00+08:00", "2026-10-05T00:00:00+08:00", 0, 10);

        assertEquals(1, resp.getTotal());
        assertEquals(1, resp.getTotalPages());
        assertEquals(0, resp.getPage());
        assertEquals(10, resp.getSize());
        assertEquals(1, resp.getItems().size());
        EventResponse item = resp.getItems().get(0);
        assertEquals("e1", item.eventId());
        assertEquals("EVT-e1", item.eventCode());
        assertEquals("BREAKDOWN", item.eventType());
        assertEquals("CONFIRMED", item.status());
    }

    @Test
    void listEvents_noFilters_usesDefaults() {
        var pageable = com.fjsp.business.common.PageSupport.of(null, null,
                com.fjsp.business.common.PageSupport.DEFAULT_MAX_SIZE,
                org.springframework.data.domain.Sort.by(org.springframework.data.domain.Sort.Direction.DESC,
                        "occurredAt"));
        when(eventRepository.findAll(any(org.springframework.data.jpa.domain.Specification.class),
                any(org.springframework.data.domain.Pageable.class)))
                .thenReturn(new org.springframework.data.domain.PageImpl<>(List.of(), pageable, 0));

        var resp = eventService.listEvents(null, null, null, null, null, null);

        assertEquals(0, resp.getTotal());
        assertEquals(com.fjsp.business.common.PageSupport.DEFAULT_SIZE, resp.getSize());
        assertTrue(resp.getItems().isEmpty());
    }

    @Test
    void listEvents_invalidPageParams_rejected() {
        assertThrows(BizException.class, () -> eventService.listEvents(null, null, null, null, -1, 10));
        assertThrows(BizException.class, () -> eventService.listEvents(null, null, null, null, 0, 0));
        assertThrows(BizException.class, () -> eventService.listEvents(null, null, null, null, 0, 201));
    }

    // ---- F-07 录入去重 ----

    @Test
    void createNewOrderEvent_duplicateFingerprint_rejected() {
        NewOrderEventRequest req = newOrderRequest();
        stubExecuteRunsAction();
        when(productionOrderRepository.existsByOrderCode("ORD-NEW-1")).thenReturn(false);
        when(processTemplateRepository.findFirstByProductFamilyAndStatusOrderByTemplateVersionDesc(
                "FAM-A", "ACTIVE")).thenReturn(Optional.of(activeTemplate()));
        when(processOperationRepository.findByTemplateIdOrderBySequenceNo("TPL-1"))
                .thenReturn(templateOperations());
        when(eventRepository.existsByFingerprint(anyString())).thenReturn(true);

        BizException e = assertThrows(BizException.class,
                () -> eventService.createNewOrderEvent("key-1", req));
        assertEquals("E_DUPLICATE", e.getCode());
        verify(eventRepository, never()).save(any());
        verify(productionOrderRepository, never()).save(any());
    }

    @Test
    void createBreakdownEvent_duplicateFingerprint_rejected() {
        BreakdownEventRequest req = breakdownRequest("2026-09-16T10:00:00+08:00");
        stubExecuteRunsAction();
        when(machineRepository.findById("M1")).thenReturn(Optional.of(machine()));
        when(impactCalculator.currentPublishedPlan()).thenReturn(null);
        when(eventRepository.findByMachineIdAndEventType("M1", Event.TYPE_BREAKDOWN)).thenReturn(List.of());
        when(eventRepository.existsByFingerprint(anyString())).thenReturn(true);

        BizException e = assertThrows(BizException.class,
                () -> eventService.createBreakdownEvent("key-1", req));
        assertEquals("E_DUPLICATE", e.getCode());
        verify(eventRepository, never()).save(any());
    }

    @Test
    void createBreakdownEvent_overlappingRepairWindow_rejected() {
        BreakdownEventRequest req = breakdownRequest("2026-09-16T10:00:00+08:00");
        stubExecuteRunsAction();
        when(machineRepository.findById("M1")).thenReturn(Optional.of(machine()));
        when(impactCalculator.currentPublishedPlan()).thenReturn(null);
        Event existing = sampleEvent("e9", "CONFIRMED", Event.TYPE_BREAKDOWN);
        existing.setMachineId("M1");
        existing.setOccurredAt(OffsetDateTime.parse("2026-09-16T09:30:00+08:00"));
        existing.setRepairEndAt(OffsetDateTime.parse("2026-09-16T10:30:00+08:00"));
        when(eventRepository.findByMachineIdAndEventType("M1", Event.TYPE_BREAKDOWN))
                .thenReturn(List.of(existing));

        BizException e = assertThrows(BizException.class,
                () -> eventService.createBreakdownEvent("key-1", req));
        assertEquals("E_DUPLICATE", e.getCode());
        verify(eventRepository, never()).save(any());
    }

    @Test
    void createBreakdownEvent_overlappingClosedEvent_allowed() {
        // 已关闭（含被修订）的历史故障不参与重叠去重
        BreakdownEventRequest req = breakdownRequest("2026-09-16T10:00:00+08:00");
        stubExecuteRunsAction();
        when(machineRepository.findById("M1")).thenReturn(Optional.of(machine()));
        when(impactCalculator.currentPublishedPlan()).thenReturn(null);
        Event closed = sampleEvent("e9", "CLOSED", Event.TYPE_BREAKDOWN);
        closed.setMachineId("M1");
        closed.setOccurredAt(OffsetDateTime.parse("2026-09-16T09:30:00+08:00"));
        closed.setRepairEndAt(OffsetDateTime.parse("2026-09-16T10:30:00+08:00"));
        when(eventRepository.findByMachineIdAndEventType("M1", Event.TYPE_BREAKDOWN))
                .thenReturn(List.of(closed));
        when(eventRepository.existsByFingerprint(anyString())).thenReturn(false);
        when(codeGenerator.next("EVT")).thenReturn("EVT-009");
        when(impactCalculator.computeBreakdownImpacts(any(Event.class))).thenReturn(List.of());
        when(impactCalculator.summarize(any())).thenReturn(new ImpactSummaryResponse(0, Map.of()));

        BreakdownEventResponse data = eventService.createBreakdownEvent("key-1", req);

        assertNotNull(data.eventId());
        verify(eventRepository).save(any(Event.class));
    }

    // ---- F-07 事件关闭 ----

    private ScheduleTask task(String id, String status) {
        ScheduleTask task = new ScheduleTask();
        task.setId(id);
        task.setTaskCode("TSK-" + id);
        task.setMode("LOCAL_RESCHEDULE");
        task.setStatus(status);
        return task;
    }

    @Test
    void closeEvent_success() {
        Event event = sampleEvent("e1", "USED_FOR_SOLVE", Event.TYPE_BREAKDOWN);
        when(eventRepository.findById("e1")).thenReturn(Optional.of(event));
        when(scheduleTaskRepository.findByEventId("e1"))
                .thenReturn(List.of(task("t1", "SUCCESS"), task("t2", "CANCELLED")));

        EventResponse data = eventService.closeEvent("e1");

        assertEquals("CLOSED", event.getStatus());
        assertNotNull(event.getClosedAt());
        assertEquals("CLOSED", data.status());
        verify(eventRepository).save(event);
        verify(auditService).record(eq("EVENT_CLOSE"), eq("event"), eq("e1"), anyString());
    }

    @Test
    void closeEvent_pendingTasks_rejected() {
        Event event = sampleEvent("e1", "USED_FOR_SOLVE", Event.TYPE_BREAKDOWN);
        when(eventRepository.findById("e1")).thenReturn(Optional.of(event));
        when(scheduleTaskRepository.findByEventId("e1"))
                .thenReturn(List.of(task("t1", "RUNNING"), task("t2", "SUCCESS")));

        BizException e = assertThrows(BizException.class, () -> eventService.closeEvent("e1"));
        assertEquals("E_STATE_CONFLICT", e.getCode());
        assertTrue(e.getMessage().contains("TSK-t1"));
        assertEquals("USED_FOR_SOLVE", event.getStatus());
        verify(eventRepository, never()).save(any());
    }

    @Test
    void closeEvent_alreadyClosed_rejected() {
        Event event = sampleEvent("e1", "CLOSED", Event.TYPE_BREAKDOWN);
        when(eventRepository.findById("e1")).thenReturn(Optional.of(event));

        BizException e = assertThrows(BizException.class, () -> eventService.closeEvent("e1"));
        assertEquals("E_STATE_CONFLICT", e.getCode());
    }

    // ---- F-07 事件修订 ----

    private Event breakdownOriginal() {
        Event original = sampleEvent("e1", "USED_FOR_SOLVE", Event.TYPE_BREAKDOWN);
        original.setMachineId("M1");
        original.setOccurredAt(OffsetDateTime.parse("2026-09-16T10:00:00+08:00"));
        original.setRepairDurationMinutes(60);
        original.setRepairEndAt(OffsetDateTime.parse("2026-09-16T11:00:00+08:00"));
        original.setSource("MANUAL");
        return original;
    }

    @Test
    void reviseEvent_breakdown_success() {
        stubExecuteRunsAction();
        Event original = breakdownOriginal();
        when(eventRepository.findById("e1")).thenReturn(Optional.of(original));
        when(scheduleTaskRepository.findByEventId("e1")).thenReturn(List.of(task("t1", "SUCCESS")));
        when(codeGenerator.next("EVT")).thenReturn("EVT-100");
        when(impactCalculator.currentPublishedPlan()).thenReturn(null);
        when(eventRepository.findByMachineIdAndEventType("M1", Event.TYPE_BREAKDOWN))
                .thenReturn(List.of(original));
        when(impactCalculator.computeBreakdownImpacts(any(Event.class))).thenReturn(List.of());
        when(impactCalculator.summarize(any())).thenReturn(new ImpactSummaryResponse(0, Map.of()));

        ReviseEventRequest req = new ReviseEventRequest("维修时长更正为 90 分钟", null, 90, null, null, null);
        EventRevisionResponse data = eventService.reviseEvent("key-1", "e1", req);

        ArgumentCaptor<Event> captor = ArgumentCaptor.forClass(Event.class);
        verify(eventRepository, times(2)).save(captor.capture());
        Event revision = captor.getAllValues().get(0);
        assertEquals("EVT-100", revision.getEventCode());
        assertEquals("CONFIRMED", revision.getStatus());
        assertEquals("e1", revision.getRevisionOf());
        assertEquals("维修时长更正为 90 分钟", revision.getRevisionReason());
        assertEquals(90, revision.getRepairDurationMinutes());
        assertEquals(OffsetDateTime.parse("2026-09-16T11:30:00+08:00"), revision.getRepairEndAt());
        assertNotNull(revision.getFingerprint());

        assertEquals("CLOSED", original.getStatus());
        assertNotNull(original.getClosedAt());
        verify(impactCalculator).computeBreakdownImpacts(any(Event.class));
        verify(auditService).record(eq("EVENT_REVISE"), eq("event"), eq("e1"), anyString());
        assertEquals("EVT-100", data.eventCode());
        assertEquals("e1", data.revisionOf());
    }

    @Test
    void reviseEvent_newOrder_success() {
        stubExecuteRunsAction();
        Event original = sampleEvent("e1", "USED_FOR_SOLVE", Event.TYPE_NEW_ORDER);
        original.setSubType("URGENT_INSERT");
        original.setOrderId("ORD-1");
        when(eventRepository.findById("e1")).thenReturn(Optional.of(original));
        when(scheduleTaskRepository.findByEventId("e1")).thenReturn(List.of());
        when(codeGenerator.next("EVT")).thenReturn("EVT-101");
        when(eventImpactRepository.findByEventId(anyString())).thenReturn(List.of());
        when(impactCalculator.summarize(any())).thenReturn(new ImpactSummaryResponse(0, Map.of()));

        ReviseEventRequest req = new ReviseEventRequest("更正为常规追加", null, null, null,
                "NORMAL_APPEND", null);
        EventRevisionResponse data = eventService.reviseEvent("key-1", "e1", req);

        ArgumentCaptor<Event> captor = ArgumentCaptor.forClass(Event.class);
        verify(eventRepository, times(2)).save(captor.capture());
        Event revision = captor.getAllValues().get(0);
        assertEquals(Event.TYPE_NEW_ORDER, revision.getEventType());
        assertEquals("NORMAL_APPEND", revision.getSubType());
        assertEquals("ORD-1", revision.getOrderId());
        assertEquals("e1", revision.getRevisionOf());
        verify(impactCalculator).recordNewOrderImpacts(any(Event.class), eq("ORD-1"));
        assertEquals("CLOSED", original.getStatus());
        assertEquals("EVT-101", data.eventCode());
    }

    @Test
    void reviseEvent_missingReason_rejected() {
        stubExecuteRunsAction();
        Event original = breakdownOriginal();
        when(eventRepository.findById("e1")).thenReturn(Optional.of(original));

        BizException e = assertThrows(BizException.class,
                () -> eventService.reviseEvent("key-1", "e1", new ReviseEventRequest(" ", null, null, null, null, null)));
        assertEquals("E_VALIDATION", e.getCode());
        verify(eventRepository, never()).save(any());
    }

    @Test
    void reviseEvent_alreadyClosed_rejected() {
        stubExecuteRunsAction();
        Event original = breakdownOriginal();
        original.setStatus("CLOSED");
        when(eventRepository.findById("e1")).thenReturn(Optional.of(original));

        BizException e = assertThrows(BizException.class,
                () -> eventService.reviseEvent("key-1", "e1",
                        new ReviseEventRequest("更正", null, null, null, null, null)));
        assertEquals("E_STATE_CONFLICT", e.getCode());
        verify(eventRepository, never()).save(any());
    }

    @Test
    void reviseEvent_pendingTasks_rejected() {
        stubExecuteRunsAction();
        Event original = breakdownOriginal();
        when(eventRepository.findById("e1")).thenReturn(Optional.of(original));
        when(scheduleTaskRepository.findByEventId("e1")).thenReturn(List.of(task("t1", "RETRY_WAIT")));

        BizException e = assertThrows(BizException.class,
                () -> eventService.reviseEvent("key-1", "e1",
                        new ReviseEventRequest("更正", null, null, null, null, null)));
        assertEquals("E_STATE_CONFLICT", e.getCode());
        assertEquals("USED_FOR_SOLVE", original.getStatus());
        verify(eventRepository, never()).save(any());
    }

    @Test
    void reviseEvent_breakdownOverlapsOtherEvent_rejected() {
        stubExecuteRunsAction();
        Event original = breakdownOriginal();
        Event other = sampleEvent("e9", "CONFIRMED", Event.TYPE_BREAKDOWN);
        other.setMachineId("M1");
        other.setOccurredAt(OffsetDateTime.parse("2026-09-16T10:30:00+08:00"));
        other.setRepairEndAt(OffsetDateTime.parse("2026-09-16T12:00:00+08:00"));
        when(eventRepository.findById("e1")).thenReturn(Optional.of(original));
        when(scheduleTaskRepository.findByEventId("e1")).thenReturn(List.of());
        when(impactCalculator.currentPublishedPlan()).thenReturn(null);
        when(eventRepository.findByMachineIdAndEventType("M1", Event.TYPE_BREAKDOWN))
                .thenReturn(List.of(original, other));

        // 修订后区间 [10:00, 11:30) 与 e9 的 [10:30, 12:00) 重叠；原事件自身被排除
        BizException e = assertThrows(BizException.class,
                () -> eventService.reviseEvent("key-1", "e1",
                        new ReviseEventRequest("延长维修", null, 90, null, null, null)));
        assertEquals("E_DUPLICATE", e.getCode());
        assertEquals("USED_FOR_SOLVE", original.getStatus());
    }

    @Test
    void reschedulePreview_closedEvent_rejected() {
        Event event = sampleEvent("e1", "CLOSED", Event.TYPE_BREAKDOWN);
        when(eventRepository.findById("e1")).thenReturn(Optional.of(event));

        BizException e = assertThrows(BizException.class,
                () -> eventService.reschedulePreview("e1", null, null));
        assertEquals("E_STATE_CONFLICT", e.getCode());
    }
}
