package com.fjsp.business.service;

import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import com.fjsp.business.common.BizException;
import com.fjsp.business.config.FjspProperties;
import com.fjsp.business.dto.PlanVersionSummaryResponse;
import com.fjsp.business.dto.RollbackRequest;
import com.fjsp.business.entity.ExecutionRecord;
import com.fjsp.business.entity.PlanVersion;
import com.fjsp.business.entity.ScheduleOperation;
import com.fjsp.business.repository.ExecutionRecordRepository;
import com.fjsp.business.repository.PlanVersionRepository;
import com.fjsp.business.repository.ScheduleOperationRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.Spy;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class PlanRollbackServiceTest {

    @Mock
    private PlanVersionRepository planVersionRepository;
    @Mock
    private ScheduleOperationRepository scheduleOperationRepository;
    @Mock
    private ExecutionRecordRepository executionRecordRepository;
    @Mock
    private AuditService auditService;
    @Spy
    private CodeGenerator codeGenerator = new CodeGenerator();
    @Mock
    private FjspProperties properties;
    @Spy
    private PlanVersionMapper planVersionMapper = new PlanVersionMapper();

    @InjectMocks
    private PlanRollbackService planRollbackService;

    private PlanVersion plan(String id, String status, long version) {
        PlanVersion pv = new PlanVersion();
        pv.setId(id);
        pv.setVersionCode("PV-" + id);
        pv.setStatus(status);
        pv.setVersion(version);
        return pv;
    }

    // ---------- 回滚（SUPERSEDED → 新 DRAFT） ----------

    private ScheduleOperation scheduledOp(String planId, String opId, String machineId,
                                          String startAt, String endAt) {
        ScheduleOperation op = new ScheduleOperation();
        op.setPlanVersionId(planId);
        op.setOperationId(opId);
        op.setMachineId(machineId);
        op.setStartAt(OffsetDateTime.parse(startAt));
        op.setEndAt(OffsetDateTime.parse(endAt));
        return op;
    }

    private ExecutionRecord record(String opId, String status, String actualStartAt) {
        ExecutionRecord r = new ExecutionRecord();
        r.setOperationId(opId);
        r.setStatus(status);
        r.setActualStartAt(actualStartAt != null ? OffsetDateTime.parse(actualStartAt) : null);
        return r;
    }

    @Test
    void rollback_notSuperseded_stateConflict() {
        PlanVersion pv = plan("P1", "PUBLISHED", 4L);
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(pv));

        BizException e = assertThrows(BizException.class,
                () -> planRollbackService.rollback("P1", new RollbackRequest("恢复上周计划")));
        assertEquals("E_STATE_CONFLICT", e.getCode());
        verify(planVersionRepository, never()).save(any());
    }

    @Test
    void rollback_blankRemark_validation() {
        PlanVersion pv = plan("P1", "SUPERSEDED", 4L);
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(pv));

        BizException e = assertThrows(BizException.class,
                () -> planRollbackService.rollback("P1", new RollbackRequest(" ")));
        assertEquals("E_VALIDATION", e.getCode());
    }

    @Test
    void rollback_completedOpMismatch_conflict() {
        // 历史快照把已完成工序排到了别的机台：不可调和冲突，不生成草稿
        PlanVersion hist = plan("P1", "SUPERSEDED", 4L);
        PlanVersion cur = plan("P2", "EXECUTING", 6L);
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(hist));
        when(scheduleOperationRepository.findByPlanVersionId("P1"))
                .thenReturn(List.of(scheduledOp("P1", "OP-1", "M2",
                        "2026-09-16T08:00:00+08:00", "2026-09-16T09:00:00+08:00")));
        when(planVersionRepository.findByStatusIn(List.of("PUBLISHED", "EXECUTING")))
                .thenReturn(List.of(cur));
        when(properties.getFreezeWindow()).thenReturn(Duration.ofMinutes(30));
        when(scheduleOperationRepository.findByPlanVersionId("P2"))
                .thenReturn(List.of(scheduledOp("P2", "OP-1", "M1",
                        "2026-09-16T08:00:00+08:00", "2026-09-16T09:00:00+08:00")));
        when(executionRecordRepository.findByOperationIdIn(List.of("OP-1")))
                .thenReturn(List.of(record("OP-1", "COMPLETED", "2026-09-16T08:00:00+08:00")));

        BizException e = assertThrows(BizException.class,
                () -> planRollbackService.rollback("P1", new RollbackRequest("恢复上周计划")));
        assertEquals("E_ROLLBACK_CONFLICT", e.getCode());
        verify(planVersionRepository, never()).save(any());
    }

    @Test
    void rollback_completedOpMissing_conflict() {
        PlanVersion hist = plan("P1", "SUPERSEDED", 4L);
        PlanVersion cur = plan("P2", "EXECUTING", 6L);
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(hist));
        when(scheduleOperationRepository.findByPlanVersionId("P1")).thenReturn(List.of());
        when(planVersionRepository.findByStatusIn(List.of("PUBLISHED", "EXECUTING")))
                .thenReturn(List.of(cur));
        when(properties.getFreezeWindow()).thenReturn(Duration.ofMinutes(30));
        when(scheduleOperationRepository.findByPlanVersionId("P2"))
                .thenReturn(List.of(scheduledOp("P2", "OP-1", "M1",
                        "2026-09-16T08:00:00+08:00", "2026-09-16T09:00:00+08:00")));
        when(executionRecordRepository.findByOperationIdIn(List.of("OP-1")))
                .thenReturn(List.of(record("OP-1", "COMPLETED", "2026-09-16T08:00:00+08:00")));

        BizException e = assertThrows(BizException.class,
                () -> planRollbackService.rollback("P1", new RollbackRequest("恢复上周计划")));
        assertEquals("E_ROLLBACK_CONFLICT", e.getCode());
    }

    @Test
    void rollback_runningOpStartMismatch_conflict() {
        // 加工中工序实际开工即事实，历史快照开始时间对不上即冲突
        PlanVersion hist = plan("P1", "SUPERSEDED", 4L);
        PlanVersion cur = plan("P2", "EXECUTING", 6L);
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(hist));
        when(scheduleOperationRepository.findByPlanVersionId("P1"))
                .thenReturn(List.of(scheduledOp("P1", "OP-1", "M1",
                        "2026-09-16T08:30:00+08:00", "2026-09-16T09:30:00+08:00")));
        when(planVersionRepository.findByStatusIn(List.of("PUBLISHED", "EXECUTING")))
                .thenReturn(List.of(cur));
        when(properties.getFreezeWindow()).thenReturn(Duration.ofMinutes(30));
        when(scheduleOperationRepository.findByPlanVersionId("P2"))
                .thenReturn(List.of(scheduledOp("P2", "OP-1", "M1",
                        "2026-09-16T08:00:00+08:00", "2026-09-16T09:00:00+08:00")));
        when(executionRecordRepository.findByOperationIdIn(List.of("OP-1")))
                .thenReturn(List.of(record("OP-1", "RUNNING", "2026-09-16T08:00:00+08:00")));

        BizException e = assertThrows(BizException.class,
                () -> planRollbackService.rollback("P1", new RollbackRequest("恢复上周计划")));
        assertEquals("E_ROLLBACK_CONFLICT", e.getCode());
    }

    @Test
    void rollback_noConflict_createsDraftWithHardLockOverlay() {
        // OP-1 已完成（快照一致）、OP-2 加工中（快照与实际开工一致）→ 叠加当前硬锁定安排并置 frozen
        PlanVersion hist = plan("P1", "SUPERSEDED", 4L);
        PlanVersion cur = plan("P2", "EXECUTING", 6L);
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(hist));
        when(scheduleOperationRepository.findByPlanVersionId("P1"))
                .thenReturn(List.of(
                        scheduledOp("P1", "OP-1", "M1", "2026-09-16T08:00:00+08:00", "2026-09-16T09:00:00+08:00"),
                        scheduledOp("P1", "OP-2", "M1", "2026-09-16T09:00:00+08:00", "2026-09-16T10:00:00+08:00"),
                        scheduledOp("P1", "OP-3", "M2", "2026-09-16T10:00:00+08:00", "2026-09-16T11:00:00+08:00")));
        when(planVersionRepository.findByStatusIn(List.of("PUBLISHED", "EXECUTING")))
                .thenReturn(List.of(cur));
        when(properties.getFreezeWindow()).thenReturn(Duration.ofMinutes(30));
        when(scheduleOperationRepository.findByPlanVersionId("P2"))
                .thenReturn(List.of(
                        scheduledOp("P2", "OP-1", "M1", "2026-09-16T08:00:00+08:00", "2026-09-16T09:00:00+08:00"),
                        scheduledOp("P2", "OP-2", "M1", "2026-09-16T09:00:00+08:00", "2026-09-16T10:00:00+08:00")));
        when(executionRecordRepository.findByOperationIdIn(any()))
                .thenReturn(List.of(
                        record("OP-1", "COMPLETED", "2026-09-16T08:00:00+08:00"),
                        record("OP-2", "RUNNING", "2026-09-16T09:00:00+08:00")));
        org.mockito.Mockito.doReturn("PV-010").when(codeGenerator).next("PV");

        PlanVersionSummaryResponse data = planRollbackService.rollback("P1", new RollbackRequest("新版本延期严重，回退"));

        assertEquals("DRAFT", data.status());
        assertEquals("PV-010", data.versionCode());
        assertEquals("P2", data.parentId());
        assertEquals("ROLLBACK", data.candidateType());
        org.mockito.ArgumentCaptor<List<ScheduleOperation>> captor = org.mockito.ArgumentCaptor.forClass(List.class);
        verify(scheduleOperationRepository).saveAll(captor.capture());
        List<ScheduleOperation> saved = captor.getValue();
        assertEquals(3, saved.size());
        Map<String, ScheduleOperation> byOp = new java.util.HashMap<>();
        saved.forEach(o -> byOp.put(o.getOperationId(), o));
        assertEquals(Boolean.TRUE, byOp.get("OP-1").getFrozen());
        assertEquals(Boolean.TRUE, byOp.get("OP-2").getFrozen());
        assertEquals(OffsetDateTime.parse("2026-09-16T09:00:00+08:00"), byOp.get("OP-2").getStartAt());
        assertEquals(Boolean.FALSE, byOp.get("OP-3").getFrozen());
        assertEquals("M2", byOp.get("OP-3").getMachineId());
        verify(auditService).record(org.mockito.ArgumentMatchers.eq("PLAN_ROLLBACK"),
                org.mockito.ArgumentMatchers.eq("plan_version"), any(), any());
    }

    @Test
    void rollback_noCurrentPlan_copiesSnapshotAsDraft() {
        // 无当前生效版本时无硬锁定约束，纯复制历史快照
        PlanVersion hist = plan("P1", "SUPERSEDED", 4L);
        when(planVersionRepository.findById("P1")).thenReturn(Optional.of(hist));
        when(scheduleOperationRepository.findByPlanVersionId("P1"))
                .thenReturn(List.of(scheduledOp("P1", "OP-1", "M1",
                        "2026-09-16T08:00:00+08:00", "2026-09-16T09:00:00+08:00")));
        when(planVersionRepository.findByStatusIn(List.of("PUBLISHED", "EXECUTING")))
                .thenReturn(List.of());
        when(properties.getFreezeWindow()).thenReturn(Duration.ofMinutes(30));
        org.mockito.Mockito.doReturn("PV-001").when(codeGenerator).next("PV");

        PlanVersionSummaryResponse data = planRollbackService.rollback("P1", new RollbackRequest("全部作废后重建"));

        assertEquals("DRAFT", data.status());
        assertEquals("PV-001", data.versionCode());
        assertNull(data.parentId());
        verify(scheduleOperationRepository).saveAll(any());
    }
}
