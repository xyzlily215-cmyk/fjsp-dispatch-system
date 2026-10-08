-- V7: 编号生成改用数据库序列——消除 CodeGenerator 原"查最大编号 +1"的读-改-写竞态
-- （两个未提交事务读到相同最大值会生成相同编号，只能靠唯一约束兜底报错）。
-- 每张编号表对应一个序列，并按现有数据的最大编号续号（取尾部数字的数值最大，
-- 兼容历史 3 位定宽与新 6 位定宽混存）。
CREATE SEQUENCE IF NOT EXISTS task_code_seq;
CREATE SEQUENCE IF NOT EXISTS plan_version_code_seq;
CREATE SEQUENCE IF NOT EXISTS event_code_seq;

SELECT setval('task_code_seq',
    COALESCE((SELECT max(CAST(substring(task_code from '[0-9]+$') AS bigint))
              FROM public.schedule_task), 0) + 1, false);
SELECT setval('plan_version_code_seq',
    COALESCE((SELECT max(CAST(substring(version_code from '[0-9]+$') AS bigint))
              FROM public.plan_version), 0) + 1, false);
SELECT setval('event_code_seq',
    COALESCE((SELECT max(CAST(substring(event_code from '[0-9]+$') AS bigint))
              FROM public.event), 0) + 1, false);
