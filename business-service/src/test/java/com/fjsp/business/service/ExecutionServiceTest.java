package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;

import com.fjsp.business.common.BizException;
import com.fjsp.business.dto.ExecutionFeedbackResponse;
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
import org.springframework.dao.DataIntegrityViolationException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.lenient;
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
    @Mock
    private ConfigService configService;

    @InjectMocks
    private ExecutionService executionService;

    @org.junit.jupiter.api.BeforeEach
    void stubDeviationThreshold() {
        // 与原常量 15 分钟一致；偏离该值的行为由 ConfigServiceTest 覆盖
        lenient().when(configService.getLong(eq(ConfigService.EXECUTION_DEVIATION_THRESHOLD_MINUTES), anyLong()))
                .thenReturn(15L);
    }

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

    private ExecutionRecord openRunning() {
        ExecutionRecord running = new ExecutionRecord();
        running.setOperationId("OP-1");
        running.setStatus("RUNNING");
        running.setActualStartAt(OffsetDateTime.parse("2026-09-16T08:10:00+08:00"));
        return running;
    }

    private ExecutionRecord openPaused() {
        ExecutionRecord paused = new ExecutionRecord();
        paused.setOperationId("OP-1");
        paused.setStatus("PAUSED");
        paused.setOccurredAt(OffsetDateTime.parse("2026-09-16T08:30:00+08:00"));
        return paused;
    }

    @Test
    void feedback_invalidStatus_validation() {
        BizException e = assertThrows(BizException.class,
                () -> executionService.feedback("OP-1", new ExecutionRequest("HOLD", null, null, null, null)));
        assertEquals("E_VALIDATION", e.getCode());
    }

    @Test
    void feedback_operationNotFound_notFound() {
        when(orderOperationRepository.findById("OP-1")).thenReturn(Optional.empty());

        BizException e = assertThrows(BizException.class,
                () -> executionService.feedback("OP-1", new ExecutionRequest("RUNNING", null, null, null, null)));
        assertEquals("E_NOT_FOUND", e.getCode());
    }

    @Test
    void feedback_noPublishedPlan_stateConflict() {
        when(orderOperationRepository.findById("OP-1")).thenReturn(Optional.of(operation()));
        when(impactCalculator.currentPublishedPlan()).thenReturn(null);

        BizException e = assertThrows(BizException.class,
                () -> executionService.feedback("OP-1", new ExecutionRequest("RUNNING", null, null, null, null)));
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

        ExecutionFeedbackResponse data = executionService.feedback("OP-1",
                new ExecutionRequest("RUNNING", null, null, null, null));

        verify(executionRecordRepository).saveAndFlush(any(ExecutionRecord.class));
        assertEquals("RUNNING", data.status());
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
        when(executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(
                "OP-1", "RUNNING")).thenReturn(Optional.of(openRunning()));

        BizException e = assertThrows(BizException.class,
                () -> executionService.feedback("OP-1", new ExecutionRequest("RUNNING", null, null, null, null)));
        assertEquals("E_STATE_CONFLICT", e.getCode());
        verify(executionRecordRepository, never()).save(any());
    }

    @Test
    void feedback_concurrentRunning_uniqueIndexViolation_stateConflict() {
        // 两个并发 RUNNING 反馈同时通过"无进行中"检查：部分唯一索引在 flush 时拦截后者 → 409
        stubPlannedOperation();
        when(executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(
                "OP-1", "RUNNING")).thenReturn(Optional.empty());
        when(executionRecordRepository.existsByOperationIdAndStatus("OP-1", "COMPLETED"))
                .thenReturn(false);
        when(executionRecordRepository.saveAndFlush(any(ExecutionRecord.class)))
                .thenThrow(new DataIntegrityViolationException(
                        "duplicate key value violates unique constraint \"uq_execution_record_open_running\""));

        BizException e = assertThrows(BizException.class,
                () -> executionService.feedback("OP-1", new ExecutionRequest("RUNNING", null, null, null, null)));
        assertEquals("E_STATE_CONFLICT", e.getCode());
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
                () -> executionService.feedback("OP-1", new ExecutionRequest("RUNNING", null, null, null, null)));
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
                        new ExecutionRequest("COMPLETED", null, null, null, null)));
        assertEquals("E_STATE_CONFLICT", e.getCode());
    }

    @Test
    void feedback_endBeforeStart_validation() {
        stubPlannedOperation();
        ExecutionRecord running = openRunning();
        running.setActualStartAt(OffsetDateTime.parse("2026-09-16T10:00:00+08:00"));
        when(executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(
                "OP-1", "RUNNING")).thenReturn(Optional.of(running));
        when(executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(
                "OP-1", "PAUSED")).thenReturn(Optional.empty());

        BizException e = assertThrows(BizException.class,
                () -> executionService.feedback("OP-1", new ExecutionRequest("COMPLETED", null,
                        "2026-09-16T09:00:00+08:00", null, null)));
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
        ExecutionRecord running = openRunning();
        when(executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(
                "OP-1", "RUNNING")).thenReturn(Optional.of(running));
        when(executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(
                "OP-1", "PAUSED")).thenReturn(Optional.empty());
        when(orderOperationRepository.findByOrderIdOrderBySequenceNo("ORD-1"))
                .thenReturn(List.of(oo));
        ProductionOrder order = new ProductionOrder();
        order.setId("ORD-1");
        order.setStatus("RUNNING");
        when(productionOrderRepository.findById("ORD-1")).thenReturn(Optional.of(order));

        ExecutionFeedbackResponse data = executionService.feedback("OP-1",
                new ExecutionRequest("COMPLETED", null, "2026-09-16T08:50:00+08:00", null, null));

        assertEquals("COMPLETED", running.getStatus());
        assertNotNull(running.getActualEndAt());
        assertEquals("COMPLETED", oo.getStatus());
        assertEquals("COMPLETED", data.status());
        // 订单全部工序完成 → 订单完成
        assertEquals("COMPLETED", order.getStatus());
        verify(productionOrderRepository).save(order);
    }

    /* ---------------- 暂停 / 恢复 ---------------- */

    @Test
    void feedback_pauseRequiresReason_validation() {
        BizException e = assertThrows(BizException.class,
                () -> executionService.feedback("OP-1", new ExecutionRequest("PAUSED", null, null, null, null)));
        assertEquals("E_VALIDATION", e.getCode());
    }

    @Test
    void feedback_pauseWithoutRunning_stateConflict() {
        // 未开工不能暂停
        stubPlannedOperation();
        when(executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(
                "OP-1", "RUNNING")).thenReturn(Optional.empty());

        BizException e = assertThrows(BizException.class,
                () -> executionService.feedback("OP-1",
                        new ExecutionRequest("PAUSED", null, null, null, "设备等待物料")));
        assertEquals("E_STATE_CONFLICT", e.getCode());
        verify(executionRecordRepository, never()).save(any());
    }

    @Test
    void feedback_pauseWhenAlreadyPaused_stateConflict() {
        stubPlannedOperation();
        when(executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(
                "OP-1", "RUNNING")).thenReturn(Optional.of(openRunning()));
        when(executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(
                "OP-1", "PAUSED")).thenReturn(Optional.of(openPaused()));

        BizException e = assertThrows(BizException.class,
                () -> executionService.feedback("OP-1",
                        new ExecutionRequest("PAUSED", null, null, null, "设备等待物料")));
        assertEquals("E_STATE_CONFLICT", e.getCode());
    }

    @Test
    void feedback_pause_createsTimelineRecord() {
        OrderOperation oo = operation();
        oo.setStatus("RUNNING");
        when(orderOperationRepository.findById("OP-1")).thenReturn(Optional.of(oo));
        when(impactCalculator.currentPublishedPlan()).thenReturn(publishedPlan());
        when(scheduleOperationRepository.findByPlanVersionIdAndOperationId("PV-1", "OP-1"))
                .thenReturn(Optional.of(plannedOp()));
        when(executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(
                "OP-1", "RUNNING")).thenReturn(Optional.of(openRunning()));
        when(executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(
                "OP-1", "PAUSED")).thenReturn(Optional.empty());

        ExecutionFeedbackResponse data = executionService.feedback("OP-1",
                new ExecutionRequest("PAUSED", null, null, null, "设备等待物料"));

        verify(executionRecordRepository).saveAndFlush(any(ExecutionRecord.class));
        assertEquals("PAUSED", data.status());
        assertNotNull(data.occurredAt());
        assertEquals("PAUSED", oo.getStatus());
        // 暂停不触发 PUBLISHED -> EXECUTING 转换
        verify(planVersionRepository, never()).save(any());
    }

    @Test
    void feedback_concurrentPause_uniqueIndexViolation_stateConflict() {
        stubPlannedOperation();
        when(executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(
                "OP-1", "RUNNING")).thenReturn(Optional.of(openRunning()));
        when(executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(
                "OP-1", "PAUSED")).thenReturn(Optional.empty());
        when(executionRecordRepository.saveAndFlush(any(ExecutionRecord.class)))
                .thenThrow(new DataIntegrityViolationException(
                        "duplicate key value violates unique constraint \"uq_execution_record_open_pause\""));

        BizException e = assertThrows(BizException.class,
                () -> executionService.feedback("OP-1",
                        new ExecutionRequest("PAUSED", null, null, null, "设备等待物料")));
        assertEquals("E_STATE_CONFLICT", e.getCode());
    }

    @Test
    void feedback_resumeWithoutPause_stateConflict() {
        stubPlannedOperation();
        when(executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(
                "OP-1", "PAUSED")).thenReturn(Optional.empty());

        BizException e = assertThrows(BizException.class,
                () -> executionService.feedback("OP-1", new ExecutionRequest("RESUMED", null, null, null, null)));
        assertEquals("E_STATE_CONFLICT", e.getCode());
        verify(executionRecordRepository, never()).save(any());
    }

    @Test
    void feedback_resume_closesPauseAndReopensRunning() {
        OrderOperation oo = operation();
        oo.setStatus("PAUSED");
        when(orderOperationRepository.findById("OP-1")).thenReturn(Optional.of(oo));
        when(impactCalculator.currentPublishedPlan()).thenReturn(publishedPlan());
        when(scheduleOperationRepository.findByPlanVersionIdAndOperationId("PV-1", "OP-1"))
                .thenReturn(Optional.of(plannedOp()));
        ExecutionRecord paused = openPaused();
        when(executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(
                "OP-1", "PAUSED")).thenReturn(Optional.of(paused));

        ExecutionFeedbackResponse data = executionService.feedback("OP-1",
                new ExecutionRequest("RESUMED", null, null, null, null));

        assertEquals("RESUMED", data.status());
        // 暂停记录被回填解除时间，工序恢复加工中
        assertNotNull(paused.getActualEndAt());
        assertEquals("RUNNING", oo.getStatus());
    }

    @Test
    void feedback_completeWhilePaused_stateConflict() {
        // 暂停中不能完工，必须先恢复
        stubPlannedOperation();
        when(executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(
                "OP-1", "RUNNING")).thenReturn(Optional.of(openRunning()));
        when(executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(
                "OP-1", "PAUSED")).thenReturn(Optional.of(openPaused()));

        BizException e = assertThrows(BizException.class,
                () -> executionService.feedback("OP-1",
                        new ExecutionRequest("COMPLETED", null, null, null, null)));
        assertEquals("E_STATE_CONFLICT", e.getCode());
        verify(executionRecordRepository, never()).save(any());
    }

    /* ---------------- 异常反馈 ---------------- */

    @Test
    void feedback_exceptionRequiresReasonCode_validation() {
        BizException e = assertThrows(BizException.class,
                () -> executionService.feedback("OP-1",
                        new ExecutionRequest("EXCEPTION", null, null, null, "备注")));
        assertEquals("E_VALIDATION", e.getCode());
    }

    @Test
    void feedback_exceptionRequiresRemark_validation() {
        BizException e = assertThrows(BizException.class,
                () -> executionService.feedback("OP-1",
                        new ExecutionRequest("EXCEPTION", null, null, "MACHINE_BREAKDOWN", " ")));
        assertEquals("E_VALIDATION", e.getCode());
    }

    @Test
    void feedback_exceptionOnCompleted_stateConflict() {
        // 已完成记录的异常更正需要管理员审批，普通异常反馈拒绝
        stubPlannedOperation();
        when(executionRecordRepository.existsByOperationIdAndStatus("OP-1", "COMPLETED"))
                .thenReturn(true);

        BizException e = assertThrows(BizException.class,
                () -> executionService.feedback("OP-1",
                        new ExecutionRequest("EXCEPTION", null, null, "MACHINE_BREAKDOWN", "加工异常")));
        assertEquals("E_STATE_CONFLICT", e.getCode());
        verify(executionRecordRepository, never()).save(any());
    }

    @Test
    void feedback_exception_createsRecordWithoutStateChange() {
        stubPlannedOperation();
        when(executionRecordRepository.existsByOperationIdAndStatus("OP-1", "COMPLETED"))
                .thenReturn(false);

        ExecutionFeedbackResponse data = executionService.feedback("OP-1",
                new ExecutionRequest("EXCEPTION", null, null, "MACHINE_BREAKDOWN", "主轴异响停机"));

        verify(executionRecordRepository).save(any(ExecutionRecord.class));
        assertEquals("EXCEPTION", data.status());
        assertEquals("MACHINE_BREAKDOWN", data.reasonCode());
        assertNotNull(data.occurredAt());
        // 异常登记不触发 PUBLISHED -> EXECUTING 转换，也不改工序状态
        verify(planVersionRepository, never()).save(any());
        verify(orderOperationRepository, never()).save(any());
    }

    /* ---------------- 偏差识别 ---------------- */

    @Test
    void feedback_runningDeviationOverThreshold_marksExecutionDeviation() {
        // 计划 08:00 开工，实际 08:20：偏差 20 分钟 > 15 → EXECUTION_DEVIATION
        stubPlannedOperation();
        when(executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(
                "OP-1", "RUNNING")).thenReturn(Optional.empty());
        when(executionRecordRepository.existsByOperationIdAndStatus("OP-1", "COMPLETED"))
                .thenReturn(false);
        ProductionOrder order = new ProductionOrder();
        order.setId("ORD-1");
        order.setStatus("SCHEDULED");
        when(productionOrderRepository.findById("ORD-1")).thenReturn(Optional.of(order));

        ExecutionFeedbackResponse data = executionService.feedback("OP-1",
                new ExecutionRequest("RUNNING", "2026-09-16T08:20:00+08:00", null, null, null));

        assertEquals("EXECUTION_DEVIATION", data.reasonCode());
        assertEquals(20, data.deviationMinutes());
    }

    @Test
    void feedback_runningDeviationWithinThreshold_noMark() {
        // 偏差 10 分钟 ≤ 15：不生成偏差标记
        stubPlannedOperation();
        when(executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(
                "OP-1", "RUNNING")).thenReturn(Optional.empty());
        when(executionRecordRepository.existsByOperationIdAndStatus("OP-1", "COMPLETED"))
                .thenReturn(false);
        ProductionOrder order = new ProductionOrder();
        order.setId("ORD-1");
        order.setStatus("SCHEDULED");
        when(productionOrderRepository.findById("ORD-1")).thenReturn(Optional.of(order));

        ExecutionFeedbackResponse data = executionService.feedback("OP-1",
                new ExecutionRequest("RUNNING", "2026-09-16T08:10:00+08:00", null, null, null));

        assertNull(data.reasonCode());
        assertNull(data.deviationMinutes());
    }

    @Test
    void feedback_completedDeviationOverThreshold_marksExecutionDeviation() {
        // 计划 09:00 完工，实际 09:30：偏差 30 分钟 > 15 → EXECUTION_DEVIATION
        stubPlannedOperation();
        ExecutionRecord running = openRunning();
        when(executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(
                "OP-1", "RUNNING")).thenReturn(Optional.of(running));
        when(executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(
                "OP-1", "PAUSED")).thenReturn(Optional.empty());
        when(orderOperationRepository.findByOrderIdOrderBySequenceNo("ORD-1"))
                .thenReturn(List.of(operation()));
        ProductionOrder order = new ProductionOrder();
        order.setId("ORD-1");
        order.setStatus("RUNNING");
        when(productionOrderRepository.findById("ORD-1")).thenReturn(Optional.of(order));

        ExecutionFeedbackResponse data = executionService.feedback("OP-1",
                new ExecutionRequest("COMPLETED", null, "2026-09-16T09:30:00+08:00", null, null));

        assertEquals("EXECUTION_DEVIATION", running.getReasonCode());
        assertEquals(30, running.getDeviationMinutes());
        assertEquals("EXECUTION_DEVIATION", data.reasonCode());
    }

    @Test
    void feedback_completedDeviationKeepsLargerStartDeviation() {
        // 开工已标记 20 分钟偏差，完工偏差 16 分钟：保留较大值
        stubPlannedOperation();
        ExecutionRecord running = openRunning();
        running.setReasonCode("EXECUTION_DEVIATION");
        running.setDeviationMinutes(20);
        when(executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(
                "OP-1", "RUNNING")).thenReturn(Optional.of(running));
        when(executionRecordRepository.findFirstByOperationIdAndStatusAndActualEndAtIsNull(
                "OP-1", "PAUSED")).thenReturn(Optional.empty());
        when(orderOperationRepository.findByOrderIdOrderBySequenceNo("ORD-1"))
                .thenReturn(List.of(operation()));
        ProductionOrder order = new ProductionOrder();
        order.setId("ORD-1");
        order.setStatus("RUNNING");
        when(productionOrderRepository.findById("ORD-1")).thenReturn(Optional.of(order));

        executionService.feedback("OP-1",
                new ExecutionRequest("COMPLETED", null, "2026-09-16T09:16:00+08:00", null, null));

        assertEquals("EXECUTION_DEVIATION", running.getReasonCode());
        assertEquals(20, running.getDeviationMinutes());
    }
}
