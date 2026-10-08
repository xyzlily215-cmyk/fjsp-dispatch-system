package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;

import com.fjsp.business.config.FjspProperties;
import com.fjsp.business.entity.ScheduleTask;
import com.fjsp.business.entity.TaskStatus;
import com.fjsp.business.metrics.FjspMetrics;
import com.fjsp.business.repository.ScheduleTaskRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class ScheduleTaskStateService {

    private static final Logger log = LoggerFactory.getLogger(ScheduleTaskStateService.class);

    private final ScheduleTaskRepository taskRepository;
    private final AuditService auditService;
    private final FjspProperties properties;
    private final TaskRunner taskRunner;
    private final TaskEventService taskEventService;
    private final FjspMetrics metrics;

    public ScheduleTaskStateService(ScheduleTaskRepository taskRepository,
                                    AuditService auditService,
                                    FjspProperties properties,
                                    @org.springframework.context.annotation.Lazy TaskRunner taskRunner,
                                    TaskEventService taskEventService,
                                    FjspMetrics metrics) {
        this.taskRepository = taskRepository;
        this.auditService = auditService;
        this.properties = properties;
        this.taskRunner = taskRunner;
        this.taskEventService = taskEventService;
        this.metrics = metrics;
    }

    /**
     * 原子抢占任务：仅当任务仍处于 PENDING/RETRY_WAIT 时置为 RUNNING。
     * 返回 false 表示任务已被取消或已被其他派发线程（启动恢复/周期扫描/afterCommit）抢先执行，
     * 调用方必须放弃本次派发，不得继续求解。
     */
    @Transactional
    public boolean markRunning(String taskId) {
        OffsetDateTime now = OffsetDateTime.now();
        int updated = taskRepository.markRunningIfDispatchable(taskId, now,
                now.plus(properties.getAlgorithm().getTimeout())
                        .plus(properties.getTask().getTimeoutBuffer()));
        if (updated == 0) {
            log.info("task {} dispatch aborted: not in PENDING/RETRY_WAIT (cancelled or already dispatched)", taskId);
            return false;
        }
        taskEventService.publish(taskId);
        return true;
    }

    @Transactional
    public void updateProgress(String taskId, int progress) {
        taskRepository.findById(taskId).ifPresent(t -> {
            t.setProgress(progress);
            taskRepository.save(t);
            taskEventService.publish(taskId);
        });
    }

    @Transactional
    public void markFailed(String taskId, String errorMessage) {
        ScheduleTask task = taskRepository.findById(taskId).orElseThrow();
        applyFailed(task, errorMessage);
    }

    /**
     * 瞬时失败（算法服务不可达 / 超时 / 进程中断）的统一入口：
     * retry_count+1 后未超 max_retries → RETRY_WAIT 等待退避重投；否则 FAILED 终态（死信）。
     */
    @Transactional
    public void scheduleRetryOrFail(String taskId, String reason) {
        ScheduleTask task = taskRepository.findById(taskId).orElseThrow();
        if (TaskStatus.CANCELLED.name().equals(task.getStatus())) {
            return;
        }
        if (Boolean.TRUE.equals(task.getCancelRequested())) {
            applyCancelled(task, "cancel requested, transient failure not retried: " + reason);
            return;
        }
        int retries = task.getRetryCount() + 1;
        task.setRetryCount(retries);
        if (retries <= task.getMaxRetries()) {
            long delaySeconds = TaskRetryPolicy.backoffSeconds(retries);
            task.setStatus(TaskStatus.RETRY_WAIT.name());
            task.setTimeoutAt(null);
            task.setNextRetryAt(OffsetDateTime.now().plusSeconds(delaySeconds));
            task.setErrorMessage(truncate(reason));
            taskRepository.save(task);
            metrics.recordRetry();
            auditService.record("TASK_RETRY_SCHEDULED", "schedule_task", taskId,
                    "retryCount=" + retries + ", maxRetries=" + task.getMaxRetries()
                            + ", nextRetryAt=" + task.getNextRetryAt() + ", reason=" + reason);
            taskEventService.publish(taskId);
        } else {
            applyFailed(task, reason + "（重试 " + task.getMaxRetries() + " 次后仍失败，转死信）");
        }
    }

    private void applyFailed(ScheduleTask task, String errorMessage) {
        task.setStatus(TaskStatus.FAILED.name());
        task.setResultStatus("FAILED");
        task.setFeasibleSolution(false);
        task.setErrorMessage(truncate(errorMessage));
        task.setProgress(100);
        task.setFinishedAt(OffsetDateTime.now());
        task.setTimeoutAt(null);
        task.setNextRetryAt(null);
        releaseFingerprint(task);
        taskRepository.save(task);
        metrics.recordTaskResult(task.getStatus());
        auditService.record("TASK_FAILED", "schedule_task", task.getId(), errorMessage);
        taskEventService.publish(task.getId());
    }

    void applyCancelled(ScheduleTask task, String detail) {
        task.setStatus(TaskStatus.CANCELLED.name());
        task.setCancelRequested(false);
        task.setFinishedAt(OffsetDateTime.now());
        task.setTimeoutAt(null);
        task.setNextRetryAt(null);
        releaseFingerprint(task);
        taskRepository.save(task);
        metrics.recordTaskResult(task.getStatus());
        auditService.record("TASK_CANCELLED", "schedule_task", task.getId(), detail);
        taskEventService.publish(task.getId());
    }

    // FAILED/CANCELLED 释放指纹：相同输入可重建任务，且 unique 约束在 dev(update) 下依然成立
    private void releaseFingerprint(ScheduleTask task) {
        task.setFingerprint(null);
    }

    private static String truncate(String message) {
        return message != null && message.length() > 1900 ? message.substring(0, 1900) : message;
    }

    // ---- scheduled scan & startup recovery ----

    @Transactional
    public void processTimeouts() {
        OffsetDateTime now = OffsetDateTime.now();
        for (ScheduleTask task : taskRepository.findByStatusAndTimeoutAtBefore(
                TaskStatus.RUNNING.name(), now)) {
            scheduleRetryOrFail(task.getId(), "TaskTimeout: 执行超过时限 timeoutAt=" + task.getTimeoutAt());
        }
    }

    public int redispatchDueRetries() {
        OffsetDateTime now = OffsetDateTime.now();
        List<ScheduleTask> due = taskRepository.findByStatusAndNextRetryAtLessThanEqual(
                TaskStatus.RETRY_WAIT.name(), now);
        for (ScheduleTask task : due) {
            log.info("redispatch retry-wait task {}", task.getTaskCode());
            taskRunner.run(task.getId());
        }
        return due.size();
    }

    @Transactional
    public void recoverInterruptedTasks() {
        for (ScheduleTask task : taskRepository.findByStatus(TaskStatus.RUNNING.name())) {
            auditService.record("TASK_RECOVERED", "schedule_task", task.getId(),
                    "process restarted while task was RUNNING; applying retry policy");
            scheduleRetryOrFail(task.getId(), "进程重启时任务仍处于 RUNNING，按中断恢复处理");
        }
    }

    public int redispatchPendingTasks() {
        OffsetDateTime now = OffsetDateTime.now();
        List<ScheduleTask> toDispatch = new ArrayList<>(
                taskRepository.findByStatus(TaskStatus.PENDING.name()));
        toDispatch.addAll(taskRepository.findByStatusAndNextRetryAtLessThanEqual(
                TaskStatus.RETRY_WAIT.name(), now));
        for (ScheduleTask task : toDispatch) {
            log.info("redispatch task {} on startup", task.getTaskCode());
            taskRunner.run(task.getId());
        }
        return toDispatch.size();
    }
}
