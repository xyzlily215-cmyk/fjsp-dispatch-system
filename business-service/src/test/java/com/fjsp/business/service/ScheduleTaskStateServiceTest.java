package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.List;

import com.fjsp.business.config.FjspProperties;
import com.fjsp.business.entity.ScheduleTask;
import com.fjsp.business.repository.ScheduleTaskRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.mockito.Mockito.doThrow;
import org.springframework.core.task.TaskRejectedException;

@ExtendWith(MockitoExtension.class)
class ScheduleTaskStateServiceTest {

    @Mock
    private ScheduleTaskRepository taskRepository;
    @Mock
    private AuditService auditService;
    @Mock
    private FjspProperties properties;
    @Mock
    private TaskRunner taskRunner;
    @Mock
    private TaskEventService taskEventService;
    @Mock
    private com.fjsp.business.metrics.FjspMetrics metrics;

    @InjectMocks
    private ScheduleTaskStateService stateService;

    @BeforeEach
    void injectSelf() {
        org.springframework.test.util.ReflectionTestUtils.setField(stateService, "self", stateService);
    }

    private ScheduleTask runningTask() {
        ScheduleTask task = new ScheduleTask();
        task.setId("t1");
        task.setTaskCode("TSK-001");
        task.setMode("BASELINE");
        task.setStatus("RUNNING");
        task.setProgress(10);
        return task;
    }

    @Test
    void markRunning_dispatchableTask_becomesRunningAtomically() {
        when(properties.getAlgorithm()).thenReturn(new FjspProperties.Algorithm());
        when(properties.getTask()).thenReturn(new FjspProperties.Task());
        when(taskRepository.markRunningIfDispatchable(eq("t1"), any(), any())).thenReturn(1);

        boolean dispatched = stateService.markRunning("t1");

        assertTrue(dispatched);
        ArgumentCaptor<OffsetDateTime> timeoutCaptor = ArgumentCaptor.forClass(OffsetDateTime.class);
        verify(taskRepository).markRunningIfDispatchable(eq("t1"), any(), timeoutCaptor.capture());
        long timeoutSeconds = java.time.Duration.between(OffsetDateTime.now(), timeoutCaptor.getValue())
                .getSeconds();
        assertTrue(timeoutSeconds > 670 && timeoutSeconds <= 680,
                "timeoutAt 应为 now + 620s 算法超时 + 60s 余量，实际差值: " + timeoutSeconds);
    }

    @Test
    void markRunning_cancelledOrAlreadyDispatched_returnsFalse() {
        // 取消后复活防护：条件更新影响行数为 0（任务已 CANCELLED 或已被抢占），调用方放弃派发
        when(properties.getAlgorithm()).thenReturn(new FjspProperties.Algorithm());
        when(properties.getTask()).thenReturn(new FjspProperties.Task());
        when(taskRepository.markRunningIfDispatchable(eq("t1"), any(), any())).thenReturn(0);

        boolean dispatched = stateService.markRunning("t1");

        assertFalse(dispatched);
    }

    @Test
    void markRunning_recordsTimeSpentWaiting() {
        ScheduleTask pending = new ScheduleTask();
        pending.setId("t1");
        pending.setMode("BASELINE");
        pending.setCreatedAt(OffsetDateTime.now().minusSeconds(5));
        when(taskRepository.findById("t1")).thenReturn(java.util.Optional.of(pending));
        when(properties.getAlgorithm()).thenReturn(new FjspProperties.Algorithm());
        when(properties.getTask()).thenReturn(new FjspProperties.Task());
        when(taskRepository.markRunningIfDispatchable(eq("t1"), any(), any())).thenReturn(1);

        assertTrue(stateService.markRunning("t1"));
        verify(metrics).recordQueueWait(eq("BASELINE"), argThat(wait ->
                wait.toMillis() >= 4000 && wait.toMillis() < 10000));
    }

    @Test
    void markDispatchRejected_failsPendingTaskWithCapacityReason() {
        ScheduleTask pending = new ScheduleTask();
        pending.setId("t1");
        pending.setStatus("PENDING");
        when(taskRepository.findByIdForUpdate("t1")).thenReturn(java.util.Optional.of(pending));

        stateService.markDispatchRejected("t1");

        assertEquals("FAILED", pending.getStatus());
        assertTrue(pending.getErrorMessage().contains("队列已满"));
        verify(metrics).recordDispatchRejected();
    }

    @Test
    void markDispatchFailed_retriesPendingWithoutTouchingQueuedTasks() {
        ScheduleTask pending = new ScheduleTask();
        pending.setId("t1");
        pending.setStatus("PENDING");
        when(taskRepository.findByIdForUpdate("t1")).thenReturn(java.util.Optional.of(pending));

        stateService.markDispatchFailed("t1", "executor unavailable");

        assertEquals("RETRY_WAIT", pending.getStatus());
        assertEquals(1, pending.getRetryCount());
        assertNotNull(pending.getNextRetryAt());
        verify(metrics).recordRetry();
    }

