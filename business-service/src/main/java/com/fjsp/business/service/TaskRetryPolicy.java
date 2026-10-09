package com.fjsp.business.service;

/**
 * 任务瞬时失败的重试退避策略：30s 起步指数翻倍，封顶 600s。
 * retryCount 为已发生的失败次数（1 起算）：1→30s, 2→60s, 3→120s, 4→240s, 5→480s, ≥6→600s。
 */
public final class TaskRetryPolicy {

    public static final long BASE_SECONDS = 30;
    public static final long MAX_SECONDS = 600;

    private TaskRetryPolicy() {
    }

    public static long backoffSeconds(int retryCount) {
        if (retryCount <= 1) {
            return BASE_SECONDS;
        }
        long delay = BASE_SECONDS << Math.min(retryCount - 1, 10);
        return Math.min(delay, MAX_SECONDS);
    }
}
