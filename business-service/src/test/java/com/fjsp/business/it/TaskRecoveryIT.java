package com.fjsp.business.it;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

import com.fjsp.business.entity.AuditLog;
import com.fjsp.business.entity.ScheduleTask;
import com.fjsp.business.repository.AuditLogRepository;
import com.fjsp.business.repository.ScheduleTaskRepository;
import com.fjsp.business.service.TaskRecoveryRunner;
import com.fjsp.business.service.TaskRunner;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.verify;

/** 场景 15（重启恢复）：真实库中残留 RUNNING 转重试、PENDING 重新投递。 */
class TaskRecoveryIT extends AbstractPostgresIT {

    @Autowired
    private ScheduleTaskRepository taskRepository;
    @Autowired
    private AuditLogRepository auditLogRepository;
    @Autowired
    private TaskRecoveryRunner recoveryRunner;

    @MockitoBean
    private TaskRunner taskRunner;

    @AfterEach
    void cleanup() {
        taskRepository.deleteAll();
        auditLogRepository.deleteAll();
    }

    private ScheduleTask newTask(String status) {
        ScheduleTask task = new ScheduleTask();
        task.setId(UUID.randomUUID().toString());
        task.setTaskCode("TSK-IT-" + UUID.randomUUID().toString().substring(0, 8));
        task.setMode("BASELINE");
        task.setStatus(status);
        task.setProgress(status.equals("RUNNING") ? 10 : 0);
        return task;
    }

    @Test
    void staleRunningTask_recoveredToRetryWaitWithAudit() {
        ScheduleTask stale = newTask("RUNNING");
        stale.setStartedAt(OffsetDateTime.now().minusHours(2));
        stale.setTimeoutAt(OffsetDateTime.now().minusHours(1));
        taskRepository.save(stale);

        recoveryRunner.run(null);

        ScheduleTask reloaded = taskRepository.findById(stale.getId()).orElseThrow();
        assertEquals("RETRY_WAIT", reloaded.getStatus());
        assertEquals(1, reloaded.getRetryCount());
        assertNotNull(reloaded.getNextRetryAt());
        assertTrue(reloaded.getNextRetryAt().isAfter(OffsetDateTime.now()));
        assertNull(reloaded.getTimeoutAt());

        List<AuditLog> audits = auditLogRepository.findAll();
        assertTrue(audits.stream().anyMatch(a -> "TASK_RECOVERED".equals(a.getAction())
                && stale.getId().equals(a.getObjectId())), "应落 TASK_RECOVERED 审计");
        assertTrue(audits.stream().anyMatch(a -> "TASK_RETRY_SCHEDULED".equals(a.getAction())
                && stale.getId().equals(a.getObjectId())), "应落 TASK_RETRY_SCHEDULED 审计");
    }

    @Test
    void pendingTask_redispatchedOnStartup() {
        ScheduleTask pending = newTask("PENDING");
        taskRepository.save(pending);

        recoveryRunner.run(null);

        verify(taskRunner).run(pending.getId());
        assertEquals("PENDING", taskRepository.findById(pending.getId()).orElseThrow().getStatus());
    }
}
