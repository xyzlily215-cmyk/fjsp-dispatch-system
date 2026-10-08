package com.fjsp.business.service;

import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

import jakarta.persistence.EntityManager;
import jakarta.persistence.PersistenceContext;
import org.springframework.stereotype.Service;

/**
 * 编号生成：每种前缀对应一个 PostgreSQL 序列（V7/V8 迁移创建并按现有最大编号续号），
 * nextval 在数据库层保证并发唯一，替代原"查最大编号 +1"的读-改-写竞态。
 * 编号宽度从 3 位提升为 6 位（TSK-000001），超宽后 format 自然扩展，不再静默失去定宽。
 * local profile 关闭了 Flyway，首次使用时惰性建序列兜底（ensureSequence）。
 */
@Service
public class CodeGenerator {

    private record SequenceDef(String name, String table, String column) {
    }

    private static final Map<String, SequenceDef> SEQUENCES = Map.of(
            "TSK", new SequenceDef("task_code_seq", "schedule_task", "task_code"),
            "PV", new SequenceDef("plan_version_code_seq", "plan_version", "version_code"),
            "EVT", new SequenceDef("event_code_seq", "event", "event_code"),
            "IMP", new SequenceDef("import_batch_code_seq", "import_batch", "batch_code"));

    /** 本 JVM 已完成存在性检查的序列；建序列失败时移除以便下次重试。 */
    private final Set<String> ensured = ConcurrentHashMap.newKeySet();

    @PersistenceContext
    private EntityManager entityManager;

    public String next(String prefix) {
        SequenceDef def = SEQUENCES.get(prefix);
        if (def == null) {
            throw new IllegalArgumentException("未知编号前缀: " + prefix);
        }
        ensureSequence(def);
        // 序列名来自上方白名单常量，不存在注入风险；nextval 不随事务回滚（允许跳号）
        Number value = (Number) entityManager
                .createNativeQuery("SELECT nextval('" + def.name() + "')")
                .getSingleResult();
        return prefix + "-" + String.format("%06d", value.longValue());
    }

    private void ensureSequence(SequenceDef def) {
        if (!ensured.add(def.name())) {
            return;
        }
        try {
            Object existing = entityManager
                    .createNativeQuery("SELECT to_regclass('" + def.name() + "')")
                    .getSingleResult();
            if (existing == null) {
                // Flyway 关闭的本地库：兜底建序列并从现有最大编号续号
                entityManager.createNativeQuery("CREATE SEQUENCE " + def.name()).executeUpdate();
                entityManager.createNativeQuery("SELECT setval('" + def.name() + "',"
                        + " COALESCE((SELECT max(CAST(substring(" + def.column()
                        + " from '[0-9]+$') AS bigint)) FROM public." + def.table() + "), 0) + 1,"
                        + " false)").getSingleResult();
            }
        } catch (RuntimeException e) {
            ensured.remove(def.name());
            throw e;
        }
    }
}
