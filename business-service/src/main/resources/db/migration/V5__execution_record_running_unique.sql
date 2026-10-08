-- V5: 执行反馈并发防护——同一工序最多存在一条未结束（actual_end_at IS NULL）的 RUNNING 执行记录。
-- 部分唯一索引把 ExecutionService.feedback 的"先查后插"竞态收敛为数据库约束；
-- 违反约束时由 ExecutionService 捕获 DataIntegrityViolationException 并转为 409 E_STATE_CONFLICT。
-- 注意：ddl-auto=update 的本地库不会自动建该索引，依赖本迁移生效。
CREATE UNIQUE INDEX IF NOT EXISTS uq_execution_record_open_running
    ON public.execution_record (operation_id)
    WHERE status = 'RUNNING' AND actual_end_at IS NULL;