    @Test
    void markDispatchFailed_doesNotOverwriteRunningTask() {
        ScheduleTask running = runningTask();
        when(taskRepository.findByIdForUpdate("t1")).thenReturn(java.util.Optional.of(running));

        stateService.markDispatchFailed("t1", "late dispatch exception");

        assertEquals("RUNNING", running.getStatus());
        verify(taskRepository, never()).save(any());
    }

    @Test
    void markFailed_recordsFailureAndTruncatesMessage() {
        ScheduleTask task = runningTask();
        when(taskRepository.findByIdForUpdate("t1")).thenReturn(java.util.Optional.of(task));
        String longMessage = "x".repeat(5000);

        stateService.markFailed("t1", longMessage);

        assertEquals("FAILED", task.getStatus());
        assertEquals("FAILED", task.getResultStatus());
        assertEquals(Boolean.FALSE, task.getFeasibleSolution());
        assertEquals(1900, task.getErrorMessage().length());
        assertEquals(100, task.getProgress());
        assertNotNull(task.getFinishedAt());
        verify(taskRepository).save(task);
        verify(metrics).recordTaskResult("FAILED");
    }

    @Test
    void markFailed_nullMessage() {
        ScheduleTask task = runningTask();
        when(taskRepository.findByIdForUpdate("t1")).thenReturn(java.util.Optional.of(task));

        stateService.markFailed("t1", null);

        assertEquals("FAILED", task.getStatus());
        assertNull(task.getErrorMessage());
    }

    // ---- resilience: retry policy / timeout scan / startup recovery ----

    @Test
    void scheduleRetryOrFail_firstFailure_schedulesRetryWait() {
        ScheduleTask task = runningTask();
        task.setTimeoutAt(OffsetDateTime.now().plusMinutes(5));
        when(taskRepository.findByIdForUpdate("t1")).thenReturn(java.util.Optional.of(task));

        stateService.scheduleRetryOrFail("t1", "ResourceAccessException: Connection refused");

        assertEquals("RETRY_WAIT", task.getStatus());
        assertEquals(1, task.getRetryCount());
        assertNull(task.getTimeoutAt());
        assertNotNull(task.getNextRetryAt());
        long delay = java.time.Duration.between(OffsetDateTime.now(), task.getNextRetryAt()).getSeconds();
        assertTrue(delay > 25 && delay <= 30, "首次重试退避应约 30s，实际: " + delay);
        assertNotNull(task.getErrorMessage());
        verify(metrics).recordRetry();
        verify(auditService).record(eq("TASK_RETRY_SCHEDULED"), eq("schedule_task"), eq("t1"),
                argThat(d -> d.contains("retryCount=1") && d.contains("Connection refused")));
    }

    @Test
    void scheduleRetryOrFail_exceedsMaxRetries_marksFailedDeadLetter() {
        ScheduleTask task = runningTask();
        task.setRetryCount(3);
        task.setMaxRetries(3);
        task.setFingerprint("fp-1");
        when(taskRepository.findByIdForUpdate("t1")).thenReturn(java.util.Optional.of(task));

        stateService.scheduleRetryOrFail("t1", "ResourceAccessException: Read timed out");

        assertEquals("FAILED", task.getStatus());
        assertEquals("FAILED", task.getResultStatus());
        assertEquals(4, task.getRetryCount());
        assertTrue(task.getErrorMessage().contains("重试 3 次后仍失败"));
        assertNull(task.getFingerprint(), "FAILED 终态应释放指纹允许重建");
        assertNull(task.getNextRetryAt());
        assertEquals(100, task.getProgress());
        assertNotNull(task.getFinishedAt());
        verify(metrics, never()).recordRetry();
        verify(metrics).recordTaskResult("FAILED");
        verify(auditService).record(eq("TASK_FAILED"), eq("schedule_task"), eq("t1"), any());
    }

    @Test
    void scheduleRetryOrFail_cancelRequested_cancelsInsteadOfRetry() {
        ScheduleTask task = runningTask();
        task.setCancelRequested(true);
        when(taskRepository.findByIdForUpdate("t1")).thenReturn(java.util.Optional.of(task));

        stateService.scheduleRetryOrFail("t1", "ResourceAccessException: Connection refused");

        assertEquals("CANCELLED", task.getStatus());
        assertEquals(0, task.getRetryCount());
        verify(auditService).record(eq("TASK_CANCELLED"), eq("schedule_task"), eq("t1"), any());
    }

