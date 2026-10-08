package com.fjsp.business.it;

import java.util.List;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Flyway 迁移与实体映射的真实回归：V1-V4 在空库执行成功、validate 通过、索引存在。 */
class FlywaySchemaIT extends AbstractPostgresIT {

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void schemaHistory_allMigrationsSuccess() {
        List<String> versions = jdbcTemplate.queryForList(
                "SELECT version || ':' || type || ':' || success FROM flyway_schema_history ORDER BY installed_rank",
                String.class);
        // 空库：V1-V4 全部以 SQL 迁移执行（无 baseline 行），全部 success
        assertEquals(4, versions.size());
        assertTrue(versions.get(0).startsWith("1:SQL:true"));
        assertTrue(versions.stream().allMatch(v -> v.endsWith(":SQL:true")), "全部迁移成功: " + versions);
    }

    @Test
    void businessTables_allPresent() {
        Integer count = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM information_schema.tables "
                        + "WHERE table_schema='public' AND table_name <> 'flyway_schema_history'",
                Integer.class);
        // 17 张业务表 + app_user
        assertEquals(18, count);
    }

    @Test
    void v4Indexes_present() {
        List<String> indexes = jdbcTemplate.queryForList(
                "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname LIKE 'idx_%'",
                String.class);
        assertEquals(18, indexes.size());
        for (String expected : List.of("idx_schedule_task_status", "idx_event_occurred_at",
                "idx_plan_version_parent_id", "idx_audit_log_object", "idx_schedule_operation_machine")) {
            assertTrue(indexes.contains(expected), "缺少索引 " + expected);
        }
    }
}
