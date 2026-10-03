package com.fjsp.business.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

/**
 * 启动恢复：上次进程死亡残留的 RUNNING 任务转 RETRY_WAIT/FAILED（审计 TASK_RECOVERED）；
 * PENDING 与到期的 RETRY_WAIT 任务重新投递。
 */
@Component
public class TaskRecoveryRunner implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(TaskRecoveryRunner.class);

    private final TaskService taskService;

    public TaskRecoveryRunner(TaskService taskService) {
        this.taskService = taskService;
    }

    @Override
    public void run(ApplicationArguments args) {
        try {
            taskService.recoverInterruptedTasks();
            int dispatched = taskService.redispatchPendingTasks();
            if (dispatched > 0) {
                log.info("startup recovery redispatched {} task(s)", dispatched);
            }
        } catch (Exception e) {
            log.error("startup task recovery failed", e);
        }
    }
}
