package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fjsp.business.client.AlgorithmClient;
import com.fjsp.business.common.BizException;
import com.fjsp.business.config.FjspProperties;
import com.fjsp.business.dto.CreateTaskRequest;
import com.fjsp.business.dto.ScheduleTaskCreateResponse;
import com.fjsp.business.dto.ScheduleTaskDetailResponse;
import com.fjsp.business.entity.InputSnapshot;
import com.fjsp.business.entity.ScheduleTask;
import com.fjsp.business.repository.EventRepository;
import com.fjsp.business.repository.InputSnapshotRepository;
import com.fjsp.business.repository.PlanVersionRepository;
import com.fjsp.business.repository.ScheduleTaskRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
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
class ScheduleTaskCommandServiceTest {

    /** 写接口统一走 idempotencyService.execute 模板：测试替身直接执行 action（回放场景单独打桩）。 */
    @SuppressWarnings("unchecked")
    private void stubExecuteRunsAction() {
        when(idempotencyService.execute(anyString(), any(), any()))
                .thenAnswer(inv -> ((java.util.function.Supplier<Object>) inv.getArgument(2)).get());
    }

    private static final OffsetDateTime SIM_START = OffsetDateTime.parse("2026-09-16T08:00:00+08:00");

    @Mock
    private ScheduleTaskRepository taskRepository;
    @Mock
    private InputSnapshotRepository snapshotRepository;
    @Mock
    private PlanVersionRepository planVersionRepository;
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
    private TaskEventService taskEventService;
    @Mock
    private com.fjsp.business.metrics.FjspMetrics metrics;

    private ScheduleTaskCommandService commandService;

    @BeforeEach
    void initSynchronization() {
        // createTask 通过 TransactionSynchronizationManager 注册 afterCommit 回调，
        // 纯单元测试中没有真实事务，需要显式激活同步上下文
        TransactionSynchronizationManager.initSynchronization();
        ScheduleTaskQueryService queryService = new ScheduleTaskQueryService(taskRepository);
        ScheduleTaskStateService stateService = new ScheduleTaskStateService(
                taskRepository, auditService, properties, taskRunner, taskEventService, metrics);
        commandService = new ScheduleTaskCommandService(taskRepository, snapshotRepository,
                planVersionRepository, eventRepository, snapshotBuilder, codeGenerator, auditService,
                idempotencyService, properties, seedService, taskRunner, taskEventService,
                queryService, stateService, metrics, new ObjectMapper());
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
        stubExecuteRunsAction();
        when(properties.getFreezeWindow()).thenReturn(java.time.Duration.ofMinutes(30));
        when(seedService.defaultSimulationStartAt()).thenReturn(SIM_START);
        when(snapshotBuilder.buildSolveRequest(eq("BASELINE"), any(), any(), any(), eq(SIM_START),
                eq(30), any(), any())).thenReturn(snapshotMap());
        when(taskRepository.findByFingerprintAndStatusIn(anyString(), any())).thenReturn(Optional.empty());
        when(codeGenerator.next("TSK")).thenReturn("TSK-001");
    }

    @Test
    void createBaselineTask_success() {
        CreateTaskRequest req = baselineRequest();
        stubCreateHappyPath(req);

        ScheduleTaskCreateResponse data = commandService.createTask("key-1", req);

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

        assertEquals(saved.getId(), data.taskId());
        assertEquals("TSK-001", data.taskCode());
        assertEquals("PENDING", data.status());
        verify(idempotencyService).execute(eq("key-1"), eq(req), any());
    }

    @Test
    void createBaselineTask_afterCommitTriggersRunner() {
        CreateTaskRequest req = baselineRequest();
        stubCreateHappyPath(req);

        ScheduleTaskCreateResponse data = commandService.createTask("key-1", req);

        List<TransactionSynchronization> synchronizations =
                TransactionSynchronizationManager.getSynchronizations();
        assertEquals(1, synchronizations.size());
        synchronizations.get(0).afterCommit();
        verify(taskRunner).run(data.taskId());
    }

    @Test
    void createTask_idempotencyReplay_returnsStoredResponse() {
        CreateTaskRequest req = baselineRequest();
        Map<String, Object> stored = Map.of("taskId", "t-old", "taskCode", "TSK-000");
        when(idempotencyService.execute(eq("key-1"), eq(req), any())).thenReturn(stored);

        ScheduleTaskCreateResponse data = commandService.createTask("key-1", req);

        assertEquals("t-old", data.taskId());
        verify(taskRepository, never()).save(any());
        org.mockito.Mockito.verifyNoInteractions(snapshotBuilder);
    }

    @Test
    void createTask_duplicateFingerprint_rejected() {
        CreateTaskRequest req = baselineRequest();
        ScheduleTask existing = new ScheduleTask();
        existing.setTaskCode("TSK-009");
        existing.setStatus("RUNNING");
        stubExecuteRunsAction();
        when(properties.getFreezeWindow()).thenReturn(java.time.Duration.ofMinutes(30));
        when(seedService.defaultSimulationStartAt()).thenReturn(SIM_START);
        when(snapshotBuilder.buildSolveRequest(any(), any(), any(), any(), eq(SIM_START), eq(30),
                any(), any())).thenReturn(snapshotMap());
        when(taskRepository.findByFingerprintAndStatusIn(anyString(), any())).thenReturn(Optional.of(existing));

        BizException e = assertThrows(BizException.class, () -> commandService.createTask("key-1", req));
        assertEquals("E_DUPLICATE", e.getCode());
        verify(taskRepository, never()).save(any());
    }

