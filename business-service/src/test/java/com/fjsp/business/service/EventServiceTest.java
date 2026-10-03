package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import com.fjsp.business.common.BizException;
import com.fjsp.business.dto.BreakdownEventRequest;
import com.fjsp.business.dto.NewOrderEventRequest;
import com.fjsp.business.entity.Event;
import com.fjsp.business.entity.ExecutionRecord;
import com.fjsp.business.entity.Machine;
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
        when(idempotencyService.findReplay("key-1", req)).thenReturn(Optional.empty());
        when(productionOrderRepository.existsByOrderCode("ORD-NEW-1")).thenReturn(false);
        when(processTemplateRepository.findFirstByProductFamilyAndStatusOrderByTemplateVersionDesc(
                "FAM-A", "ACTIVE")).thenReturn(Optional.of(activeTemplate()));
        when(processOperationRepository.findByTemplateIdOrderBySequenceNo("TPL-1"))
                .thenReturn(templateOperations());
        when(codeGenerator.next(eq("EVT"), any())).thenReturn("EVT-001");
        when(eventImpactRepository.findByEventId(anyString())).thenReturn(List.of());
        when(impactCalculator.summarize(any())).thenReturn(Map.of("total", 2));
    }

    @Test
    void createNewOrderEvent_success() {
        NewOrderEventRequest req = newOrderRequest();
        stubNewOrderHappyPath(req);

        Map<String, Object> data = eventService.createNewOrderEvent("key-1", req);

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
        verify(idempotencyService).store(eq("key-1"), eq(req), any());

        @SuppressWarnings("unchecked")
        List<String> operationIds = (List<String>) data.get("operationIds");
        assertEquals(List.of("ORD-NEW-1-1", "ORD-NEW-1-2"), operationIds);
        assertEquals("EVT-001", data.get("eventCode"));
    }

    @Test
    void createNewOrderEvent_duplicateOrderCode_rejected() {
        NewOrderEventRequest req = newOrderRequest();
        when(idempotencyService.findReplay("key-1", req)).thenReturn(Optional.empty());
        when(productionOrderRepository.existsByOrderCode("ORD-NEW-1")).thenReturn(true);

        BizException e = assertThrows(BizException.class,
                () -> eventService.createNewOrderEvent("key-1", req));
        assertEquals("E_DUPLICATE", e.getCode());
        verify(eventRepository, never()).save(any());
    }

    @Test
    void createNewOrderEvent_idempotencyReplay_returnsStoredResponse() {
        NewOrderEventRequest req = newOrderRequest();
        Map<String, Object> stored = Map.of("eventId", "e-old", "orderCode", "ORD-NEW-1");
        when(idempotencyService.findReplay("key-1", req)).thenReturn(Optional.of(stored));

        Map<String, Object> data = eventService.createNewOrderEvent("key-1", req);

        assertEquals("e-old", data.get("eventId"));
        verify(eventRepository, never()).save(any());
        verify(productionOrderRepository, never()).save(any());
    }

    @Test
    void createNewOrderEvent_noActiveTemplate_rejected() {
        NewOrderEventRequest req = newOrderRequest();
        when(idempotencyService.findReplay("key-1", req)).thenReturn(Optional.empty());
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
        when(idempotencyService.findReplay("key-1", req)).thenReturn(Optional.empty());

        BizException e = assertThrows(BizException.class,
                () -> eventService.createNewOrderEvent("key-1", req));
        assertEquals("E_VALIDATION", e.getCode());
    }

    @Test
    void createNewOrderEvent_dueAtNotAfterArrival_rejected() {
        NewOrderEventRequest req = new NewOrderEventRequest("URGENT_INSERT", "ORD-NEW-1", "FAM-A",
                10, "2026-09-16T09:00:00+08:00", "2026-09-16T09:00:00+08:00", 5,
                "2026-09-16T09:00:00+08:00", null);
        when(idempotencyService.findReplay("key-1", req)).thenReturn(Optional.empty());
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
        when(idempotencyService.findReplay("key-1", req)).thenReturn(Optional.empty());
        when(machineRepository.findById("M1")).thenReturn(Optional.of(machine()));
        when(impactCalculator.currentPublishedPlan()).thenReturn(null);
        when(codeGenerator.next(eq("EVT"), any())).thenReturn("EVT-002");
        when(impactCalculator.computeBreakdownImpacts(any(Event.class))).thenReturn(List.of());
        when(impactCalculator.summarize(any())).thenReturn(Map.of("total", 0));

        Map<String, Object> data = eventService.createBreakdownEvent("key-1", req);

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
        verify(idempotencyService).store(eq("key-1"), eq(req), any());
        assertEquals(OffsetDateTime.parse("2026-09-16T11:00:00+08:00"), data.get("repairEndAt"));
    }

    @Test
    void createBreakdownEvent_machineNotFound_rejected() {
        BreakdownEventRequest req = breakdownRequest("2026-09-16T10:00:00+08:00");
        when(idempotencyService.findReplay("key-1", req)).thenReturn(Optional.empty());
        when(machineRepository.findById("M1")).thenReturn(Optional.empty());

        BizException e = assertThrows(BizException.class,
                () -> eventService.createBreakdownEvent("key-1", req));
        assertEquals("E_NOT_FOUND", e.getCode());
    }

    @Test
    void createBreakdownEvent_invalidDuration_rejected() {
        BreakdownEventRequest req = new BreakdownEventRequest("M1", "2026-09-16T10:00:00+08:00",
                0, "MANUAL", null);
        when(idempotencyService.findReplay("key-1", req)).thenReturn(Optional.empty());

        BizException e = assertThrows(BizException.class,
                () -> eventService.createBreakdownEvent("key-1", req));
        assertEquals("E_VALIDATION", e.getCode());
    }

    @Test
    void createBreakdownEvent_hitsRunningOperation_rejected() {
        BreakdownEventRequest req = breakdownRequest("2026-09-16T10:00:00+08:00");
        when(idempotencyService.findReplay("key-1", req)).thenReturn(Optional.empty());
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
        when(idempotencyService.findReplay("key-1", req)).thenReturn(Optional.empty());
        when(machineRepository.findById("M1")).thenReturn(Optional.of(machine()));
        when(impactCalculator.currentPublishedPlan()).thenReturn(publishedPlan());
        when(impactCalculator.runningExecutions()).thenReturn(List.of());
        when(codeGenerator.next(eq("EVT"), any())).thenReturn("EVT-003");
        when(impactCalculator.computeBreakdownImpacts(any(Event.class))).thenReturn(List.of());
        when(impactCalculator.summarize(any())).thenReturn(Map.of("total", 0));

        Map<String, Object> data = eventService.createBreakdownEvent("key-1", req);

        assertNotNull(data.get("eventId"));
        verify(eventRepository).save(any(Event.class));
    }

    @Test
    void createBreakdownEvent_idleWindow_allowed() {
        // 故障发生在 12:00，而执行中工序计划区间是 09:30-10:30，不在区间内
        BreakdownEventRequest req = breakdownRequest("2026-09-16T12:00:00+08:00");
        when(idempotencyService.findReplay("key-1", req)).thenReturn(Optional.empty());
        when(machineRepository.findById("M1")).thenReturn(Optional.of(machine()));
        when(impactCalculator.currentPublishedPlan()).thenReturn(publishedPlan());
        when(impactCalculator.runningExecutions()).thenReturn(List.of(runningRecord("OP-1")));
        when(scheduleOperationRepository.findByPlanVersionIdAndOperationId("PV-1", "OP-1"))
                .thenReturn(Optional.of(plannedOp("OP-1", "2026-09-16T09:30:00+08:00",
                        "2026-09-16T10:30:00+08:00")));
        when(codeGenerator.next(eq("EVT"), any())).thenReturn("EVT-004");
        when(impactCalculator.computeBreakdownImpacts(any(Event.class))).thenReturn(List.of());
        when(impactCalculator.summarize(any())).thenReturn(Map.of("total", 0));

        Map<String, Object> data = eventService.createBreakdownEvent("key-1", req);

        assertNotNull(data.get("eventId"));
        verify(eventRepository).save(any(Event.class));
    }

    @Test
    void createBreakdownEvent_idempotencyReplay_returnsStoredResponse() {
        BreakdownEventRequest req = breakdownRequest("2026-09-16T10:00:00+08:00");
        Map<String, Object> stored = Map.of("eventId", "e-old", "machineId", "M1");
        when(idempotencyService.findReplay("key-1", req)).thenReturn(Optional.of(stored));

        Map<String, Object> data = eventService.createBreakdownEvent("key-1", req);

        assertEquals("e-old", data.get("eventId"));
        verify(eventRepository, never()).save(any());
    }
}
