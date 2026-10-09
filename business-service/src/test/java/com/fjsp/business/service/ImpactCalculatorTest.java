package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import com.fjsp.business.common.BizException;
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
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class ImpactCalculatorTest {

    private static final OffsetDateTime OCCURRED = OffsetDateTime.parse("2026-09-16T10:00:00+08:00");

    @Mock
    private ScheduleOperationRepository scheduleOperationRepository;
    @Mock
    private OrderOperationRepository orderOperationRepository;
    @Mock
    private ExecutionRecordRepository executionRecordRepository;
    @Mock
    private PlanVersionRepository planVersionRepository;
    @Mock
    private EventImpactRepository eventImpactRepository;

    private ImpactCalculator impactCalculator;

    @BeforeEach
    void setUp() {
        FjspProperties properties = new FjspProperties();
        properties.setFreezeWindow(java.time.Duration.ofMinutes(30));
        impactCalculator = new ImpactCalculator(scheduleOperationRepository, orderOperationRepository,
                executionRecordRepository, planVersionRepository, eventImpactRepository, properties);
    }

    private Event breakdownEvent(int repairMinutes) {
        Event event = new Event();
        event.setId("EVT-1");
        event.setEventType(Event.TYPE_BREAKDOWN);
        event.setMachineId("M1");
        event.setOccurredAt(OCCURRED);
        event.setRepairDurationMinutes(repairMinutes);
        event.setRepairEndAt(OCCURRED.plusMinutes(repairMinutes));
        return event;
    }

    private PlanVersion publishedPlan() {
        PlanVersion plan = new PlanVersion();
        plan.setId("PV-1");
        plan.setStatus("PUBLISHED");
        plan.setPublishedAt(OCCURRED.minusHours(2));
        return plan;
    }

    private ScheduleOperation planOp(String opId, String machineId, String start, String end) {
        ScheduleOperation op = new ScheduleOperation();
        op.setId("SO-" + opId);
        op.setPlanVersionId("PV-1");
        op.setOperationId(opId);
        op.setMachineId(machineId);
        op.setStartAt(OffsetDateTime.parse(start));
        op.setEndAt(OffsetDateTime.parse(end));
        return op;
    }

    private OrderOperation orderOp(String opId, String orderId, int seq) {
        OrderOperation oo = new OrderOperation();
        oo.setId(opId);
        oo.setOrderId(orderId);
        oo.setSequenceNo(seq);
        return oo;
    }

    private void stubPublishedPlan(List<ScheduleOperation> ops) {
        when(planVersionRepository.findByStatusIn(List.of("PUBLISHED", "EXECUTING")))
                .thenReturn(List.of(publishedPlan()));
        when(scheduleOperationRepository.findByPlanVersionId("PV-1")).thenReturn(ops);
    }

    private Map<String, EventImpact> byOperation(List<EventImpact> impacts) {
        return impacts.stream().collect(java.util.stream.Collectors.toMap(
                EventImpact::getOperationId, i -> i));
    }

    @Test
    void computeBreakdownImpacts_noPublishedPlan_returnsEmpty() {
        when(planVersionRepository.findByStatusIn(List.of("PUBLISHED", "EXECUTING")))
                .thenReturn(List.of());

        List<EventImpact> impacts = impactCalculator.computeBreakdownImpacts(breakdownEvent(60));

        assertTrue(impacts.isEmpty());
    }

    @Test
    void computeBreakdownImpacts_overlappingRepairWindow_runningOp_hardLocked() {
        // OP-1 计划区间 09:30-10:30 与维修区间 [10:00, 11:00) 重叠，且正在执行
        stubPublishedPlan(List.of(planOp("OP-1", "M1", "2026-09-16T09:30:00+08:00",
                "2026-09-16T10:30:00+08:00")));
        ExecutionRecord running = new ExecutionRecord();
        running.setOperationId("OP-1");
        running.setStatus("RUNNING");
        when(executionRecordRepository.findByOperationIdIn(any())).thenReturn(List.of(running));
        when(orderOperationRepository.findAllById(any()))
                .thenReturn(List.of(orderOp("OP-1", "ORD-1", 1)));
        when(orderOperationRepository.findByOrderIdOrderBySequenceNo("ORD-1"))
                .thenReturn(List.of(orderOp("OP-1", "ORD-1", 1), orderOp("OP-2", "ORD-1", 2)));

        List<EventImpact> impacts = impactCalculator.computeBreakdownImpacts(breakdownEvent(60));

        Map<String, EventImpact> byOp = byOperation(impacts);
        assertEquals(2, impacts.size());
        EventImpact direct = byOp.get("OP-1");
        assertEquals(ImpactCalculator.SAME_MACHINE_CONFLICT, direct.getImpactType());
        assertEquals("BREAKDOWN_OVERLAP", direct.getReasonCode());
        assertEquals("HARD_LOCKED", direct.getLockType());
        EventImpact successor = byOp.get("OP-2");
        assertEquals(ImpactCalculator.SUCCESSOR, successor.getImpactType());
        assertEquals("SUCCESSOR_OF_AFFECTED", successor.getReasonCode());
        assertEquals("ADJUSTABLE", successor.getLockType());
        verify(eventImpactRepository, times(2)).save(any(EventImpact.class));
    }

    @Test
    void computeBreakdownImpacts_overlappingRepairWindow_notRunning_adjustable() {
        stubPublishedPlan(List.of(planOp("OP-1", "M1", "2026-09-16T09:30:00+08:00",
                "2026-09-16T10:30:00+08:00")));
        when(executionRecordRepository.findByOperationIdIn(any())).thenReturn(List.of());
        when(orderOperationRepository.findAllById(any()))
                .thenReturn(List.of(orderOp("OP-1", "ORD-1", 1)));
        when(orderOperationRepository.findByOrderIdOrderBySequenceNo("ORD-1"))
                .thenReturn(List.of(orderOp("OP-1", "ORD-1", 1)));

        List<EventImpact> impacts = impactCalculator.computeBreakdownImpacts(breakdownEvent(60));

        assertEquals(1, impacts.size());
        assertEquals(ImpactCalculator.SAME_MACHINE_CONFLICT, impacts.get(0).getImpactType());
        assertEquals("ADJUSTABLE", impacts.get(0).getLockType());
    }

    @Test
    void computeBreakdownImpacts_afterRepairWindow_machineDown() {
        // OP-1 计划区间 12:00-13:00 在维修区间之后且远离冻结窗口
        stubPublishedPlan(List.of(planOp("OP-1", "M1", "2026-09-16T12:00:00+08:00",
                "2026-09-16T13:00:00+08:00")));
        when(orderOperationRepository.findAllById(any()))
                .thenReturn(List.of(orderOp("OP-1", "ORD-1", 1)));
        when(orderOperationRepository.findByOrderIdOrderBySequenceNo("ORD-1"))
                .thenReturn(List.of(orderOp("OP-1", "ORD-1", 1)));

        List<EventImpact> impacts = impactCalculator.computeBreakdownImpacts(breakdownEvent(60));

        assertEquals(1, impacts.size());
        EventImpact impact = impacts.get(0);
        assertEquals(ImpactCalculator.MACHINE_BREAKDOWN, impact.getImpactType());
        assertEquals("MACHINE_DOWN", impact.getReasonCode());
        assertEquals("ADJUSTABLE", impact.getLockType());
    }

    @Test
    void computeBreakdownImpacts_startInFreezeWindow_hardLocked() {
        // 维修 15 分钟（10:00-10:15），冻结窗口到 10:30；OP-1 计划 10:20 开工，落在冻结窗口内
        stubPublishedPlan(List.of(planOp("OP-1", "M1", "2026-09-16T10:20:00+08:00",
                "2026-09-16T11:00:00+08:00")));
        when(orderOperationRepository.findAllById(any()))
                .thenReturn(List.of(orderOp("OP-1", "ORD-1", 1)));
        when(orderOperationRepository.findByOrderIdOrderBySequenceNo("ORD-1"))
                .thenReturn(List.of(orderOp("OP-1", "ORD-1", 1)));

        List<EventImpact> impacts = impactCalculator.computeBreakdownImpacts(breakdownEvent(15));

        assertEquals(1, impacts.size());
        EventImpact impact = impacts.get(0);
        assertEquals(ImpactCalculator.MACHINE_BREAKDOWN, impact.getImpactType());
        assertEquals("HARD_LOCKED", impact.getLockType());
    }

    @Test
    void computeBreakdownImpacts_completedOperation_skipped() {
        // OP-1 已完成、OP-2 在其他设备上：两者都不进入影响集合
        stubPublishedPlan(List.of(
                planOp("OP-1", "M1", "2026-09-16T12:00:00+08:00", "2026-09-16T13:00:00+08:00"),
                planOp("OP-2", "M2", "2026-09-16T10:00:00+08:00", "2026-09-16T11:00:00+08:00")));
        ExecutionRecord completed = new ExecutionRecord();
        completed.setOperationId("OP-1");
        completed.setStatus("COMPLETED");
        when(executionRecordRepository.findByOperationIdIn(any())).thenReturn(List.of(completed));

        List<EventImpact> impacts = impactCalculator.computeBreakdownImpacts(breakdownEvent(60));

        assertTrue(impacts.isEmpty());
    }

    @Test
    void computeBreakdownImpacts_endedBeforeOccurrence_skipped() {
        stubPublishedPlan(List.of(planOp("OP-1", "M1", "2026-09-16T08:00:00+08:00",
                "2026-09-16T09:00:00+08:00")));

        List<EventImpact> impacts = impactCalculator.computeBreakdownImpacts(breakdownEvent(60));

        assertTrue(impacts.isEmpty());
    }

    @Test
    void computeBreakdownImpacts_successorOutsideFreezeWindow_adjustable() {
        // OP-1 与维修区间重叠被重排；后继 OP-2 在 14:00，有发布计划但远离冻结窗口
        stubPublishedPlan(List.of(
                planOp("OP-1", "M1", "2026-09-16T09:30:00+08:00", "2026-09-16T10:30:00+08:00"),
                planOp("OP-2", "M2", "2026-09-16T14:00:00+08:00", "2026-09-16T15:00:00+08:00")));
        when(executionRecordRepository.findByOperationIdIn(any())).thenReturn(List.of());
        when(orderOperationRepository.findAllById(any()))
                .thenReturn(List.of(orderOp("OP-1", "ORD-1", 1)));
        when(orderOperationRepository.findByOrderIdOrderBySequenceNo("ORD-1"))
                .thenReturn(List.of(orderOp("OP-1", "ORD-1", 1), orderOp("OP-2", "ORD-1", 2)));

        List<EventImpact> impacts = impactCalculator.computeBreakdownImpacts(breakdownEvent(60));

        Map<String, EventImpact> byOp = byOperation(impacts);
        assertEquals(ImpactCalculator.SUCCESSOR, byOp.get("OP-2").getImpactType());
        assertEquals("ADJUSTABLE", byOp.get("OP-2").getLockType());
    }

    @Test
    void recordNewOrderImpacts_allOperationsAdjustable() {
        when(orderOperationRepository.findByOrderIdOrderBySequenceNo("ORD-1"))
                .thenReturn(List.of(orderOp("OP-1", "ORD-1", 1), orderOp("OP-2", "ORD-1", 2)));
        Event event = new Event();
        event.setId("EVT-2");
        event.setEventType(Event.TYPE_NEW_ORDER);

        impactCalculator.recordNewOrderImpacts(event, "ORD-1");

        ArgumentCaptor<EventImpact> captor = ArgumentCaptor.forClass(EventImpact.class);
        verify(eventImpactRepository, times(2)).save(captor.capture());
        for (EventImpact impact : captor.getAllValues()) {
            assertEquals(ImpactCalculator.NEW_ORDER, impact.getImpactType());
            assertEquals("ADJUSTABLE", impact.getLockType());
            assertEquals("NEW_OPERATION", impact.getReasonCode());
            assertEquals("EVT-2", impact.getEventId());
        }
    }

    @Test
    void currentPublishedPlan_picksLatestPublishedAt() {
        PlanVersion older = new PlanVersion();
        older.setId("PV-OLD");
        older.setStatus("PUBLISHED");
        older.setPublishedAt(OCCURRED.minusHours(5));
        PlanVersion newer = new PlanVersion();
        newer.setId("PV-NEW");
        newer.setStatus("EXECUTING");
        newer.setPublishedAt(OCCURRED.minusHours(1));
        when(planVersionRepository.findByStatusIn(List.of("PUBLISHED", "EXECUTING")))
                .thenReturn(List.of(older, newer));

        PlanVersion current = impactCalculator.currentPublishedPlan();

        assertEquals("PV-NEW", current.getId());
    }

    @Test
    void currentPublishedPlan_none_returnsNull() {
        when(planVersionRepository.findByStatusIn(List.of("PUBLISHED", "EXECUTING")))
                .thenReturn(List.of());

        assertNull(impactCalculator.currentPublishedPlan());
    }

    @Test
    void summarize_countsByType() {
        EventImpact a = new EventImpact();
        a.setImpactType(ImpactCalculator.SAME_MACHINE_CONFLICT);
        EventImpact b = new EventImpact();
        b.setImpactType(ImpactCalculator.SAME_MACHINE_CONFLICT);
        EventImpact c = new EventImpact();
        c.setImpactType(ImpactCalculator.SUCCESSOR);

        ImpactSummaryResponse summary = impactCalculator.summarize(List.of(a, b, c));

        assertEquals(3, summary.total());
        assertEquals(2L, summary.byType().get(ImpactCalculator.SAME_MACHINE_CONFLICT));
        assertEquals(1L, summary.byType().get(ImpactCalculator.SUCCESSOR));
    }

    // ---- reschedulePreview（F-08 影响范围预览） ----

    private EventImpact impact(String opId, String lockType) {
        EventImpact impact = new EventImpact();
        impact.setId("IMP-" + opId);
        impact.setEventId("EVT-1");
        impact.setOperationId(opId);
        impact.setImpactType(ImpactCalculator.MACHINE_BREAKDOWN);
        impact.setLockType(lockType);
        return impact;
    }

    private static ReschedulePreviewResponse.ModeEstimate modeEstimates(
            ReschedulePreviewResponse preview, String mode) {
        return preview.modeEstimates().get(mode);
    }

    @Test
    void reschedulePreview_computesLockCountsAndModeEstimates() {
        // OP-1 加工中（硬锁定）；OP-2 在冻结窗口内且未受影响（硬锁定）；
        // OP-3 受影响且未开始（局部可调）；OP-4 未受影响未开始（软锁定）；OP-9 为新订单工序（不在原计划内）
        stubPublishedPlan(List.of(
                planOp("OP-1", "M1", "2026-09-16T09:00:00+08:00", "2026-09-16T10:30:00+08:00"),
                planOp("OP-2", "M2", "2026-09-16T10:10:00+08:00", "2026-09-16T11:00:00+08:00"),
                planOp("OP-3", "M2", "2026-09-16T12:00:00+08:00", "2026-09-16T13:00:00+08:00"),
                planOp("OP-4", "M3", "2026-09-16T14:00:00+08:00", "2026-09-16T15:00:00+08:00")));
        ExecutionRecord running = new ExecutionRecord();
        running.setOperationId("OP-1");
        running.setStatus("RUNNING");
        when(executionRecordRepository.findByOperationIdIn(any())).thenReturn(List.of(running));
        when(eventImpactRepository.findByEventId("EVT-1"))
                .thenReturn(List.of(impact("OP-3", "ADJUSTABLE"), impact("OP-9", "ADJUSTABLE")));
        when(orderOperationRepository.findAllById(any()))
                .thenReturn(List.of(orderOp("OP-3", "ORD-1", 2), orderOp("OP-9", "ORD-2", 1)));

        ReschedulePreviewResponse preview = impactCalculator.reschedulePreview(breakdownEvent(60), null, null);

        assertEquals("PV-1", preview.planVersionId());
        assertEquals(30, preview.freezeWindowMinutes());
        assertEquals(2, preview.hardLockedCount());
        assertEquals(1, preview.softLockedCount());
        assertEquals(2, preview.impactedOperationCount());
        assertEquals(List.of("ORD-1", "ORD-2"), preview.impactedOrders());
        assertEquals(2, preview.impactedOrderCount());
        // 局部：影响集合内未开始工序 OP-3 + 新订单 OP-9
        assertEquals(2, modeEstimates(preview, "LOCAL_RESCHEDULE").estimatedOperationCount());
        // 完全：局部可调 + 软锁定 OP-4
        assertEquals(3, modeEstimates(preview, "FULL_RESCHEDULE").estimatedOperationCount());
    }

    @Test
    void reschedulePreview_zeroFreezeWindow_unfreezesFutureOps() {
        stubPublishedPlan(List.of(
                planOp("OP-2", "M2", "2026-09-16T10:10:00+08:00", "2026-09-16T11:00:00+08:00")));
        when(eventImpactRepository.findByEventId("EVT-1")).thenReturn(List.of());

        ReschedulePreviewResponse preview = impactCalculator.reschedulePreview(breakdownEvent(60), null, 0);

        assertEquals(0, preview.hardLockedCount());
        assertEquals(1, preview.softLockedCount());
        assertEquals(0, modeEstimates(preview, "LOCAL_RESCHEDULE").estimatedOperationCount());
        assertEquals(1, modeEstimates(preview, "FULL_RESCHEDULE").estimatedOperationCount());
    }

    @Test
    void reschedulePreview_explicitPlanVersion_used() {
        when(planVersionRepository.findById("PV-1")).thenReturn(Optional.of(publishedPlan()));
        when(scheduleOperationRepository.findByPlanVersionId("PV-1")).thenReturn(List.of());
        when(eventImpactRepository.findByEventId("EVT-1")).thenReturn(List.of());

        ReschedulePreviewResponse preview = impactCalculator.reschedulePreview(breakdownEvent(60), "PV-1", null);

        assertEquals("PV-1", preview.planVersionId());
        assertEquals(0, preview.hardLockedCount());
    }

    @Test
    void reschedulePreview_noPublishedPlan_stateConflict() {
        when(planVersionRepository.findByStatusIn(List.of("PUBLISHED", "EXECUTING")))
                .thenReturn(List.of());

        BizException e = org.junit.jupiter.api.Assertions.assertThrows(BizException.class,
                () -> impactCalculator.reschedulePreview(breakdownEvent(60), null, null));

        assertEquals("E_STATE_CONFLICT", e.getCode());
    }

    @Test
    void reschedulePreview_freezeWindowOutOfRange_rejected() {
        when(planVersionRepository.findByStatusIn(List.of("PUBLISHED", "EXECUTING")))
                .thenReturn(List.of(publishedPlan()));

        BizException e = org.junit.jupiter.api.Assertions.assertThrows(BizException.class,
                () -> impactCalculator.reschedulePreview(breakdownEvent(60), null, 1441));

        assertEquals("E_VALIDATION", e.getCode());
    }
}
