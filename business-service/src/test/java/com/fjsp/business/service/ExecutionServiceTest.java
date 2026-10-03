package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import com.fjsp.business.common.BizException;
import com.fjsp.business.dto.ExecutionRequest;
import com.fjsp.business.entity.ExecutionRecord;
import com.fjsp.business.entity.OrderOperation;
import com.fjsp.business.entity.PlanVersion;
import com.fjsp.business.entity.ProductionOrder;
import com.fjsp.business.entity.ScheduleOperation;
import com.fjsp.business.repository.ExecutionRecordRepository;
import com.fjsp.business.repository.OrderOperationRepository;
import com.fjsp.business.repository.PlanVersionRepository;
import com.fjsp.business.repository.ProductionOrderRepository;
import com.fjsp.business.repository.ScheduleOperationRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.Spy;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class ExecutionServiceTest {

    @Mock
    private ExecutionRecordRepository executionRecordRepository;
    @Mock
    private PlanVersionRepository planVersionRepository;
    @Mock
    private ScheduleOperationRepository scheduleOperationRepository;
    @Mock
    private OrderOperationRepository orderOperationRepository;
    @Mock
    private ProductionOrderRepository productionOrderRepository;
    @Mock
    private ImpactCalculator impactCalculator;
    @Mock
    private AuditService auditService;
    @Spy
    private PlanStateMachine planStateMachine = new PlanStateMachine();

    @InjectMocks
    private ExecutionService executionService;

    private OrderOperation operation() {
        OrderOperation oo = new OrderOperation();
        oo.setId("OP-1");
        oo.setOrderId("ORD-1");
        oo.setStatus("NOT_STARTED");
        return oo;
    }

    private PlanVersion publishedPlan() {
        PlanVersion pv = new PlanVersion();
        pv.setId("PV-1");
        pv.setVersionCode("PV-001");
        pv.setStatus("PUBLISHED");
        return pv;
    }

    private ScheduleOperation plannedOp() {
        ScheduleOperation op = new ScheduleOperation();
        op.setPlanVersionId("PV-1");
        op.setOperationId("OP-1");
        op.setMachineId("M1");
        op.setStartAt(OffsetDateTime.parse("2026-09-16T08:00:00+08:00"));
        op.setEndAt(OffsetDateTime.parse("2026-09-16T09:00:00+08:00"));
        return op;
    }

    private void stubPlannedOperation() {
        OrderOperation oo = operation();
        when(orderOperationRepository.findById("OP-1")).thenReturn(Optional.of(oo));
        when(impactCalculator.currentPublishedPlan()).thenReturn(publishedPlan());
        when(scheduleOperationRepository.findByPlanVersionIdAndOperationId("PV-1", "OP-1"))
                .thenReturn(Optional.of(plannedOp()));
    }

    @Test
    void feedback_invalidStatus_validation() {
        BizException e = assertThrows(BizException.class,
                () -> executionService.feedback("OP-1", new ExecutionRequest("PAUSED", null, null, null)));
        assertEquals("E_VALIDATION", e.getCode());
    }

    @Test
    void feedback_operationNotFound_notFound() {
        when(orderOperationRepository.findById("OP-1")).thenReturn(Optional.empty());

        BizException e = assertThrows(BizException.class,
                () -> executionService.feedback("OP-1", new ExecutionRequest("RUNNING", null, null, null)));
        assertEquals("E_NOT_FOUND", e.getCode());
    }

    @Test
    void feedback_noPublishedPlan_stateConflict() {
        when(orderOperationRepository.findById("OP-1")).thenReturn(Optional.of(operation()));
        when(impactCalculator.currentPublishedPlan()).thenReturn(null);

        BizException e = assertThrows(BizException.class,
                () -> executionService.feedback("OP-1", new ExecutionRequest("RUNNING", null, null, null)));
        assertEquals("E_STATE_CONFLICT", e.getCode());
    }

    @Test
    void feedback_running_createsRecordAndUpdatesStates() {
        stubPlannedOperation();
        when(executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(
                "OP-1", "RUNNING")).thenReturn(Optional.empty());
        when(executionRecordRepository.existsByOperationIdAndStatus("OP-1", "COMPLETED"))
                .thenReturn(false);
        ProductionOrder order = new ProductionOrder();
        order.setId("ORD-1");
        order.setStatus("SCHEDULED");
        when(productionOrderRepository.findById("ORD-1")).thenReturn(Optional.of(order));

        Map<String, Object> data = executionService.feedback("OP-1",
                new ExecutionRequest("RUNNING", null, null, null));

        verify(executionRecordRepository).save(any(ExecutionRecord.class));
        assertEquals("RUNNING", data.get("status"));
        // 发布计划进入执行中
        verify(planVersionRepository).save(any(PlanVersion.class));
        // 工序与订单状态联动
        verify(orderOperationRepository).save(any(OrderOperation.class));
        verify(productionOrderRepository).save(order);
        assertEquals("RUNNING", order.getStatus());
    }

    @Test
    void feedback_alreadyRunning_stateConflict() {
        stubPlannedOperation();
        ExecutionRecord open = new ExecutionRecord();
        open.setOperationId("OP-1");
        open.setStatus("RUNNING");
        when(executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(
                "OP-1", "RUNNING")).thenReturn(Optional.of(open));

        BizException e = assertThrows(BizException.class,
                () -> executionService.feedback("OP-1", new ExecutionRequest("RUNNING", null, null, null)));
        assertEquals("E_STATE_CONFLICT", e.getCode());
        verify(executionRecordRepository, never()).save(any());
    }

    @Test
    void feedback_completedCannotRestart_stateConflict() {
        // 已完成工序不能变更：再次反馈 RUNNING 必须拒绝
        stubPlannedOperation();
        when(executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(
                "OP-1", "RUNNING")).thenReturn(Optional.empty());
        when(executionRecordRepository.existsByOperationIdAndStatus("OP-1", "COMPLETED"))
                .thenReturn(true);

        BizException e = assertThrows(BizException.class,
                () -> executionService.feedback("OP-1", new ExecutionRequest("RUNNING", null, null, null)));
        assertEquals("E_STATE_CONFLICT", e.getCode());
        verify(executionRecordRepository, never()).save(any());
    }

    @Test
    void feedback_completedWithoutRunning_stateConflict() {
        stubPlannedOperation();
        when(executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(
                "OP-1", "RUNNING")).thenReturn(Optional.empty());

        BizException e = assertThrows(BizException.class,
                () -> executionService.feedback("OP-1",
                        new ExecutionRequest("COMPLETED", null, null, null)));
        assertEquals("E_STATE_CONFLICT", e.getCode());
    }

    @Test
    void feedback_endBeforeStart_validation() {
        stubPlannedOperation();
        ExecutionRecord running = new ExecutionRecord();
        running.setOperationId("OP-1");
        running.setStatus("RUNNING");
        running.setActualStartAt(OffsetDateTime.parse("2026-09-16T10:00:00+08:00"));
        when(executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(
                "OP-1", "RUNNING")).thenReturn(Optional.of(running));

        BizException e = assertThrows(BizException.class,
                () -> executionService.feedback("OP-1", new ExecutionRequest("COMPLETED", null,
                        "2026-09-16T09:00:00+08:00", null)));
        assertEquals("E_VALIDATION", e.getCode());
    }

    @Test
    void feedback_completed_closesRecord() {
        OrderOperation oo = operation();
        oo.setStatus("RUNNING");
        when(orderOperationRepository.findById("OP-1")).thenReturn(Optional.of(oo));
        when(impactCalculator.currentPublishedPlan()).thenReturn(publishedPlan());
        when(scheduleOperationRepository.findByPlanVersionIdAndOperationId("PV-1", "OP-1"))
                .thenReturn(Optional.of(plannedOp()));
        ExecutionRecord running = new ExecutionRecord();
        running.setOperationId("OP-1");
        running.setStatus("RUNNING");
        running.setActualStartAt(OffsetDateTime.parse("2026-09-16T08:10:00+08:00"));
        when(executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(
                "OP-1", "RUNNING")).thenReturn(Optional.of(running));
        when(orderOperationRepository.findByOrderIdOrderBySequenceNo("ORD-1"))
                .thenReturn(List.of(oo));
        ProductionOrder order = new ProductionOrder();
        order.setId("ORD-1");
        order.setStatus("RUNNING");
        when(productionOrderRepository.findById("ORD-1")).thenReturn(Optional.of(order));

        Map<String, Object> data = executionService.feedback("OP-1",
                new ExecutionRequest("COMPLETED", null, "2026-09-16T08:50:00+08:00", null));

        assertEquals("COMPLETED", running.getStatus());
        assertNotNull(running.getActualEndAt());
        assertEquals("COMPLETED", oo.getStatus());
        assertEquals("COMPLETED", data.get("status"));
        // 订单全部工序完成 → 订单完成
        assertEquals("COMPLETED", order.getStatus());
        verify(productionOrderRepository).save(order);
    }
}
