package com.fjsp.business.actuator;

import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.flywaydb.core.api.MigrationInfoService;
import org.flywaydb.core.api.MigrationState;
import org.flywaydb.core.api.MigrationVersion;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.Status;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class FlywayMigrationHealthIndicatorTest {

    @SuppressWarnings("unchecked")
    private FlywayMigrationHealthIndicator indicator(Flyway flyway) {
        ObjectProvider<Flyway> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(flyway);
        return new FlywayMigrationHealthIndicator(provider);
    }

    private FlywayMigrationHealthIndicator indicator(MigrationInfoService info) {
        Flyway flyway = mock(Flyway.class);
        when(flyway.info()).thenReturn(info);
        return indicator(flyway);
    }

    private static MigrationInfo[] successfulMigrations(int count) {
        MigrationInfo[] migrations = new MigrationInfo[count];
        for (int i = 0; i < count; i++) {
            MigrationInfo migration = mock(MigrationInfo.class);
            when(migration.getState()).thenReturn(MigrationState.SUCCESS);
            migrations[i] = migration;
        }
        return migrations;
    }

    @Test
    void health_noFailedMigrations_upWithDetails() {
        MigrationInfoService info = mock(MigrationInfoService.class);
        MigrationInfo current = mock(MigrationInfo.class);
        when(current.getVersion()).thenReturn(MigrationVersion.fromVersion("12"));
        when(info.current()).thenReturn(current);
        MigrationInfo[] all = successfulMigrations(12);
        when(info.all()).thenReturn(all);
        when(info.applied()).thenReturn(new MigrationInfo[12]);
        when(info.pending()).thenReturn(new MigrationInfo[0]);

        Health health = indicator(info).health();

        assertEquals(Status.UP, health.getStatus());
        assertEquals("12", health.getDetails().get("currentVersion"));
        assertEquals(12, health.getDetails().get("appliedMigrations"));
        assertEquals(0L, health.getDetails().get("failedMigrations"));
    }

    @Test
    void health_failedMigration_down() {
        MigrationInfoService info = mock(MigrationInfoService.class);
        MigrationInfo failedMigration = mock(MigrationInfo.class);
        when(failedMigration.getState()).thenReturn(MigrationState.FAILED);
        when(info.all()).thenReturn(new MigrationInfo[]{mock(MigrationInfo.class), failedMigration});
        when(info.applied()).thenReturn(new MigrationInfo[3]);
        when(info.pending()).thenReturn(new MigrationInfo[0]);

        Health health = indicator(info).health();

        assertEquals(Status.DOWN, health.getStatus());
        assertEquals(1L, health.getDetails().get("failedMigrations"));
    }

    @Test
    void health_emptyHistory_upWithNoneVersion() {
        MigrationInfoService info = mock(MigrationInfoService.class);
        MigrationInfo[] all = successfulMigrations(2);
        when(info.all()).thenReturn(all);
        when(info.applied()).thenReturn(new MigrationInfo[0]);
        when(info.pending()).thenReturn(new MigrationInfo[2]);

        Health health = indicator(info).health();

        assertEquals(Status.UP, health.getStatus());
        assertEquals("none", health.getDetails().get("currentVersion"));
        assertEquals(2, health.getDetails().get("pendingMigrations"));
    }

    @Test
    void health_flywayDisabled_upWithEnabledFalse() {
        Health health = indicator((Flyway) null).health();

        assertEquals(Status.UP, health.getStatus());
        assertEquals(Boolean.FALSE, health.getDetails().get("enabled"));
    }
}
