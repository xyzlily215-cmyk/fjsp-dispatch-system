package com.fjsp.business.it;

import java.util.List;

import com.fjsp.business.config.LocalSchemaInitializer;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.testcontainers.containers.PostgreSQLContainer;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** Fresh local deployment: Hibernate update and the local-only constraints must coexist. */
@SpringBootTest
@ActiveProfiles("local")
class LocalSchemaIT {

    @ServiceConnection
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:16");

    static {
        POSTGRES.start();
    }

    @Autowired
    private JdbcTemplate jdbcTemplate;
    @Autowired
    private LocalSchemaInitializer initializer;

    @Test
    void localBootCreatesPartialUniqueIndexesAndRerunIsSafe() {
        assertIndexesPresent();
        initializer.run(null);
        assertIndexesPresent();
    }

    private void assertIndexesPresent() {
        List<String> indexes = jdbcTemplate.queryForList(
                "SELECT indexname FROM pg_indexes WHERE schemaname='public' "
                        + "AND indexname LIKE 'uq_%' ORDER BY indexname", String.class);
        for (String expected : List.of("uq_execution_record_open_running",
                "uq_execution_record_open_pause", "uq_plan_version_single_active")) {
            assertEquals(1, indexes.stream().filter(expected::equals).count(), expected);
        }
    }
}
