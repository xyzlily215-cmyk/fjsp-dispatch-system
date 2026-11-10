package com.fjsp.business.metrics;

import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.List;

import com.fjsp.business.entity.TaskStatus;
import com.fjsp.business.repository.ScheduleTaskRepository;
import com.fjsp.business.service.TaskEventService;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;
import org.springframework.stereotype.Component;

/**
 * FJSP 业务指标。Gauge 直接以仓库 count 为 supplier（任务表量级小，scrape 时查询成本可忽略）；
 * Counter/Timer 由状态机与任务派发链路在状态迁移点递增。
 */
@Component
public class FjspMetrics {

    public static final String TASKS_TOTAL = "fjsp.tasks.total";
    public static final String TASKS_QUEUE = "fjsp.tasks.queue";
    public static final String TASKS_RETRIES = "fjsp.tasks.retries";
    public static final String TASKS_RESULT = "fjsp.tasks.result";
    public static final String SOLVE_DURATION = "fjsp.algorithm.solve.duration";
    public static final String TASKS_QUEUE_WAIT = "fjsp.tasks.queue.wait";
    public static final String TASKS_DISPATCH_REJECTED = "fjsp.tasks.dispatch.rejected";
    public static final String TASKS_OLDEST_READY_SECONDS = "fjsp.tasks.oldest.ready.seconds";
    public static final String EXECUTOR_ACTIVE = "fjsp.executor.active";
    public static final String EXECUTOR_POOL_SIZE = "fjsp.executor.pool.size";
    public static final String EXECUTOR_QUEUE_SIZE = "fjsp.executor.queue.size";
    public static final String EXECUTOR_QUEUE_REMAINING = "fjsp.executor.queue.remaining";
    public static final String SSE_CONNECTIONS = "fjsp.sse.connections";

    private final MeterRegistry registry;

    public FjspMetrics(MeterRegistry registry,
                       ScheduleTaskRepository taskRepository,
                       TaskEventService taskEventService,
                       @Qualifier("scheduleTaskExecutor") ThreadPoolTaskExecutor executor) {
        this.registry = registry;
        for (TaskStatus status : TaskStatus.values()) {
            Gauge.builder(TASKS_TOTAL, taskRepository, repo -> repo.countByStatus(status.name()))
                    .tag("status", status.name())
                    .description("调度任务数量（按状态）")
                    .register(registry);
        }
        Gauge.builder(TASKS_QUEUE, taskRepository,
                        repo -> repo.countByStatusIn(List.of(
                                TaskStatus.PENDING.name(), TaskStatus.RETRY_WAIT.name())))
                .description("排队中的调度任务数（PENDING + RETRY_WAIT）")
                .register(registry);
        Gauge.builder(TASKS_OLDEST_READY_SECONDS, taskRepository, FjspMetrics::oldestReadySeconds)
                .description("最老可派发任务年龄：PENDING 自创建起，到期 RETRY_WAIT 自到期起（秒）")
                .register(registry);
        Gauge.builder(EXECUTOR_ACTIVE, executor, ThreadPoolTaskExecutor::getActiveCount)
                .register(registry);
        Gauge.builder(EXECUTOR_POOL_SIZE, executor, ThreadPoolTaskExecutor::getPoolSize)
                .register(registry);
        Gauge.builder(EXECUTOR_QUEUE_SIZE, executor, e -> e.getThreadPoolExecutor().getQueue().size())
                .register(registry);
        Gauge.builder(EXECUTOR_QUEUE_REMAINING, executor,
                        e -> e.getThreadPoolExecutor().getQueue().remainingCapacity())
                .register(registry);
        Gauge.builder(SSE_CONNECTIONS, taskEventService, TaskEventService::activeEmitterCount)
                .description("当前任务进度 SSE 订阅连接数")
                .register(registry);
    }

    private static double oldestReadySeconds(ScheduleTaskRepository repo) {
        OffsetDateTime now = OffsetDateTime.now();
        OffsetDateTime oldest = repo.oldestPendingCreatedAt().orElse(null);
        OffsetDateTime retry = repo.oldestDueRetryAt(now).orElse(null);
        if (oldest == null || (retry != null && retry.isBefore(oldest))) {
            oldest = retry;
        }
        return oldest == null ? 0 : Math.max(0, Duration.between(oldest, now).toSeconds());
    }

    /** 记录一次算法 /solve 调用耗时（成功与瞬时失败均记录），mode ∈ BASELINE/LOCAL_RESCHEDULE/FULL_RESCHEDULE。 */
    public void recordSolveDuration(String mode, Duration duration) {
        registry.timer(SOLVE_DURATION, "mode", mode != null ? mode : "UNKNOWN").record(duration);
    }

    public void recordQueueWait(String mode, Duration duration) {
        registry.timer(TASKS_QUEUE_WAIT, "mode", mode != null ? mode : "UNKNOWN")
                .record(duration.isNegative() ? Duration.ZERO : duration);
    }

    public void recordDispatchRejected() {
        registry.counter(TASKS_DISPATCH_REJECTED).increment();
    }

    /** 任务被重新排队（自动退避重试或人工重试）。 */
    public void recordRetry() {
        registry.counter(TASKS_RETRIES).increment();
    }

    /** 任务到达终态，result 取终态 status：SUCCESS/TIME_LIMIT/INFEASIBLE/FAILED/CANCELLED。 */
    public void recordTaskResult(String result) {
        registry.counter(TASKS_RESULT, "result", result).increment();
    }
}
