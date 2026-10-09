package com.fjsp.business.auth;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 登录失败内存限流：同一用户名连续失败 {@link #MAX_FAILURES} 次锁定 {@link #LOCK_MILLIS} 毫秒。
 * 进程内实现（毕设单实例部署足够；多实例需换 Redis 等共享存储）。
 * 记录清理：登录成功 / 锁定期满时删除；容量达 {@link #MAX_ENTRIES} 上限时整体清空兜底，
 * 避免 username 无限堆积。
 */
class LoginRateLimiter {

    static final int MAX_FAILURES = 5;
    static final long LOCK_MILLIS = 10 * 60 * 1000L;
    private static final int MAX_ENTRIES = 10_000;

    private record Failure(int attempts, long lockedUntilMillis) {
    }

    private final Map<String, Failure> failures = new ConcurrentHashMap<>();

    boolean isLocked(String username) {
        Failure failure = failures.get(username);
        if (failure == null || failure.lockedUntilMillis() <= 0) {
            return false;
        }
        if (System.currentTimeMillis() < failure.lockedUntilMillis()) {
            return true;
        }
        // 锁定期满：清除记录，重新开始计数
        failures.remove(username, failure);
        return false;
    }

    void onFailure(String username) {
        if (failures.size() >= MAX_ENTRIES) {
            failures.clear();
        }
        failures.compute(username, (key, old) -> {
            int attempts = (old == null ? 0 : old.attempts()) + 1;
            long lockedUntil = attempts >= MAX_FAILURES ? System.currentTimeMillis() + LOCK_MILLIS : 0;
            return new Failure(attempts, lockedUntil);
        });
    }

    void onSuccess(String username) {
        failures.remove(username);
    }
}
