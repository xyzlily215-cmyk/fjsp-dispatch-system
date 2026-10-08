package com.fjsp.business.it;

import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import com.fjsp.business.common.BizException;
import com.fjsp.business.dto.PublishRequest;
import com.fjsp.business.entity.PlanVersion;
import com.fjsp.business.repository.AuditLogRepository;
import com.fjsp.business.repository.IdempotencyRecordRepository;
import com.fjsp.business.repository.PlanVersionRepository;
import com.fjsp.business.service.AuditService;
import com.fjsp.business.service.IdempotencyService;
import com.fjsp.business.service.PlanVersionService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.mock.mockito.MockBean;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;

/** 场景 14（事务回滚）：发布中途异常 → 全部回滚；幂等键唯一约束真实生效。 */
class TransactionRollbackIT extends AbstractPostgresIT {

    @Autowired
    private PlanVersionService planVersionService;
    @Autowired
    private PlanVersionRepository planVersionRepository;
    @Autowired
    private AuditLogRepository auditLogRepository;
    @Autowired
    private IdempotencyService idempotencyService;
    @Autowired
    private IdempotencyRecordRepository idempotencyRecordRepository;

    @MockBean
    private AuditService auditService;

    @AfterEach
    void cleanup() {
        planVersionRepository.deleteAll();
        auditLogRepository.deleteAll();
        idempotencyRecordRepository.deleteAll();
    }

    private PlanVersion reviewedVersion(String code) {
        PlanVersion pv = new PlanVersion();
        pv.setId(UUID.randomUUID().toString());
        pv.setVersionCode(code);
        pv.setCandidateType("BASELINE");
        pv.setStatus("REVIEWED");
        return planVersionRepository.save(pv);
    }

    @Test
    void publish_midwayFailure_rollsBackEverything() {
        PlanVersion pv = reviewedVersion("PV-IT-ROLLBACK");
        // 审计落库是 publish 最后一步；令其抛异常模拟中途失败
        doThrow(new IllegalStateException("simulated downstream failure"))
                .when(auditService).record(anyString(), anyString(), anyString(), org.mockito.ArgumentMatchers.any());

        assertThrows(IllegalStateException.class,
                () -> planVersionService.publish(pv.getId(), new PublishRequest(0L)));

        PlanVersion reloaded = planVersionRepository.findById(pv.getId()).orElseThrow();
        assertEquals("REVIEWED", reloaded.getStatus(), "状态应回滚");
        assertEquals(0L, reloaded.getVersion(), "乐观锁版本应回滚");
        assertEquals(null, reloaded.getPublishedAt(), "publishedAt 应回滚");
        assertEquals(0, auditLogRepository.count(), "审计不应有残留");
    }

    @Test
    void idempotency_duplicateKey_rejectedByUniqueConstraintAndReplays() {
        Map<String, Object> request = Map.of("mode", "BASELINE");
        Map<String, Object> response = Map.of("taskId", "t-1");

        idempotencyService.store("it-key-1", request, response);

        // 同键同摘要：命中重放，返回首次结果
        Optional<Object> replay = idempotencyService.findReplay("it-key-1", request);
        assertTrue(replay.isPresent());
        assertEquals("t-1", ((Map<?, ?>) replay.get()).get("taskId"));

        // 同键直接再插：唯一约束在独立新事务内生效，重复写入被吞掉（first writer wins），不影响已提交业务
        idempotencyService.store("it-key-1", request, response);
        assertEquals(1, idempotencyRecordRepository.count(), "同键重复写不应产生第二条记录");
        replay = idempotencyService.findReplay("it-key-1", request);
        assertTrue(replay.isPresent());
        assertEquals("t-1", ((Map<?, ?>) replay.get()).get("taskId"));

        // 同键不同摘要：业务层 E_DUPLICATE
        BizException dup = assertThrows(BizException.class,
                () -> idempotencyService.findReplay("it-key-1", Map.of("mode", "FULL_RESCHEDULE")));
        assertEquals("E_DUPLICATE", dup.getCode());
    }
}