    @Test
    void createTask_dedupUsesBlockingStatuses_failedAndCancelledAllowed() {
        CreateTaskRequest req = baselineRequest();
        stubCreateHappyPath(req);

        commandService.createTask("key-1", req);

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
        stubExecuteRunsAction();

        BizException e = assertThrows(BizException.class, () -> commandService.createTask("key-1", req));
        assertEquals("E_VALIDATION", e.getCode());
    }

    @Test
    void createTask_freezeWindowOutOfRange_rejected() {
        CreateTaskRequest req = new CreateTaskRequest("BASELINE", null, null, null, null, 1441, null, null);
        stubExecuteRunsAction();

        BizException e = assertThrows(BizException.class, () -> commandService.createTask("key-1", req));
        assertEquals("E_VALIDATION", e.getCode());
    }

    @Test
    void createTask_timeLimitOutOfRange_rejected() {
        CreateTaskRequest req = new CreateTaskRequest("BASELINE", null, null, null, null, null, null,
                Map.of("timeLimitSeconds", 601));
        stubExecuteRunsAction();
        when(properties.getFreezeWindow()).thenReturn(java.time.Duration.ofMinutes(30));

        BizException e = assertThrows(BizException.class, () -> commandService.createTask("key-1", req));
        assertEquals("E_VALIDATION", e.getCode());
    }

    @Test
    void createTask_baselineWithEventId_rejected() {
        CreateTaskRequest req = new CreateTaskRequest("BASELINE", null, null, "EVT-001", null, null,
                null, null);
        stubExecuteRunsAction();
        when(properties.getFreezeWindow()).thenReturn(java.time.Duration.ofMinutes(30));

        BizException e = assertThrows(BizException.class, () -> commandService.createTask("key-1", req));
        assertEquals("E_VALIDATION", e.getCode());
    }

    @Test
    void createTask_rescheduleMissingRefs_rejected() {
        CreateTaskRequest req = new CreateTaskRequest("LOCAL_RESCHEDULE", null, null, null, null, null,
                null, null);
        stubExecuteRunsAction();
        when(properties.getFreezeWindow()).thenReturn(java.time.Duration.ofMinutes(30));

        BizException e = assertThrows(BizException.class, () -> commandService.createTask("key-1", req));
        assertEquals("E_VALIDATION", e.getCode());
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
    void cancelTask_pending_becomesCancelled() {
        ScheduleTask task = new ScheduleTask();
        task.setId("t1");
        task.setTaskCode("TSK-001");
        task.setStatus("PENDING");
        task.setFingerprint("fp-1");
        when(taskRepository.findById("t1")).thenReturn(Optional.of(task));

        ScheduleTaskDetailResponse data = commandService.cancelTask("t1");

        assertEquals("CANCELLED", task.getStatus());
        assertNull(task.getFingerprint());
        assertNotNull(task.getFinishedAt());
        assertEquals("CANCELLED", data.status());
        verify(auditService).record(eq("TASK_CANCELLED"), eq("schedule_task"), eq("t1"), any());
    }

    @Test
    void cancelTask_retryWait_becomesCancelled() {
        ScheduleTask task = runningTask();
        task.setStatus("RETRY_WAIT");
        task.setNextRetryAt(OffsetDateTime.now().plusSeconds(30));
        when(taskRepository.findById("t1")).thenReturn(Optional.of(task));

        commandService.cancelTask("t1");

        assertEquals("CANCELLED", task.getStatus());
        assertNull(task.getNextRetryAt());
        verify(auditService).record(eq("TASK_CANCELLED"), eq("schedule_task"), eq("t1"), any());
    }

    @Test
    void cancelTask_running_setsCancelRequestedOnly() {
        ScheduleTask task = runningTask();
        when(taskRepository.findById("t1")).thenReturn(Optional.of(task));

        ScheduleTaskDetailResponse data = commandService.cancelTask("t1");

        assertEquals("RUNNING", task.getStatus());
        assertTrue(task.getCancelRequested());
        assertEquals(Boolean.TRUE, data.cancelRequested());
        verify(auditService).record(eq("TASK_CANCEL_REQUESTED"), eq("schedule_task"), eq("t1"), any());
    }

    @Test
    void cancelTask_terminal_rejected() {
        ScheduleTask task = runningTask();
        task.setStatus("SUCCESS");
        when(taskRepository.findById("t1")).thenReturn(Optional.of(task));

        BizException e = assertThrows(BizException.class, () -> commandService.cancelTask("t1"));
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

        ScheduleTaskDetailResponse data = commandService.retryTask("t1");

        assertEquals("PENDING", task.getStatus());
        assertEquals(0, task.getRetryCount());
        assertFalse(task.getCancelRequested());
        assertNull(task.getErrorMessage());
        assertNull(task.getResultStatus());
        assertNull(task.getFinishedAt());
        assertNull(task.getNextRetryAt());
        assertNull(task.getTimeoutAt());
        assertNotNull(task.getFingerprint(), "人工重试应恢复指纹以继续去重保护");
        assertEquals("PENDING", data.status());
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

        BizException e = assertThrows(BizException.class, () -> commandService.retryTask("t1"));
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

        BizException e = assertThrows(BizException.class, () -> commandService.retryTask("t1"));
        assertEquals("E_DUPLICATE", e.getCode());
    }
}
