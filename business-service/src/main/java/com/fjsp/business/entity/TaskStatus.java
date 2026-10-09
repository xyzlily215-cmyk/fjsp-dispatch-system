package com.fjsp.business.entity;

import java.util.List;

/**
 * schedule_task.status 的取值集合。数据库列仍为字符串，代码中统一以枚举 name() 存取。
 * 终态：SUCCESS / TIME_LIMIT / INFEASIBLE / FAILED / CANCELLED。
 */
public enum TaskStatus {
    PENDING,
    RUNNING,
    RETRY_WAIT,
    SUCCESS,
    TIME_LIMIT,
    INFEASIBLE,
    FAILED,
    CANCELLED;

    /**
     * 指纹去重时拦截重复提交的状态：进行中与成功终态仍阻止重建；
     * FAILED / CANCELLED 放行，允许以相同输入重新创建任务。
     */
    public static List<String> blockingStatuses() {
        return List.of(PENDING.name(), RUNNING.name(), RETRY_WAIT.name(),
                SUCCESS.name(), TIME_LIMIT.name(), INFEASIBLE.name());
    }

    public static boolean isTerminal(String status) {
        return SUCCESS.name().equals(status) || TIME_LIMIT.name().equals(status)
                || INFEASIBLE.name().equals(status) || FAILED.name().equals(status)
                || CANCELLED.name().equals(status);
    }
}
