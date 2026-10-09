package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fjsp.business.client.AlgorithmClient;
import com.fjsp.business.config.FjspProperties;
import com.fjsp.business.entity.InputSnapshot;
import com.fjsp.business.entity.PlanVersion;
import com.fjsp.business.entity.ScheduleOperation;
import com.fjsp.business.entity.ScheduleTask;
import com.fjsp.business.repository.InputSnapshotRepository;
import com.fjsp.business.repository.PlanVersionRepository;
import com.fjsp.business.repository.ScheduleOperationRepository;
import com.fjsp.business.repository.ScheduleTaskRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.Spy;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class ScheduleResultAssemblerTest {

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
    private AlgorithmClient algorithmClient;
    @Mock
    private CodeGenerator codeGenerator;
    @Mock
    private AuditService auditService;
    @Mock
    private FjspProperties properties;
    @Mock
    private TaskRunner taskRunner;
    @Mock
    private ScheduleIntegrityGuard integrityGuard;
    @Mock
    private TaskEventService taskEventService;
    @Mock
    private com.fjsp.business.metrics.FjspMetrics metrics;
    @Spy
    private ValidateRequestFactory validateRequestFactory = new ValidateRequestFactory();

    private ScheduleResultAssembler resultAssembler;

    @BeforeEach
    void setUp() {
        ScheduleTaskStateService stateService = new ScheduleTaskStateService(
                taskRepository, auditService, properties, taskRunner, taskEventService, metrics);
        resultAssembler = new ScheduleResultAssembler(taskRepository, snapshotRepository,
                planVersionRepository, scheduleOperationRepository, algorithmClient, codeGenerator,
                auditService, integrityGuard, taskEventService, validateRequestFactory, stateService,
                metrics);
        // 生产代码通过 @Lazy 自注入代理拆分事务；单元测试无 Spring 代理，直接指向自身
        org.springframework.test.util.ReflectionTestUtils.setField(resultAssembler, "self", resultAssembler);
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
        when(codeGenerator.next("PV")).thenReturn("PV-001");

        resultAssembler.handleSolveResult("t1", feasibleResponse("SUCCESS"));

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
        verify(metrics).recordTaskResult("SUCCESS");
    }

    @Test
    void handleSolveResult_timeLimitButFeasible_stillCreatesPlan() throws Exception {
        ScheduleTask task = runningTask();
        when(taskRepository.findById("t1")).thenReturn(Optional.of(task));
        stubSnapshotForValidate();
        when(algorithmClient.validate(any())).thenReturn(JSON.readTree("{\"passed\": true}"));
        when(codeGenerator.next("PV")).thenReturn("PV-001");

        resultAssembler.handleSolveResult("t1", feasibleResponse("TIME_LIMIT"));

        verify(planVersionRepository).save(any(PlanVersion.class));
        assertEquals("TIME_LIMIT", task.getStatus());
        assertEquals("FEASIBLE", task.getResultStatus());
        verify(metrics).recordTaskResult("TIME_LIMIT");
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

        resultAssembler.handleSolveResult("t1", resp);

        verify(planVersionRepository, never()).save(any());
        verify(scheduleOperationRepository, never()).save(any());
        verify(algorithmClient, never()).validate(any());
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

        resultAssembler.handleSolveResult("t1", feasibleResponse("SUCCESS"));

        verify(planVersionRepository, never()).save(any());
        assertEquals("INFEASIBLE", task.getResultStatus());
        assertEquals(Boolean.FALSE, task.getFeasibleSolution());
        assertTrue(task.getConflicts().contains("PRECEDENCE_VIOLATION"));
        assertEquals(100, task.getProgress());
    }

    @Test
    void handleSolveResult_cancelRequested_discardsResult() throws Exception {
        ScheduleTask task = runningTask();
        task.setCancelRequested(true);
        task.setFingerprint("fp-1");
        when(taskRepository.findById("t1")).thenReturn(Optional.of(task));

        resultAssembler.handleSolveResult("t1", feasibleResponse("SUCCESS"));

        assertEquals("CANCELLED", task.getStatus());
        assertFalse(task.getCancelRequested());
        assertNull(task.getFingerprint());
        assertNotNull(task.getFinishedAt());
        verify(planVersionRepository, never()).save(any());
        verify(scheduleOperationRepository, never()).save(any());
        verify(algorithmClient, never()).validate(any());
        verify(auditService).record(eq("TASK_CANCELLED"), eq("schedule_task"), eq("t1"), any());
    }
}
