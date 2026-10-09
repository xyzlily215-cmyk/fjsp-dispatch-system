-- V6: 执行反馈增强——暂停/恢复/异常时间线与执行偏差标记。
-- occurred_at：暂停/恢复/异常动作的发生时间；reason_code：异常原因码或 EXECUTION_DEVIATION 偏差标记；
-- deviation_minutes：实际与计划时间的最大绝对偏差（分钟），超过阈值时写入。
ALTER TABLE public.execution_record
    ADD COLUMN IF NOT EXISTS occurred_at timestamp(6) with time zone,
    ADD COLUMN IF NOT EXISTS reason_code character varying(255),
    ADD COLUMN IF NOT EXISTS deviation_minutes integer;

-- 同一工序最多存在一条未恢复的暂停记录（actual_end_at 复用为暂停解除时间，恢复时回填）。
-- 与 V5 的 open RUNNING 索引同理，把"先查后插"的并发竞态收敛为数据库约束。
CREATE UNIQUE INDEX IF NOT EXISTS uq_execution_record_open_pause
    ON public.execution_record (operation_id)
    WHERE status = 'PAUSED' AND actual_end_at IS NULL;
