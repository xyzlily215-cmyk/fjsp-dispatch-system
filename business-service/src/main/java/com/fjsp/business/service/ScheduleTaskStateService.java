package com.fjsp.business.service;

import java.time.OffsetDateTime;
import java.time.Duration;
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
import org.springframework.transaction.annotation.Propagation;
import org.springframework.core.task.TaskRejectedException;

@Service
public class ScheduleTaskStateService {

    private static final Logger log = LoggerFactory.getLogger(ScheduleTaskStateService.class);

    private final ScheduleTaskRepository taskRepository;
    private final AuditService auditService;
    private final FjspProperties properties;
    private final TaskRunner taskRunner;
    private final TaskEventService taskEventService;
    private final FjspMetrics metrics;

    @org.springframework.beans.factory.annotation.Autowired
    @org.springframework.context.annotation.Lazy
    private ScheduleTaskStateService self;

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
        ScheduleTask waiting = taskRepository.findById(taskId).orElse(null);
        int updated = taskRepository.markRunningIfDispatchable(taskId, now,
                now.plus(properties.getAlgorithm().getTimeout())
                        .plus(properties.getTask().getTimeoutBuffer()));
        if (updated == 0) {
            log.info("task {} dispatch aborted: not in PENDING/RETRY_WAIT (cancelled or already dispatched)", taskId);
            return false;
        }
        if (waiting != null) {
            OffsetDateTime queuedAt = TaskStatus.RETRY_WAIT.name().equals(waiting.getStatus())
                    && waiting.getNextRetryAt() != null ? waiting.getNextRetryAt() : waiting.getCreatedAt();
            metrics.recordQueueWait(waiting.getMode(), Duration.between(queuedAt, now));
        }
        taskEventService.publish(taskId);
        return true;
    }

    /** afterCommit 时原业务事务已经提交，需新事务写入可见的容量失败状态。 */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void markDispatchRejected(String taskId) {
        ScheduleTask task = taskRepository.findByIdForUpdate(taskId).orElseThrow();
        if (!TaskStatus.PENDING.name().equals(task.getStatus())
                && !TaskStatus.RETRY_WAIT.name().equals(task.getStatus())) {
            return;
        }
        metrics.recordDispatchRejected();
        applyFailed(task, "任务执行队列已满，请稍后人工重试");
    }

    /** 提交后投递抛出非容量异常：只重试明确未成功投递的任务。 */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void markDispatchFailed(String taskId, String reason) {
        ScheduleTask task = taskRepository.findByIdForUpdate(taskId).orElseThrow();
        if (!TaskStatus.PENDING.name().equals(task.getStatus())
                && !TaskStatus.RETRY_WAIT.name().equals(task.getStatus())) {
            return;
        }
        retryOrFail(task, "dispatch failed: " + reason);
    }

    @Transactional
    public void updateProgress(String taskId, int progress) {
        taskRepository.findByIdForUpdate(taskId).ifPresent(t -> {
            if (!TaskStatus.RUNNING.name().equals(t.getStatus())) {
                return;
            }
            t.setProgress(progress);
            taskRepository.save(t);
            taskEventService.publish(taskId);
        });
    }

    @Transactional
    public void markFailed(String taskId, String errorMessage) {
        ScheduleTask task = taskRepository.findByIdForUpdate(taskId).orElseThrow();
        if (!TaskStatus.RUNNING.name().equals(task.getStatus())) {
            return;
        }
        if (Boolean.TRUE.equals(task.getCancelRequested())) {
            applyCancelled(task, "cancel requested before failure: " + errorMessage);
            return;
        }
        applyFailed(task, errorMessage);
    }

    /**
     * 瞬时失败（算法服务不可达 / 超时 / 进程中断）的统一入口：
     * retry_count+1 后未超 max_retries → RETRY_WAIT 等待退避重投；否则 FAILED 终态（死信）。
     */
    @Transactional
    public void scheduleRetryOrFail(String taskId, String reason) {
        ScheduleTask task = taskRepository.findByIdForUpdate(taskId).orElseThrow();
        if (!TaskStatus.RUNNING.name().equals(task.getStatus())) {
            return;
        }
        if (Boolean.TRUE.equals(task.getCancelRequested())) {
            applyCancelled(task, "cancel requested, transient failure not retried: " + reason);
            return;
        }
        retryOrFail(task, reason);
    }

    private void retryOrFail(ScheduleTask task, String reason) {
        String taskId = task.getId();
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

    public void processTimeouts() {
        OffsetDateTime now = OffsetDateTime.now();
        for (ScheduleTask task : taskRepository.findByStatusAndTimeoutAtBefore(
                TaskStatus.RUNNING.name(), now)) {
            self.timeoutIfDue(task.getId(), now);
        }
    }

    @Transactional
    public void timeoutIfDue(String taskId, OffsetDateTime now) {
        ScheduleTask task = taskRepository.findByIdForUpdate(taskId).orElseThrow();
        if (!TaskStatus.RUNNING.name().equals(task.getStatus())
                || task.getTimeoutAt() == null || task.getTimeoutAt().isAfter(now)) {
            return;
        }
        String reason = "TaskTimeout: 执行超过时限 timeoutAt=" + task.getTimeoutAt();
        if (Boolean.TRUE.equals(task.getCancelRequested())) {
            applyCancelled(task, "cancel requested, transient failure not retried: " + reason);
        } else {
            retryOrFail(task, reason);
        }
    }

    public int redispatchDueRetries() {
        OffsetDateTime now = OffsetDateTime.now();
        List<ScheduleTask> due = taskRepository.findByStatusAndNextRetryAtLessThanEqual(
                TaskStatus.RETRY_WAIT.name(), now);
        for (ScheduleTask task : due) {
            log.info("redispatch retry-wait task {}", task.getTaskCode());
            dispatch(task);
        }
        return due.size();
    }

    public void recoverInterruptedTasks() {
        for (ScheduleTask task : taskRepository.findByStatus(TaskStatus.RUNNING.name())) {
            self.recoverInterruptedTask(task.getId(), task.getStartedAt());
        }
    }

    @Transactional
    public void recoverInterruptedTask(String taskId, OffsetDateTime startedAt) {
        ScheduleTask task = taskRepository.findByIdForUpdate(taskId).orElseThrow();
        if (!TaskStatus.RUNNING.name().equals(task.getStatus())
                || !java.util.Objects.equals(startedAt, task.getStartedAt())) {
            return;
        }
        auditService.record("TASK_RECOVERED", "schedule_task", taskId,
                "process restarted while task was RUNNING; applying retry policy");
        String reason = "进程重启时任务仍处于 RUNNING，按中断恢复处理";
        if (Boolean.TRUE.equals(task.getCancelRequested())) {
            applyCancelled(task, "cancel requested, transient failure not retried: " + reason);
        } else {
            retryOrFail(task, reason);
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
            dispatch(task);
        }
        return toDispatch.size();
    }

    private void dispatch(ScheduleTask task) {
        try {
            taskRunner.run(task.getId());
        } catch (TaskRejectedException e) {
            log.warn("task {} rejected: execution queue full", task.getTaskCode(), e);
            self.markDispatchRejected(task.getId());
        } catch (RuntimeException e) {
            log.error("task {} dispatch failed", task.getTaskCode(), e);
            self.markDispatchFailed(task.getId(), e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }
}
