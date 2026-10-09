package com.fjsp.business.service;

import com.fjsp.business.config.FjspProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.SchedulingConfigurer;
import org.springframework.scheduling.config.ScheduledTaskRegistrar;
import org.springframework.stereotype.Component;

/**
 * 周期扫描：超时 RUNNING 任务按重试策略处理；到期的 RETRY_WAIT 任务重新投递。
 * 编程式注册（SchedulingConfigurer），间隔直接取自注入的 FjspProperties
 * （fjsp.task.scan-interval，Duration，默认 30s），替代原先按 bean 名拼接的 SpEL
 * 字符串——后者在包名/bean 名重构时会悄悄失效。
 */
@Component
public class TaskTimeoutScanner implements SchedulingConfigurer {

    private static final Logger log = LoggerFactory.getLogger(TaskTimeoutScanner.class);

    private final TaskService taskService;
    private final FjspProperties properties;

    public TaskTimeoutScanner(TaskService taskService, FjspProperties properties) {
        this.taskService = taskService;
        this.properties = properties;
    }

    @Override
    public void configureTasks(ScheduledTaskRegistrar registrar) {
        registrar.addFixedDelayTask(this::scan, properties.getTask().getScanInterval());
    }

    void scan() {
        try {
            taskService.processTimeouts();
            taskService.redispatchDueRetries();
        } catch (Exception e) {
            log.error("task timeout scan failed", e);
        }
    }
}
