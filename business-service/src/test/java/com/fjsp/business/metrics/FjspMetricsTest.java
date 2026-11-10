package com.fjsp.business.metrics;

import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

import com.fjsp.business.config.FjspProperties;
import com.fjsp.business.entity.ScheduleTask;
import com.fjsp.business.entity.TaskStatus;
import com.fjsp.business.repository.ScheduleTaskRepository;
import com.fjsp.business.service.TaskEventService;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;
import org.junit.jupiter.api.AfterEach;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class FjspMetricsTest {

    @Mock
    private ScheduleTaskRepository taskRepository;

    private MeterRegistry registry;
    private TaskEventService taskEventService;
    private FjspMetrics metrics;
    private ThreadPoolTaskExecutor executor;

    @BeforeEach
    void setUp() {
        registry = new SimpleMeterRegistry();
        taskEventService = new TaskEventService(taskRepository, new FjspProperties());
        executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(1);
        executor.setQueueCapacity(2);
        executor.initialize();
        metrics = new FjspMetrics(registry, taskRepository, taskEventService, executor);
    }

    @AfterEach
    void tearDown() {
        executor.shutdown();
        registry.close();
    }

    @Test
    void gaugesRegisteredForEveryTaskStatus() {
        for (TaskStatus status : TaskStatus.values()) {
            assertNotNull(registry.get(FjspMetrics.TASKS_TOTAL).tag("status", status.name()).gauge(),
                    "缺少 status=" + status.name() + " 的 fjsp.tasks.total Gauge");
        }
        assertNotNull(registry.get(FjspMetrics.TASKS_QUEUE).gauge());
        assertNotNull(registry.get(FjspMetrics.TASKS_OLDEST_READY_SECONDS).gauge());
        assertNotNull(registry.get(FjspMetrics.EXECUTOR_ACTIVE).gauge());
        assertNotNull(registry.get(FjspMetrics.EXECUTOR_POOL_SIZE).gauge());
        assertNotNull(registry.get(FjspMetrics.EXECUTOR_QUEUE_SIZE).gauge());
        assertNotNull(registry.get(FjspMetrics.EXECUTOR_QUEUE_REMAINING).gauge());
        assertNotNull(registry.get(FjspMetrics.SSE_CONNECTIONS).gauge());
    }

    @Test
    void gaugesReadLiveValuesFromRepositoryAndEventService() {
        when(taskRepository.countByStatus("PENDING")).thenReturn(3L);
        when(taskRepository.countByStatusIn(any())).thenReturn(5L);
        ScheduleTask task = new ScheduleTask();
        task.setId("t1");
        task.setTaskCode("TSK-001");
        task.setStatus("PENDING");
        task.setProgress(0);
        taskEventService.subscribe(task);

        assertEquals(3.0, registry.get(FjspMetrics.TASKS_TOTAL).tag("status", "PENDING").gauge().value());
        assertEquals(5.0, registry.get(FjspMetrics.TASKS_QUEUE).gauge().value());
        assertEquals(1.0, registry.get(FjspMetrics.SSE_CONNECTIONS).gauge().value());
    }

    @Test
    void retryCounterIncrements() {
        metrics.recordRetry();
        metrics.recordRetry();

        assertEquals(2.0, registry.get(FjspMetrics.TASKS_RETRIES).counter().count());
    }

    @Test
    void taskResultCounterTaggedByTerminalStatus() {
        metrics.recordTaskResult("SUCCESS");
        metrics.recordTaskResult("TIME_LIMIT");
        metrics.recordTaskResult("INFEASIBLE");
        metrics.recordTaskResult("INFEASIBLE");

        assertEquals(1.0, registry.get(FjspMetrics.TASKS_RESULT).tag("result", "SUCCESS").counter().count());
        assertEquals(1.0, registry.get(FjspMetrics.TASKS_RESULT).tag("result", "TIME_LIMIT").counter().count());
        assertEquals(2.0, registry.get(FjspMetrics.TASKS_RESULT).tag("result", "INFEASIBLE").counter().count());
    }

    @Test
    void solveDurationTimerTaggedByMode() {
        metrics.recordSolveDuration("BASELINE", Duration.ofMillis(120));
        metrics.recordSolveDuration("LOCAL_RESCHEDULE", Duration.ofMillis(80));

        var baseline = registry.get(FjspMetrics.SOLVE_DURATION).tag("mode", "BASELINE").timer();
        assertEquals(1, baseline.count());
        assertEquals(0.12, baseline.totalTime(TimeUnit.SECONDS), 0.001);
        assertEquals(1, registry.get(FjspMetrics.SOLVE_DURATION).tag("mode", "LOCAL_RESCHEDULE").timer().count());
    }

    @Test
    void queueWaitAndRejectionAreRecorded() {
        metrics.recordQueueWait("BASELINE", Duration.ofSeconds(3));
        metrics.recordQueueWait("BASELINE", Duration.ofSeconds(-1));
        metrics.recordDispatchRejected();

        var wait = registry.get(FjspMetrics.TASKS_QUEUE_WAIT).tag("mode", "BASELINE").timer();
        assertEquals(2, wait.count());
        assertEquals(3.0, wait.totalTime(TimeUnit.SECONDS), 0.001);
        assertEquals(1.0, registry.get(FjspMetrics.TASKS_DISPATCH_REJECTED).counter().count());
    }

    @Test
    void oldestReadyGaugeExcludesFutureRetryAndResetsWhenEmpty() {
        when(taskRepository.oldestPendingCreatedAt()).thenReturn(Optional.empty(),
                Optional.of(OffsetDateTime.now().minusSeconds(12)));
        when(taskRepository.oldestDueRetryAt(any())).thenReturn(Optional.empty(), Optional.empty());
        var gauge = registry.get(FjspMetrics.TASKS_OLDEST_READY_SECONDS).gauge();

        assertEquals(0.0, gauge.value());
        org.junit.jupiter.api.Assertions.assertTrue(gauge.value() >= 11.0);
    }

    @Test
    void oldestReadyGaugeUsesEarlierDueRetry() {
        when(taskRepository.oldestPendingCreatedAt())
                .thenReturn(Optional.of(OffsetDateTime.now().minusSeconds(5)));
        when(taskRepository.oldestDueRetryAt(any()))
                .thenReturn(Optional.of(OffsetDateTime.now().minusSeconds(20)));

        double seconds = registry.get(FjspMetrics.TASKS_OLDEST_READY_SECONDS).gauge().value();

        org.junit.jupiter.api.Assertions.assertTrue(seconds >= 19 && seconds < 30);
    }

    @Test
    void executorGaugeReadsLiveQueueCapacity() {
        assertEquals(0.0, registry.get(FjspMetrics.EXECUTOR_ACTIVE).gauge().value());
        assertEquals(0.0, registry.get(FjspMetrics.EXECUTOR_QUEUE_SIZE).gauge().value());
        assertEquals(2.0, registry.get(FjspMetrics.EXECUTOR_QUEUE_REMAINING).gauge().value());
    }
}
