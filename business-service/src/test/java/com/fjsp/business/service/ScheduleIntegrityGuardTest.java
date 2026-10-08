package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.List;

import com.fjsp.business.common.BizException;
import com.fjsp.business.config.FjspProperties;
import com.fjsp.business.entity.ExecutionRecord;
import com.fjsp.business.entity.PlanVersion;
import com.fjsp.business.entity.ScheduleOperation;
import com.fjsp.business.repository.EventImpactRepository;
import com.fjsp.business.repository.EventRepository;
import com.fjsp.business.repository.ExecutionRecordRepository;
import com.fjsp.business.repository.InputSnapshotRepository;
import com.fjsp.business.repository.ScheduleOperationRepository;
import com.fjsp.business.repository.ScheduleTaskRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

/** 执行中（in_progress）工序的完整性校验：窗口以实际上报的开始时间为锚。 */
@ExtendWith(MockitoExtension.class)
class ScheduleIntegrityGuardTest {

    @Mock
    private ScheduleOperationRepository scheduleOperationRepository;
    @Mock
    private ExecutionRecordRepository executionRecordRepository;
    @Mock
    private EventImpactRepository eventImpactRepository;
    @Mock
    private EventRepository eventRepository;
    @Mock
    private ScheduleTaskRepository taskRepository;
    @Mock
    private InputSnapshotRepository inputSnapshotRepository;

    private ScheduleIntegrityGuard guard;

    private static final OffsetDateTime PLANNED_START = OffsetDateTime.parse("2026-09-16T09:00:00+08:00");
    private static final OffsetDateTime PLANNED_END = OffsetDateTime.parse("2026-09-16T10:00:00+08:00");
    // 实际开工晚于计划完工
    private static final OffsetDateTime ACTUAL_START = OffsetDateTime.parse("2026-09-16T10:15:00+08:00");

    @BeforeEach
    void setUp() {
        guard = new ScheduleIntegrityGuard(scheduleOperationRepository, executionRecordRepository,
                eventImpactRepository, eventRepository, taskRepository, inputSnapshotRepository,
                new FjspProperties());
    }

    private ScheduleOperation op(String opId, OffsetDateTime start, OffsetDateTime end) {
        ScheduleOperation op = new ScheduleOperation();
        op.setOperationId(opId);
        op.setMachineId("M-01");
        op.setStartAt(start);
        op.setEndAt(end);
        return op;
    }

    private PlanVersion candidateVersion(List<ScheduleOperation> oldOps) {
        PlanVersion pv = new PlanVersion();
        pv.setId("PV-NEW");
        pv.setParentId("PV-OLD");
        when(scheduleOperationRepository.findByPlanVersionId("PV-OLD")).thenReturn(oldOps);
        return pv;
    }

    private void runningRecord(String opId, OffsetDateTime actualStartAt) {
        ExecutionRecord record = new ExecutionRecord();
        record.setOperationId(opId);
        record.setStatus("RUNNING");
        record.setActualStartAt(actualStartAt);
        when(executionRecordRepository.findByOperationIdIn(any())).thenReturn(List.of(record));
    }

    @Test
    void inProgress_startAnchoredToActualStart_passes() {
        PlanVersion pv = candidateVersion(List.of(op("OP-1", PLANNED_START, PLANNED_END)));
        runningRecord("OP-1", ACTUAL_START);
        // 算法按剩余工时顺延的新窗口：start=actualStart，end>actualStart
        List<ScheduleOperation> cand = List.of(op("OP-1", ACTUAL_START, ACTUAL_START.plusMinutes(40)));
        assertDoesNotThrow(() -> guard.verifyAgainstExecution(pv, cand));
    }

    @Test
    void inProgress_startEqualsOldPlanButNotActual_rejected() {
        PlanVersion pv = candidateVersion(List.of(op("OP-1", PLANNED_START, PLANNED_END)));
        runningRecord("OP-1", ACTUAL_START);
        List<ScheduleOperation> cand = List.of(op("OP-1", PLANNED_START, PLANNED_END));
        BizException ex = assertThrows(BizException.class, () -> guard.verifyAgainstExecution(pv, cand));
        assertTrue(ex.getMessage().contains("开始时间与实际上报不一致"), ex.getMessage());
    }

    @Test
    void inProgress_endBeforeActualStart_rejected() {
        PlanVersion pv = candidateVersion(List.of(op("OP-1", PLANNED_START, PLANNED_END)));
        runningRecord("OP-1", ACTUAL_START);
        List<ScheduleOperation> cand = List.of(op("OP-1", ACTUAL_START, ACTUAL_START.minusMinutes(5)));
        BizException ex = assertThrows(BizException.class, () -> guard.verifyAgainstExecution(pv, cand));
        assertTrue(ex.getMessage().contains("结束时间早于实际开始时间"), ex.getMessage());
    }

    @Test
    void inProgress_withoutActualStart_keepsOldSemantics() {
        PlanVersion pv = candidateVersion(List.of(op("OP-1", PLANNED_START, PLANNED_END)));
        runningRecord("OP-1", null);
        assertDoesNotThrow(() -> guard.verifyAgainstExecution(pv,
                List.of(op("OP-1", PLANNED_START, PLANNED_END))));
        BizException ex = assertThrows(BizException.class, () -> guard.verifyAgainstExecution(pv,
                List.of(op("OP-1", PLANNED_START.plusMinutes(5), PLANNED_END))));
        assertTrue(ex.getMessage().contains("开始时间被修改"), ex.getMessage());
    }
}