    @Test
    void processTimeouts_timedOutRunningTask_schedulesRetry() {
        ScheduleTask task = runningTask();
        task.setTimeoutAt(OffsetDateTime.now().minusMinutes(1));
        when(taskRepository.findByStatusAndTimeoutAtBefore(eq("RUNNING"), any()))
                .thenReturn(List.of(task));
        when(taskRepository.findByIdForUpdate("t1")).thenReturn(java.util.Optional.of(task));

        stateService.processTimeouts();

        assertEquals("RETRY_WAIT", task.getStatus());
        assertTrue(task.getErrorMessage().contains("TaskTimeout"));
        verify(auditService).record(eq("TASK_RETRY_SCHEDULED"), eq("schedule_task"), eq("t1"), any());
    }

    @Test
    void timeoutScan_doesNotRetryNewerAttempt() {
        ScheduleTask task = runningTask();
        task.setTimeoutAt(OffsetDateTime.now().plusMinutes(5));
        when(taskRepository.findByIdForUpdate("t1")).thenReturn(java.util.Optional.of(task));

        stateService.timeoutIfDue("t1", OffsetDateTime.now());

        assertEquals("RUNNING", task.getStatus());
        verify(taskRepository, never()).save(any());
    }

    @Test
    void redispatchDueRetries_dispatchesRunner() {
        ScheduleTask due = new ScheduleTask();
        due.setId("t1");
        due.setTaskCode("TSK-001");
        due.setStatus("RETRY_WAIT");
        when(taskRepository.findByStatusAndNextRetryAtLessThanEqual(eq("RETRY_WAIT"), any()))
                .thenReturn(List.of(due));

        int dispatched = stateService.redispatchDueRetries();

        assertEquals(1, dispatched);
        verify(taskRunner).run("t1");
    }

    @Test
    void redispatchDueRetries_queueFullMarksTaskFailed() {
        ScheduleTask due = new ScheduleTask();
        due.setId("t1");
        due.setTaskCode("TSK-001");
        due.setStatus("RETRY_WAIT");
        when(taskRepository.findByStatusAndNextRetryAtLessThanEqual(eq("RETRY_WAIT"), any()))
                .thenReturn(List.of(due));
        when(taskRepository.findByIdForUpdate("t1")).thenReturn(java.util.Optional.of(due));
        doThrow(new TaskRejectedException("queue full")).when(taskRunner).run("t1");

        stateService.redispatchDueRetries();

        assertEquals("FAILED", due.getStatus());
        verify(metrics).recordDispatchRejected();
    }

    @Test
    void recoverInterruptedTasks_runningTaskRecoveredToRetryWait() {
        ScheduleTask task = runningTask();
        when(taskRepository.findByStatus("RUNNING")).thenReturn(List.of(task));
        when(taskRepository.findByIdForUpdate("t1")).thenReturn(java.util.Optional.of(task));

        stateService.recoverInterruptedTasks();

        assertEquals("RETRY_WAIT", task.getStatus());
        assertEquals(1, task.getRetryCount());
        verify(auditService).record(eq("TASK_RECOVERED"), eq("schedule_task"), eq("t1"), any());
    }

    @Test
    void recoverInterruptedTask_doesNotTouchNewerAttempt() {
        ScheduleTask task = runningTask();
        task.setStartedAt(OffsetDateTime.now());
        when(taskRepository.findByIdForUpdate("t1")).thenReturn(java.util.Optional.of(task));

        stateService.recoverInterruptedTask("t1", task.getStartedAt().minusSeconds(10));

        assertEquals("RUNNING", task.getStatus());
        verify(auditService, never()).record(eq("TASK_RECOVERED"), eq("schedule_task"), eq("t1"), any());
    }

    @Test
    void redispatchPendingTasks_dispatchesPendingAndDueRetryWait() {
        ScheduleTask pending = new ScheduleTask();
        pending.setId("t1");
        pending.setTaskCode("TSK-001");
        pending.setStatus("PENDING");
        ScheduleTask dueRetry = new ScheduleTask();
        dueRetry.setId("t2");
        dueRetry.setTaskCode("TSK-002");
        dueRetry.setStatus("RETRY_WAIT");
        when(taskRepository.findByStatus("PENDING")).thenReturn(List.of(pending));
        when(taskRepository.findByStatusAndNextRetryAtLessThanEqual(eq("RETRY_WAIT"), any()))
                .thenReturn(List.of(dueRetry));

        int dispatched = stateService.redispatchPendingTasks();

        assertEquals(2, dispatched);
        verify(taskRunner).run("t1");
        verify(taskRunner).run("t2");
    }

    @Test
    void lateFailureAndProgressCannotOverwriteTerminalTask() {
        ScheduleTask task = runningTask();
        task.setStatus("CANCELLED");
        when(taskRepository.findByIdForUpdate("t1")).thenReturn(java.util.Optional.of(task));

        stateService.updateProgress("t1", 85);
        stateService.markFailed("t1", "late failure");
        stateService.scheduleRetryOrFail("t1", "late timeout");

        assertEquals("CANCELLED", task.getStatus());
        verify(taskRepository, never()).save(any());
    }
}
