package com.fjsp.business.service;

import java.util.Map;
import java.util.Optional;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fjsp.business.client.AlgorithmClient;
import com.fjsp.business.entity.InputSnapshot;
import com.fjsp.business.repository.InputSnapshotRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InOrder;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.core.NestedRuntimeException;
import org.springframework.web.client.ResourceAccessException;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class TaskRunnerTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Mock
    private TaskService taskService;
    @Mock
    private InputSnapshotRepository snapshotRepository;
    @Mock
    private AlgorithmClient algorithmClient;

    @InjectMocks
    private TaskRunner taskRunner;

    private InputSnapshot snapshot() {
        InputSnapshot snapshot = new InputSnapshot();
        snapshot.setId("snap-1");
        snapshot.setTaskId("t1");
        snapshot.setSnapshotJson(Map.of("mode", "BASELINE"));
        return snapshot;
    }

    @Test
    void run_happyPath_marksRunningThenSolvesThenHandles() throws Exception {
        when(snapshotRepository.findByTaskId("t1")).thenReturn(Optional.of(snapshot()));
        JsonNode resp = JSON.readTree("{\"status\": \"SUCCESS\", \"feasibleSolution\": true}");
        when(algorithmClient.solve(any())).thenReturn(resp);

        taskRunner.run("t1");

        InOrder order = inOrder(taskService, algorithmClient);
        order.verify(taskService).markRunning("t1");
        order.verify(algorithmClient).solve(any());
        order.verify(taskService).handleSolveResult("t1", resp);
        verify(taskService, never()).markFailed(anyString(), any());
        verify(taskService, never()).scheduleRetryOrFail(anyString(), any());
    }

    @Test
    void run_solveTimeout_schedulesRetry() {
        when(snapshotRepository.findByTaskId("t1")).thenReturn(Optional.of(snapshot()));
        when(algorithmClient.solve(any()))
                .thenThrow(new ResourceAccessException("I/O error on POST request: Read timed out"));

        taskRunner.run("t1");

        verify(taskService).markRunning("t1");
        verify(taskService).scheduleRetryOrFail(eq("t1"), argThat(msg ->
                msg.contains("ResourceAccessException") && msg.contains("Read timed out")));
        verify(taskService, never()).handleSolveResult(anyString(), any());
        verify(taskService, never()).markFailed(anyString(), any());
    }

    @Test
    void run_serviceUnavailable_schedulesRetry() {
        when(snapshotRepository.findByTaskId("t1")).thenReturn(Optional.of(snapshot()));
        when(algorithmClient.solve(any()))
                .thenThrow(new ResourceAccessException("I/O error on POST request: Connection refused"));

        taskRunner.run("t1");

        verify(taskService).scheduleRetryOrFail(eq("t1"), argThat(msg ->
                msg.contains("ResourceAccessException") && msg.contains("Connection refused")));
        verify(taskService, never()).handleSolveResult(anyString(), any());
        verify(taskService, never()).markFailed(anyString(), any());
    }

    @Test
    void run_handleResultTransient_schedulesRetry() throws Exception {
        when(snapshotRepository.findByTaskId("t1")).thenReturn(Optional.of(snapshot()));
        JsonNode resp = JSON.readTree("{\"status\": \"SUCCESS\", \"feasibleSolution\": true}");
        when(algorithmClient.solve(any())).thenReturn(resp);
        org.mockito.Mockito.doThrow(new ResourceAccessException("Connection refused"))
                .when(taskService).handleSolveResult("t1", resp);

        taskRunner.run("t1");

        verify(taskService).scheduleRetryOrFail(eq("t1"), argThat(msg -> msg.contains("Connection refused")));
        verify(taskService, never()).markFailed(anyString(), any());
    }

    @Test
    void run_nonTransientError_marksFailed() {
        when(snapshotRepository.findByTaskId("t1")).thenReturn(Optional.of(snapshot()));
        when(algorithmClient.solve(any()))
                .thenThrow(new NestedRuntimeException("500 Internal Server Error") {
                });

        taskRunner.run("t1");

        verify(taskService).markFailed(eq("t1"), argThat(msg -> msg.contains("500")));
        verify(taskService, never()).scheduleRetryOrFail(anyString(), any());
    }

    @Test
    void run_snapshotMissing_marksFailed() {
        when(snapshotRepository.findByTaskId("t1")).thenReturn(Optional.empty());

        taskRunner.run("t1");

        verify(taskService).markRunning("t1");
        verify(taskService).markFailed(eq("t1"), argThat(msg -> msg.contains("IllegalStateException")));
        verify(algorithmClient, never()).solve(any());
        verify(taskService, never()).scheduleRetryOrFail(anyString(), any());
    }
}
