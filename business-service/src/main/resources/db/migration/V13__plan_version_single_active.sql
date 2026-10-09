-- V13: 唯一生效计划——全库最多一个 PUBLISHED/EXECUTING 计划版本。
-- PlanPublishService.publish 对 parentId IS NULL 的基线计划没有父版本过期校验兜底，
-- 两个并发基线发布可能各自通过"先查后改"产生两个 PUBLISHED；
-- 部分唯一索引（常量键 (1)，与 V5/V6 同一套写法）把该竞态收敛为数据库约束，
-- 违反约束时由 publish 捕获 DataIntegrityViolationException 并转为 409 E_STATE_CONFLICT。
-- 注意：ddl-auto=update 的本地库不会自动建该索引，依赖本迁移生效；
-- prod 为 ddl-auto=validate，Hibernate 不校验索引，实体无需感知该表达式索引。
CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_version_single_active
    ON public.plan_version ((1))
    WHERE status IN ('PUBLISHED', 'EXECUTING');
