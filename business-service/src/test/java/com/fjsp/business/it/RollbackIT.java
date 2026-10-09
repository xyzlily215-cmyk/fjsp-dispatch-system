package com.fjsp.business.it;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

import com.fjsp.business.common.BizException;
import com.fjsp.business.dto.PlanVersionSummaryResponse;
import com.fjsp.business.dto.RollbackRequest;
import com.fjsp.business.entity.ExecutionRecord;
import com.fjsp.business.entity.PlanVersion;
import com.fjsp.business.entity.ScheduleOperation;
import com.fjsp.business.repository.ExecutionRecordRepository;
import com.fjsp.business.repository.PlanVersionRepository;
import com.fjsp.business.repository.ScheduleOperationRepository;
import com.fjsp.business.service.PlanStateMachine;
import com.fjsp.business.service.PlanVersionService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 回滚（决策 4）真实 DB 版：复制历史快照生成新 DRAFT，硬锁定冲突时拒绝且不落库。 */
class RollbackIT extends AbstractPostgresIT {

    @Autowired
    private PlanVersionService planVersionService;
    @Autowired
    private PlanVersionRepository planVersionRepository;
    @Autowired
    private ScheduleOperationRepository scheduleOperationRepository;
    @Autowired
    private ExecutionRecordRepository executionRecordRepository;

    @AfterEach
    void cleanup() {
        executionRecordRepository.deleteAll();
        scheduleOperationRepository.deleteAll();
        planVersionRepository.deleteAll();
    }

    private PlanVersion saveVersion(String code, String status) {
        PlanVersion pv = new PlanVersion();
        pv.setId(UUID.randomUUID().toString());
        pv.setVersionCode(code);
        pv.setCandidateType("BASELINE");
        pv.setStatus(status);
        return planVersionRepository.saveAndFlush(pv);
    }

    private ScheduleOperation saveOp(PlanVersion pv, String opId, String machineId,
                                     String startAt, String endAt) {
        ScheduleOperation op = new ScheduleOperation();
        op.setId(UUID.randomUUID().toString());
        op.setPlanVersionId(pv.getId());
        op.setOperationId(opId);
        op.setMachineId(machineId);
        op.setStartAt(OffsetDateTime.parse(startAt));
        op.setEndAt(OffsetDateTime.parse(endAt));
        return scheduleOperationRepository.saveAndFlush(op);
    }

    private ExecutionRecord saveRecord(PlanVersion pv, String opId, String status, String actualStartAt) {
        ExecutionRecord r = new ExecutionRecord();
        r.setId(UUID.randomUUID().toString());
        r.setPlanVersionId(pv.getId());
        r.setOperationId(opId);
        r.setStatus(status);
        r.setActualStartAt(actualStartAt != null ? OffsetDateTime.parse(actualStartAt) : null);
        return executionRecordRepository.saveAndFlush(r);
    }

    @Test
    void rollback_completedOpMismatch_conflictAndNoDraft() {
        PlanVersion hist = saveVersion("PV-IT-H1", PlanStateMachine.SUPERSEDED);
        saveOp(hist, "OP-IT-1", "M2", "2026-09-16T08:00:00+08:00", "2026-09-16T09:00:00+08:00");
        PlanVersion cur = saveVersion("PV-IT-C1", PlanStateMachine.EXECUTING);
        saveOp(cur, "OP-IT-1", "M1", "2026-09-16T08:00:00+08:00", "2026-09-16T09:00:00+08:00");
        saveRecord(cur, "OP-IT-1", "COMPLETED", "2026-09-16T08:00:00+08:00");

        BizException e = assertThrows(BizException.class,
                () -> planVersionService.rollback(hist.getId(), new RollbackRequest("回退验证")));
        assertEquals("E_ROLLBACK_CONFLICT", e.getCode());
        assertTrue(e.getMessage().contains("OP-IT-1"), "冲突明细应包含工序号: " + e.getMessage());
        assertEquals(2, planVersionRepository.findAll().size(), "冲突时不得生成草稿");
    }

    @Test
    void rollback_noConflict_createsDraftWithHardLockOverlay() {
        PlanVersion hist = saveVersion("PV-IT-H2", PlanStateMachine.SUPERSEDED);
        saveOp(hist, "OP-IT-1", "M1", "2026-09-16T08:00:00+08:00", "2026-09-16T09:00:00+08:00");
        saveOp(hist, "OP-IT-2", "M2", "2026-09-16T09:00:00+08:00", "2026-09-16T10:00:00+08:00");
        PlanVersion cur = saveVersion("PV-IT-C2", PlanStateMachine.EXECUTING);
        saveOp(cur, "OP-IT-1", "M1", "2026-09-16T08:00:00+08:00", "2026-09-16T09:00:00+08:00");
        saveRecord(cur, "OP-IT-1", "COMPLETED", "2026-09-16T08:00:00+08:00");

        PlanVersionSummaryResponse data = planVersionService.rollback(hist.getId(), new RollbackRequest("回退验证"));

        assertEquals(PlanStateMachine.DRAFT, data.status());
        assertEquals(cur.getId(), data.parentId());
        PlanVersion draft = planVersionRepository.findById(data.id()).orElseThrow();
        assertEquals("ROLLBACK", draft.getCandidateType());
        List<ScheduleOperation> ops = scheduleOperationRepository.findByPlanVersionId(draft.getId());
        assertEquals(2, ops.size());
        ScheduleOperation locked = ops.stream()
                .filter(o -> o.getOperationId().equals("OP-IT-1")).findFirst().orElseThrow();
        assertTrue(locked.getFrozen(), "硬锁定工序应置 frozen");
        assertEquals("M1", locked.getMachineId());
        ScheduleOperation free = ops.stream()
                .filter(o -> o.getOperationId().equals("OP-IT-2")).findFirst().orElseThrow();
        assertEquals(Boolean.FALSE, free.getFrozen());
        assertEquals("M2", free.getMachineId());
    }
}
