package com.fjsp.business.service;

import java.time.Duration;

import com.fasterxml.jackson.databind.JsonNode;
import com.fjsp.business.client.AlgorithmClient;
import com.fjsp.business.entity.InputSnapshot;
import com.fjsp.business.metrics.FjspMetrics;
import com.fjsp.business.repository.InputSnapshotRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClientException;

@Service
public class TaskRunner {

    private static final Logger log = LoggerFactory.getLogger(TaskRunner.class);

    private final TaskService taskService;
    private final InputSnapshotRepository snapshotRepository;
    private final AlgorithmClient algorithmClient;
    private final FjspMetrics metrics;

    public TaskRunner(TaskService taskService,
                      InputSnapshotRepository snapshotRepository,
                      AlgorithmClient algorithmClient,
                      FjspMetrics metrics) {
        this.taskService = taskService;
        this.snapshotRepository = snapshotRepository;
        this.algorithmClient = algorithmClient;
        this.metrics = metrics;
    }

    @Async("scheduleTaskExecutor")
    public void run(String taskId) {
        try {
            if (!taskService.markRunning(taskId)) {
                // 任务已被取消或被其他派发线程抢占，直接放弃本次执行
                return;
            }
            InputSnapshot snapshot = snapshotRepository.findByTaskId(taskId)
                    .orElseThrow(() -> new IllegalStateException("snapshot missing for task " + taskId));
            String mode = String.valueOf(snapshot.getSnapshotJson().getOrDefault("mode", "UNKNOWN"));
            log.info("calling algorithm service /solve for task {}", taskId);
            long solveStart = System.nanoTime();
            JsonNode resp;
            try {
                resp = algorithmClient.solve(snapshot.getSnapshotJson());
            } catch (RestClientException e) {
                metrics.recordSolveDuration(mode, Duration.ofNanos(System.nanoTime() - solveStart));
                throw e;
            }
            metrics.recordSolveDuration(mode, Duration.ofNanos(System.nanoTime() - solveStart));
            taskService.handleSolveResult(taskId, resp);
        } catch (RestClientException e) {
            // 算法服务调用失败（连接拒绝/读超时/5xx 等）视为瞬时故障，走重试策略
            log.warn("task {} transient algorithm call failure, applying retry policy", taskId, e);
            try {
                taskService.scheduleRetryOrFail(taskId, e.getClass().getSimpleName() + ": " + e.getMessage());
            } catch (Exception inner) {
                log.error("cannot schedule retry for task {}", taskId, inner);
            }
        } catch (Exception e) {
            log.error("task {} failed", taskId, e);
            try {
                taskService.markFailed(taskId, e.getClass().getSimpleName() + ": " + e.getMessage());
            } catch (Exception inner) {
                log.error("cannot mark task {} failed", taskId, inner);
            }
        }
    }
}
