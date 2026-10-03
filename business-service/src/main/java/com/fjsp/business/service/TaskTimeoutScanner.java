package com.fjsp.business.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * 周期扫描：超时 RUNNING 任务按重试策略处理；到期的 RETRY_WAIT 任务重新投递。
 * 间隔由 fjsp.task.scan-interval-ms 控制（默认 30000）。
 */
@Component
public class TaskTimeoutScanner {

    private static final Logger log = LoggerFactory.getLogger(TaskTimeoutScanner.class);

    private final TaskService taskService;

    public TaskTimeoutScanner(TaskService taskService) {
        this.taskService = taskService;
    }

    @Scheduled(fixedDelayString = "${fjsp.task.scan-interval-ms:30000}")
    public void scan() {
        try {
            taskService.processTimeouts();
            taskService.redispatchDueRetries();
        } catch (Exception e) {
            log.error("task timeout scan failed", e);
        }
    }
}
