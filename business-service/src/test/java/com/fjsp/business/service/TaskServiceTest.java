package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fjsp.business.client.AlgorithmClient;
import com.fjsp.business.common.BizException;
import com.fjsp.business.config.FjspProperties;
import com.fjsp.business.dto.CreateTaskRequest;
import com.fjsp.business.entity.InputSnapshot;
import com.fjsp.business.entity.PlanVersion;
import com.fjsp.business.entity.ScheduleOperation;
import com.fjsp.business.entity.ScheduleTask;
import com.fjsp.business.repository.EventRepository;
import com.fjsp.business.repository.InputSnapshotRepository;
import com.fjsp.business.repository.PlanVersionRepository;
import com.fjsp.business.repository.ScheduleOperationRepository;
import com.fjsp.business.repository.ScheduleTaskRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class TaskServiceTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final OffsetDateTime SIM_START = OffsetDateTime.parse("2026-09-16T08:00:00+08:00");

    @Mock
    private ScheduleTaskRepository taskRepository;
    @Mock
    private InputSnapshotRepository snapshotRepository;
    @Mock
    private PlanVersionRepository planVersionRepository;
    @Mock
    private ScheduleOperationRepository scheduleOperationRepository;
    @Mock
    private EventRepository eventRepository;
    @Mock
    private SnapshotBuilder snapshotBuilder;
    @Mock
    private AlgorithmClient algorithmClient;
    @Mock
    private CodeGenerator codeGenerator;
    @Mock
    private AuditService auditService;
    @Mock
    private IdempotencyService idempotencyService;
    @Mock
    private FjspProperties properties;
    @Mock
    private SeedService seedService;
    @Mock
    private TaskRunner taskRunner;
    @Mock
    private ScheduleIntegrityGuard integrityGuard;

    @InjectMocks
    private TaskService taskService;

    @BeforeEach
    void initSynchronization() {
        // createTask 通过 TransactionSynchronizationManager 注册 afterCommit 回调，
        // 纯单元测试中没有真实事务，需要显式激活同步上下文
        TransactionSynchronizationManager.initSynchronization();
    }

    @AfterEach
    void clearSynchronization() {
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.clearSynchronization();
        }
    }

    private CreateTaskRequest baselineRequest() {
        return new CreateTaskRequest("BASELINE", null, null, null, null, null, null, null);
    }

    private Map<String, Object> snapshotMap() {
        Map<String, Object> algorithm = new LinkedHashMap<>();
        algorithm.put("randomSeed", 42);
        algorithm.put("timeLimitSeconds", 60);
        Map<String, Object> snapshot = new LinkedHashMap<>();
        snapshot.put("mode", "BASELINE");
        snapshot.put("simulationStartAt", SIM_START.toString());
        snapshot.put("machines", List.of());
        snapshot.put("orders", List.of());
        snapshot.put("algorithm", algorithm);
        return snapshot;
    }

    private void stubCreateHappyPath(CreateTaskRequest req) {
        when(idempotencyService.findReplay("key-1", req)).thenReturn(Optional.empty());
        when(properties.getFreezeWindow()).thenReturn(java.time.Duration.ofMinutes(30));
        when(seedService.defaultSimulationStartAt()).thenReturn(SIM_START);
        when(snapshotBuilder.buildSolveRequest(eq("BASELINE"), any(), any(), any(), eq(SIM_START),
                eq(30), any(), any())).thenReturn(snapshotMap());
        when(taskRepository.findByFingerprintAndStatusIn(anyString(), any())).thenReturn(Optional.empty());
        when(codeGenerator.next(eq("TSK"), any())).thenReturn("TSK-001");
    }

    @Test
    void createBaselineTask_success() {
        CreateTaskRequest req = baselineRequest();
        stubCreateHappyPath(req);

        Map<String, Object> data = taskService.createTask("key-1", req);

        ArgumentCaptor<ScheduleTask> taskCaptor = ArgumentCaptor.forClass(ScheduleTask.class);
        verify(taskRepository).save(taskCaptor.capture());
        ScheduleTask saved = taskCaptor.getValue();
        assertEquals("TSK-001", saved.getTaskCode());
        assertEquals("BASELINE", saved.getMode());
        assertEquals("PENDING", saved.getStatus());
        assertEquals(0, saved.getProgress());
        assertNotNull(saved.getFingerprint());
        assertNotNull(saved.getSnapshotHash());
        assertEquals(42, saved.getRandomSeed());

        ArgumentCaptor<InputSnapshot> snapshotCaptor = ArgumentCaptor.forClass(InputSnapshot.class);
        verify(snapshotRepository).save(snapshotCaptor.capture());
        assertEquals(saved.getId(), snapshotCaptor.getValue().getTaskId());
        assertEquals(saved.getSnapshotHash(), snapshotCaptor.getValue().getSnapshotHash());

        assertEquals(saved.getId(), data.get("taskId"));
        assertEquals("TSK-001", data.get("taskCode"));
        assertEquals("PENDING", data.get("status"));
        verify(idempotencyService).store(eq("key-1"), eq(req), any());
    }

    @Test
    void createBaselineTask_afterCommitTriggersRunner() {
        CreateTaskRequest req = baselineRequest();
        stubCreateHappyPath(req);

        Map<String, Object> data = taskService.createTask("key-1", req);

        List<TransactionSynchronization> synchronizations =
                TransactionSynchronizationManager.getSynchronizations();
        assertEquals(1, synchronizations.size());
        synchronizations.get(0).afterCommit();
        verify(taskRunner).run((String) data.get("taskId"));
    }

    @Test
    void createTask_idempotencyReplay_returnsStoredResponse() {
        CreateTaskRequest req = baselineRequest();
        Map<String, Object> stored = Map.of("taskId", "t-old", "taskCode", "TSK-000");
        when(idempotencyService.findReplay("key-1", req)).thenReturn(Optional.of(stored));

        Map<String, Object> data = taskService.createTask("key-1", req);

        assertEquals("t-old", data.get("taskId"));
        verify(taskRepository, never()).save(any());
        org.mockito.Mockito.verifyNoInteractions(snapshotBuilder);
    }

    @Test
    void createTask_duplicateFingerprint_rejected() {
        CreateTaskRequest req = baselineRequest();
        ScheduleTask existing = new ScheduleTask();
        existing.setTaskCode("TSK-009");
        existing.setStatus("RUNNING");
        when(idempotencyService.findReplay("key-1", req)).thenReturn(Optional.empty());
        when(properties.getFreezeWindow()).thenReturn(java.time.Duration.ofMinutes(30));
        when(seedService.defaultSimulationStartAt()).thenReturn(SIM_START);
        when(snapshotBuilder.buildSolveRequest(any(), any(), any(), any(), eq(SIM_START), eq(30),
                any(), any())).thenReturn(snapshotMap());
        when(taskRepository.findByFingerprintAndStatusIn(anyString(), any())).thenReturn(Optional.of(existing));

        BizException e = assertThrows(BizException.class, () -> taskService.createTask("key-1", req));
        assertEquals("E_DUPLICATE", e.getCode());
        verify(taskRepository, never()).save(any());
    }

    @Test
    void createTask_dedupUsesBlockingStatuses_failedAndCancelledAllowed() {
        CreateTaskRequest req = baselineRequest();
        stubCreateHappyPath(req);

        taskService.createTask("key-1", req);

        @SuppressWarnings("unchecked")
        ArgumentCaptor<java.util.Collection<String>> statusCaptor =
                ArgumentCaptor.forClass(java.util.Collection.class);
        verify(taskRepository).findByFingerprintAndStatusIn(anyString(), statusCaptor.capture());
        java.util.Collection<String> blocking = statusCaptor.getValue();
        assertTrue(blocking.contains("PENDING"));
        assertTrue(blocking.contains("RUNNING"));
        assertTrue(blocking.contains("RETRY_WAIT"));
        assertTrue(blocking.contains("SUCCESS"));
        assertFalse(blocking.contains("FAILED"));
        assertFalse(blocking.contains("CANCELLED"));
    }

    @Test
    void createTask_invalidMode_rejected() {
        CreateTaskRequest req = new CreateTaskRequest("UNKNOWN", null, null, null, null, null, null, null);
        when(idempotencyService.findReplay("key-1", req)).thenReturn(Optional.empty());

        BizException e = assertThrows(BizException.class, () -> taskService.createTask("key-1", req));
        assertEquals("E_VALIDATION", e.getCode());
    }

    @Test
    void createTask_freezeWindowOutOfRange_rejected() {
        CreateTaskRequest req = new CreateTaskRequest("BASELINE", null, null, null, null, 1441, null, null);
        when(idempotencyService.findReplay("key-1", req)).thenReturn(Optional.empty());

        BizException e = assertThrows(BizException.class, () -> taskService.createTask("key-1", req));
        assertEquals("E_VALIDATION", e.getCode());
    }

    @Test
    void createTask_timeLimitOutOfRange_rejected() {
        CreateTaskRequest req = new CreateTaskRequest("BASELINE", null, null, null, null, null, null,
                Map.of("timeLimitSeconds", 601));
        when(idempotencyService.findReplay("key-1", req)).thenReturn(Optional.empty());
        when(properties.getFreezeWindow()).thenReturn(java.time.Duration.ofMinutes(30));

        BizException e = assertThrows(BizException.class, () -> taskService.createTask("key-1", req));
        assertEquals("E_VALIDATION", e.getCode());
    }

    @Test
    void createTask_baselineWithEventId_rejected() {
        CreateTaskRequest req = new CreateTaskRequest("BASELINE", null, null, "EVT-001", null, null,
                null, null);
        when(idempotencyService.findReplay("key-1", req)).thenReturn(Optional.empty());
        when(properties.getFreezeWindow()).thenReturn(java.time.Duration.ofMinutes(30));

        BizException e = assertThrows(BizException.class, () -> taskService.createTask("key-1", req));
        assertEquals("E_VALIDATION", e.getCode());
    }

    @Test
    void createTask_rescheduleMissingRefs_rejected() {
        CreateTaskRequest req = new CreateTaskRequest("LOCAL_RESCHEDULE", null, null, null, null, null,
                null, null);
        when(idempotencyService.findReplay("key-1", req)).thenReturn(Optional.empty());
        when(properties.getFreezeWindow()).thenReturn(java.time.Duration.ofMinutes(30));

        BizException e = assertThrows(BizException.class, () -> taskService.createTask("key-1", req));
        assertEquals("E_VALIDATION", e.getCode());
    }

    @Test
    void markRunning_setsRunningState() {
        ScheduleTask task = new ScheduleTask();
        task.setId("t1");
        task.setStatus("PENDING");
        task.setProgress(0);
        when(taskRepository.findById("t1")).thenReturn(Optional.of(task));
        when(properties.getAlgorithm()).thenReturn(new FjspProperties.Algorithm());
        when(properties.getTask()).thenReturn(new FjspProperties.Task());

        taskService.markRunning("t1");

        assertEquals("RUNNING", task.getStatus());
        assertEquals(10, task.getProgress());
        assertNotNull(task.getStartedAt());
        assertNotNull(task.getTimeoutAt());
        long timeoutSeconds = java.time.Duration.between(OffsetDateTime.now(), task.getTimeoutAt()).getSeconds();
        assertTrue(timeoutSeconds > 670 && timeoutSeconds <= 680,
                "timeoutAt 应为 now + 620s 算法超时 + 60s 余量，实际差值: " + timeoutSeconds);
        verify(taskRepository).save(task);
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

    private InputSnapshot stubSnapshotForValidate() {
        InputSnapshot snapshot = new InputSnapshot();
        snapshot.setId("snap-1");
        snapshot.setTaskId("t1");
        snapshot.setSnapshotJson(snapshotMap());
        when(snapshotRepository.findByTaskId("t1")).thenReturn(Optional.of(snapshot));
        return snapshot;
    }

    private JsonNode feasibleResponse(String status) throws Exception {
        return JSON.readTree("""
                {
                  "status": "%s",
                  "feasibleSolution": true,
                  "meta": {"algorithmVersion": "v1", "elapsedMs": 123},
                  "kpi": {"makespan": 100},
                  "operations": [
                    {
                      "operationId": "OP-1",
                      "machineId": "M1",
                      "setupStartAt": "2026-09-16T08:00:00+08:00",
                      "processStartAt": "2026-09-16T08:05:00+08:00",
                      "startAt": "2026-09-16T08:05:00+08:00",
                      "endAt": "2026-09-16T09:00:00+08:00",
                      "changeoverMinutes": 5,
                      "frozen": false,
                      "affected": false
                    }
                  ]
                }
                """.formatted(status));
    }

    @Test
    void handleSolveResult_feasible_createsDraftPlan() throws Exception {
        ScheduleTask task = runningTask();
        when(taskRepository.findById("t1")).thenReturn(Optional.of(task));
        stubSnapshotForValidate();
        when(algorithmClient.validate(any())).thenReturn(JSON.readTree("{\"passed\": true}"));
        when(codeGenerator.next(eq("PV"), any())).thenReturn("PV-001");

        taskService.handleSolveResult("t1", feasibleResponse("SUCCESS"));

        ArgumentCaptor<PlanVersion> planCaptor = ArgumentCaptor.forClass(PlanVersion.class);
        verify(planVersionRepository).save(planCaptor.capture());
        PlanVersion plan = planCaptor.getValue();
        assertEquals("DRAFT", plan.getStatus());
        assertEquals("BASELINE", plan.getCandidateType());
        assertEquals("PV-001", plan.getVersionCode());
        assertEquals("t1", plan.getTaskId());

        @SuppressWarnings({"rawtypes", "unchecked"})
        ArgumentCaptor<List<ScheduleOperation>> opCaptor = (ArgumentCaptor) ArgumentCaptor.forClass(List.class);
        verify(scheduleOperationRepository).saveAll(opCaptor.capture());
        ScheduleOperation op = opCaptor.getValue().get(0);
        assertEquals("OP-1", op.getOperationId());
        assertEquals("M1", op.getMachineId());
        assertEquals(plan.getId(), op.getPlanVersionId());

        assertEquals("SUCCESS", task.getStatus());
        assertEquals("FEASIBLE", task.getResultStatus());
        assertEquals(Boolean.TRUE, task.getFeasibleSolution());
        assertEquals(100, task.getProgress());
        assertEquals(plan.getId(), task.getPlanVersionId());
        assertNotNull(task.getFinishedAt());
    }

    @Test
    void handleSolveResult_timeLimitButFeasible_stillCreatesPlan() throws Exception {
        ScheduleTask task = runningTask();
        when(taskRepository.findById("t1")).thenReturn(Optional.of(task));
        stubSnapshotForValidate();
        when(algorithmClient.validate(any())).thenReturn(JSON.readTree("{\"passed\": true}"));
        when(codeGenerator.next(eq("PV"), any())).thenReturn("PV-001");

        taskService.handleSolveResult("t1", feasibleResponse("TIME_LIMIT"));

        verify(planVersionRepository).save(any(PlanVersion.class));
        assertEquals("TIME_LIMIT", task.getStatus());
        assertEquals("FEASIBLE", task.getResultStatus());
    }

    @Test
    void handleSolveResult_infeasible_noPlanCreated() throws Exception {
        ScheduleTask task = runningTask();
        when(taskRepository.findById("t1")).thenReturn(Optional.of(task));
        JsonNode resp = JSON.readTree("""
                {
                  "status": "SUCCESS",
                  "feasibleSolution": false,
                  "resultStatus": "INFEASIBLE",
                  "constraintCheck": {"conflicts": [{"type": "MACHINE_OVERLAP"}]}
                }
                """);

        taskService.handleSolveResult("t1", resp);

        verify(planVersionRepository, never()).save(any());
        verify(scheduleOperationRepository, never()).save(any());
        assertEquals("INFEASIBLE", task.getResultStatus());
        assertEquals(Boolean.FALSE, task.getFeasibleSolution());
        assertTrue(task.getConflicts().contains("MACHINE_OVERLAP"));
        assertEquals(100, task.getProgress());
        assertNotNull(task.getFinishedAt());
    }

    @Test
    void handleSolveResult_feasibleButValidationFails_noPlanCreated() throws Exception {
        ScheduleTask task = runningTask();
        when(taskRepository.findById("t1")).thenReturn(Optional.of(task));
        stubSnapshotForValidate();
        when(algorithmClient.validate(any()))
                .thenReturn(JSON.readTree("{\"passed\": false, \"conflicts\": [{\"type\": \"PRECEDENCE_VIOLATION\"}]}"));

        taskService.handleSolveResult("t1", feasibleResponse("SUCCESS"));

        verify(planVersionRepository, never()).save(any());
        assertEquals("INFEASIBLE", task.getResultStatus());
        assertEquals(Boolean.FALSE, task.getFeasibleSolution());
        assertTrue(task.getConflicts().contains("PRECEDENCE_VIOLATION"));
        assertEquals(100, task.getProgress());
    }

    @Test
    void markFailed_recordsFailureAndTruncatesMessage() {
        ScheduleTask task = runningTask();
        when(taskRepository.findById("t1")).thenReturn(Optional.of(task));
        String longMessage = "x".repeat(5000);

        taskService.markFailed("t1", longMessage);

        assertEquals("FAILED", task.getStatus());
        assertEquals("FAILED", task.getResultStatus());
        assertEquals(Boolean.FALSE, task.getFeasibleSolution());
        assertEquals(1900, task.getErrorMessage().length());
        assertEquals(100, task.getProgress());
        assertNotNull(task.getFinishedAt());
        verify(taskRepository).save(task);
    }

    @Test
    void markFailed_nullMessage() {
        ScheduleTask task = runningTask();
        when(taskRepository.findById("t1")).thenReturn(Optional.of(task));

        taskService.markFailed("t1", null);

        assertEquals("FAILED", task.getStatus());
        assertNull(task.getErrorMessage());
    }

    // ---- resilience: retry policy / timeout scan / startup recovery / retry & cancel ----

    @Test
    void scheduleRetryOrFail_firstFailure_schedulesRetryWait() {
        ScheduleTask task = runningTask();
        task.setTimeoutAt(OffsetDateTime.now().plusMinutes(5));
        when(taskRepository.findById("t1")).thenReturn(Optional.of(task));

        taskService.scheduleRetryOrFail("t1", "ResourceAccessException: Connection refused");

        assertEquals("RETRY_WAIT", task.getStatus());
        assertEquals(1, task.getRetryCount());
        assertNull(task.getTimeoutAt());
        assertNotNull(task.getNextRetryAt());
        long delay = java.time.Duration.between(OffsetDateTime.now(), task.getNextRetryAt()).getSeconds();
        assertTrue(delay > 25 && delay <= 30, "首次重试退避应约 30s，实际: " + delay);
        assertNotNull(task.getErrorMessage());
        verify(auditService).record(eq("TASK_RETRY_SCHEDULED"), eq("schedule_task"), eq("t1"),
                argThat(d -> d.contains("retryCount=1") && d.contains("Connection refused")));
    }

    @Test
    void scheduleRetryOrFail_exceedsMaxRetries_marksFailedDeadLetter() {
        ScheduleTask task = runningTask();
        task.setRetryCount(3);
        task.setMaxRetries(3);
        task.setFingerprint("fp-1");
        when(taskRepository.findById("t1")).thenReturn(Optional.of(task));

        taskService.scheduleRetryOrFail("t1", "ResourceAccessException: Read timed out");

        assertEquals("FAILED", task.getStatus());
        assertEquals("FAILED", task.getResultStatus());
        assertEquals(4, task.getRetryCount());
        assertTrue(task.getErrorMessage().contains("重试 3 次后仍失败"));
        assertNull(task.getFingerprint(), "FAILED 终态应释放指纹允许重建");
        assertNull(task.getNextRetryAt());
        assertEquals(100, task.getProgress());
        assertNotNull(task.getFinishedAt());
        verify(auditService).record(eq("TASK_FAILED"), eq("schedule_task"), eq("t1"), any());
    }

    @Test
    void scheduleRetryOrFail_cancelRequested_cancelsInsteadOfRetry() {
        ScheduleTask task = runningTask();
        task.setCancelRequested(true);
        when(taskRepository.findById("t1")).thenReturn(Optional.of(task));

        taskService.scheduleRetryOrFail("t1", "ResourceAccessException: Connection refused");

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
        when(taskRepository.findById("t1")).thenReturn(Optional.of(task));

        taskService.processTimeouts();

        assertEquals("RETRY_WAIT", task.getStatus());
        assertTrue(task.getErrorMessage().contains("TaskTimeout"));
        verify(auditService).record(eq("TASK_RETRY_SCHEDULED"), eq("schedule_task"), eq("t1"), any());
    }

    @Test
    void redispatchDueRetries_dispatchesRunner() {
        ScheduleTask due = new ScheduleTask();
        due.setId("t1");
        due.setTaskCode("TSK-001");
        due.setStatus("RETRY_WAIT");
        when(taskRepository.findByStatusAndNextRetryAtLessThanEqual(eq("RETRY_WAIT"), any()))
                .thenReturn(List.of(due));

        int dispatched = taskService.redispatchDueRetries();

        assertEquals(1, dispatched);
        verify(taskRunner).run("t1");
    }

    @Test
    void recoverInterruptedTasks_runningTaskRecoveredToRetryWait() {
        ScheduleTask task = runningTask();
        when(taskRepository.findByStatus("RUNNING")).thenReturn(List.of(task));
        when(taskRepository.findById("t1")).thenReturn(Optional.of(task));

        taskService.recoverInterruptedTasks();

        assertEquals("RETRY_WAIT", task.getStatus());
        assertEquals(1, task.getRetryCount());
        verify(auditService).record(eq("TASK_RECOVERED"), eq("schedule_task"), eq("t1"), any());
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

        int dispatched = taskService.redispatchPendingTasks();

        assertEquals(2, dispatched);
        verify(taskRunner).run("t1");
        verify(taskRunner).run("t2");
    }

    @Test
    void cancelTask_pending_becomesCancelled() {
        ScheduleTask task = new ScheduleTask();
        task.setId("t1");
        task.setTaskCode("TSK-001");
        task.setStatus("PENDING");
        task.setFingerprint("fp-1");
        when(taskRepository.findById("t1")).thenReturn(Optional.of(task));

        Map<String, Object> data = taskService.cancelTask("t1");

        assertEquals("CANCELLED", task.getStatus());
        assertNull(task.getFingerprint());
        assertNotNull(task.getFinishedAt());
        assertEquals("CANCELLED", data.get("status"));
        verify(auditService).record(eq("TASK_CANCELLED"), eq("schedule_task"), eq("t1"), any());
    }

    @Test
    void cancelTask_retryWait_becomesCancelled() {
        ScheduleTask task = runningTask();
        task.setStatus("RETRY_WAIT");
        task.setNextRetryAt(OffsetDateTime.now().plusSeconds(30));
        when(taskRepository.findById("t1")).thenReturn(Optional.of(task));

        taskService.cancelTask("t1");

        assertEquals("CANCELLED", task.getStatus());
        assertNull(task.getNextRetryAt());
        verify(auditService).record(eq("TASK_CANCELLED"), eq("schedule_task"), eq("t1"), any());
    }

    @Test
    void cancelTask_running_setsCancelRequestedOnly() {
        ScheduleTask task = runningTask();
        when(taskRepository.findById("t1")).thenReturn(Optional.of(task));

        Map<String, Object> data = taskService.cancelTask("t1");

        assertEquals("RUNNING", task.getStatus());
        assertTrue(task.getCancelRequested());
        assertEquals(Boolean.TRUE, data.get("cancelRequested"));
        verify(auditService).record(eq("TASK_CANCEL_REQUESTED"), eq("schedule_task"), eq("t1"), any());
    }

    @Test
    void cancelTask_terminal_rejected() {
        ScheduleTask task = runningTask();
        task.setStatus("SUCCESS");
        when(taskRepository.findById("t1")).thenReturn(Optional.of(task));

        BizException e = assertThrows(BizException.class, () -> taskService.cancelTask("t1"));
        assertEquals("E_STATE_CONFLICT", e.getCode());
    }

    @Test
    void retryTask_failed_resetsAndRedispatches() {
        ScheduleTask task = runningTask();
        task.setStatus("FAILED");
        task.setResultStatus("FAILED");
        task.setRetryCount(4);
        task.setErrorMessage("boom");
        task.setFinishedAt(OffsetDateTime.now());
        task.setFingerprint(null);
        task.setSnapshotHash("snapshot-hash-1");
        when(taskRepository.findById("t1")).thenReturn(Optional.of(task));
        when(taskRepository.findByFingerprintAndStatusIn(anyString(), any())).thenReturn(Optional.empty());

        Map<String, Object> data = taskService.retryTask("t1");

        assertEquals("PENDING", task.getStatus());
        assertEquals(0, task.getRetryCount());
        assertFalse(task.getCancelRequested());
        assertNull(task.getErrorMessage());
        assertNull(task.getResultStatus());
        assertNull(task.getFinishedAt());
        assertNull(task.getNextRetryAt());
        assertNull(task.getTimeoutAt());
        assertNotNull(task.getFingerprint(), "人工重试应恢复指纹以继续去重保护");
        assertEquals("PENDING", data.get("status"));
        verify(auditService).record(eq("TASK_MANUAL_RETRY"), eq("schedule_task"), eq("t1"), any());

        List<TransactionSynchronization> synchronizations =
                TransactionSynchronizationManager.getSynchronizations();
        assertEquals(1, synchronizations.size());
        synchronizations.get(0).afterCommit();
        verify(taskRunner).run("t1");
    }

    @Test
    void retryTask_nonTerminal_rejected() {
        ScheduleTask task = runningTask();
        when(taskRepository.findById("t1")).thenReturn(Optional.of(task));

        BizException e = assertThrows(BizException.class, () -> taskService.retryTask("t1"));
        assertEquals("E_STATE_CONFLICT", e.getCode());
        verify(taskRepository, never()).save(any());
    }

    @Test
    void retryTask_blockingDuplicate_rejected() {
        ScheduleTask task = runningTask();
        task.setStatus("FAILED");
        task.setSnapshotHash("snapshot-hash-1");
        ScheduleTask other = new ScheduleTask();
        other.setTaskCode("TSK-777");
        when(taskRepository.findById("t1")).thenReturn(Optional.of(task));
        when(taskRepository.findByFingerprintAndStatusIn(anyString(), any()))
                .thenReturn(Optional.of(other));

        BizException e = assertThrows(BizException.class, () -> taskService.retryTask("t1"));
        assertEquals("E_DUPLICATE", e.getCode());
    }

    @Test
    void handleSolveResult_cancelRequested_discardsResult() throws Exception {
        ScheduleTask task = runningTask();
        task.setCancelRequested(true);
        task.setFingerprint("fp-1");
        when(taskRepository.findById("t1")).thenReturn(Optional.of(task));

        taskService.handleSolveResult("t1", feasibleResponse("SUCCESS"));

        assertEquals("CANCELLED", task.getStatus());
        assertFalse(task.getCancelRequested());
        assertNull(task.getFingerprint());
        assertNotNull(task.getFinishedAt());
        verify(planVersionRepository, never()).save(any());
        verify(scheduleOperationRepository, never()).save(any());
        verify(auditService).record(eq("TASK_CANCELLED"), eq("schedule_task"), eq("t1"), any());
    }
}
