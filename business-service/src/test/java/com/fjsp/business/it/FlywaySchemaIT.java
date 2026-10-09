package com.fjsp.business.it;

import java.util.List;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Flyway 迁移与实体映射的真实回归：V1-V13 在空库执行成功、validate 通过、索引存在。 */
class FlywaySchemaIT extends AbstractPostgresIT {

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void schemaHistory_allMigrationsSuccess() {
        List<String> versions = jdbcTemplate.queryForList(
                "SELECT version || ':' || type || ':' || success FROM flyway_schema_history ORDER BY installed_rank",
                String.class);
        // 空库：V1-V13 全部以 SQL 迁移执行（无 baseline 行），全部 success
        assertEquals(13, versions.size());
        assertTrue(versions.get(0).startsWith("1:SQL:true"));
        assertTrue(versions.stream().allMatch(v -> v.endsWith(":SQL:true")), "全部迁移成功: " + versions);
    }

    @Test
    void businessTables_allPresent() {
        Integer count = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM information_schema.tables "
                        + "WHERE table_schema='public' AND table_name <> 'flyway_schema_history'",
                Integer.class);
        // 17 张业务表 + app_user + import_batch + sys_config + order_revision(V10)
        assertEquals(21, count);
    }

    @Test
    void v4Indexes_present() {
        List<String> indexes = jdbcTemplate.queryForList(
                "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname LIKE 'idx_%'",
                String.class);
        // 实测口径：V1-V11 迁移完成后共 20 个 idx_ 前缀索引（含 V11 的 idx_event_status）
        assertEquals(20, indexes.size());
        for (String expected : List.of("idx_schedule_task_status", "idx_event_occurred_at",
                "idx_plan_version_parent_id", "idx_audit_log_object", "idx_schedule_operation_machine")) {
            assertTrue(indexes.contains(expected), "缺少索引 " + expected);
        }
    }

    @Test
    void v5PartialUniqueIndex_present() {
        Integer count = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM pg_indexes WHERE schemaname='public'"
                        + " AND indexname = 'uq_execution_record_open_running'",
                Integer.class);
        assertEquals(1, count, "缺少 execution_record 双 RUNNING 防护的部分唯一索引");
    }

    @Test
    void v6ExecutionFeedbackEnhancement_present() {
        Integer pauseIndex = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM pg_indexes WHERE schemaname='public'"
                        + " AND indexname = 'uq_execution_record_open_pause'",
                Integer.class);
        assertEquals(1, pauseIndex, "缺少 execution_record 双暂停防护的部分唯一索引");
        List<String> columns = jdbcTemplate.queryForList(
                "SELECT column_name FROM information_schema.columns"
                        + " WHERE table_schema='public' AND table_name='execution_record'",
                String.class);
        for (String expected : List.of("occurred_at", "reason_code", "deviation_minutes")) {
            assertTrue(columns.contains(expected), "缺少 execution_record 列 " + expected);
        }
    }

    @Test
    void v7CodeSequences_present() {
        List<String> sequences = jdbcTemplate.queryForList(
                "SELECT sequencename FROM pg_sequences WHERE schemaname='public'", String.class);
        for (String expected : List.of("task_code_seq", "plan_version_code_seq", "event_code_seq")) {
            assertTrue(sequences.contains(expected), "缺少编号序列 " + expected);
        }
    }

    @Test
    void v9SysConfig_seeded() {
        List<String> keys = jdbcTemplate.queryForList(
                "SELECT config_key FROM public.sys_config ORDER BY config_key", String.class);
        for (String expected : List.of("EXECUTION_DEVIATION_THRESHOLD_MINUTES",
                "DEFAULT_FREEZE_WINDOW_MINUTES", "EXCEPTION_REASON_CODES")) {
            assertTrue(keys.contains(expected), "缺少预置配置键 " + expected);
        }
        Integer version = jdbcTemplate.queryForObject(
                "SELECT version FROM public.sys_config WHERE config_key='EXECUTION_DEVIATION_THRESHOLD_MINUTES'",
                Integer.class);
        assertEquals(1, version);
    }

    @Test
    void v10OrderRevisionAndCalendarVersion_present() {
        List<String> revisionColumns = jdbcTemplate.queryForList(
                "SELECT column_name FROM information_schema.columns"
                        + " WHERE table_schema='public' AND table_name='order_revision'",
                String.class);
        for (String expected : List.of("order_id", "revision_no", "reason", "changed_fields", "operator")) {
            assertTrue(revisionColumns.contains(expected), "缺少 order_revision 列 " + expected);
        }
        List<String> orderColumns = jdbcTemplate.queryForList(
                "SELECT column_name FROM information_schema.columns"
                        + " WHERE table_schema='public' AND table_name='production_order'",
                String.class);
        for (String expected : List.of("remark", "revision_no")) {
            assertTrue(orderColumns.contains(expected), "缺少 production_order 列 " + expected);
        }
        List<String> calendarColumns = jdbcTemplate.queryForList(
                "SELECT column_name FROM information_schema.columns"
                        + " WHERE table_schema='public' AND table_name='work_calendar'",
                String.class);
        for (String expected : List.of("created_at", "change_note")) {
            assertTrue(calendarColumns.contains(expected), "缺少 work_calendar 列 " + expected);
        }
    }

    @Test
    void v13SingleActivePlanIndex_present() {
        Integer count = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM pg_indexes WHERE schemaname='public'"
                        + " AND indexname = 'uq_plan_version_single_active'",
                Integer.class);
        assertEquals(1, count, "缺少 plan_version 唯一生效计划的部分唯一索引");
    }

    @Test
    void v3SeedInsertsRemoved_seedAccountsOwnedByRunner() {
        // V3 只建 app_user 表，不再插入 id='seed-user-*' 的弱口令演示账号；
        // 账号种子由 UserSeedRunner 以随机 UUID 创建（prod 强制 FJSP_SEED_ADMIN_PASSWORD）
        Integer count = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM public.app_user WHERE id LIKE 'seed-user-%'", Integer.class);
        assertEquals(0, count);
    }

    @Test
    void v11EventLifecycleColumns_present() {
        List<String> columns = jdbcTemplate.queryForList(
                "SELECT column_name FROM information_schema.columns"
                        + " WHERE table_schema='public' AND table_name='event'",
                String.class);
        for (String expected : List.of("revision_reason", "closed_at")) {
            assertTrue(columns.contains(expected), "缺少 event 列 " + expected);
        }
        Integer index = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM pg_indexes WHERE schemaname='public'"
                        + " AND indexname = 'idx_event_status'",
                Integer.class);
        assertEquals(1, index, "缺少 event.status 索引");
    }
}
