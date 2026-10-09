package com.fjsp.business.actuator;

import java.util.Arrays;

import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.flywaydb.core.api.MigrationInfoService;
import org.flywaydb.core.api.MigrationState;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.stereotype.Component;

/**
 * Flyway 迁移健康指示器：Boot 3.3 移除了内置 flyway 健康探针（Flyway 10 模块化），
 * 此处基于迁移状态补齐——存在失败迁移即 DOWN。local profile 关闭 Flyway（无 Flyway bean）
 * 时报告 UP + enabled=false，保证 readiness 分组配置在所有 profile 下一致。
 */
@Component("flywayHealthIndicator")
public class FlywayMigrationHealthIndicator implements HealthIndicator {

    private final ObjectProvider<Flyway> flywayProvider;

    public FlywayMigrationHealthIndicator(ObjectProvider<Flyway> flywayProvider) {
        this.flywayProvider = flywayProvider;
    }

    @Override
    public Health health() {
        Flyway flyway = flywayProvider.getIfAvailable();
        if (flyway == null) {
            return Health.up().withDetail("enabled", false).build();
        }
        MigrationInfoService info = flyway.info();
        long failed = Arrays.stream(info.all())
                .filter(m -> m.getState() == MigrationState.FAILED
                        || m.getState() == MigrationState.MISSING_FAILED
                        || m.getState() == MigrationState.FUTURE_FAILED)
                .count();
        MigrationInfo current = info.current();
        return (failed > 0 ? Health.down() : Health.up())
                .withDetail("currentVersion",
                        current != null && current.getVersion() != null ? current.getVersion().toString() : "none")
                .withDetail("appliedMigrations", info.applied().length)
                .withDetail("pendingMigrations", info.pending().length)
                .withDetail("failedMigrations", failed)
                .build();
    }
}
