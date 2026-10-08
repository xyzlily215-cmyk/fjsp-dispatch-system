-- V4: secondary indexes for list/dashboard/query hotspots.
-- Column names verified against the live schema: plan_version 的父版本列是 parent_id，
-- event 表没有 created_at（登记时间列是 recorded_at）。
-- IF NOT EXISTS keeps this safe whether ddl-auto=update (local) already created them or not.

-- event：看板最近事件/异常故障、事件列表过滤
CREATE INDEX IF NOT EXISTS idx_event_status ON public.event (status);
CREATE INDEX IF NOT EXISTS idx_event_occurred_at ON public.event (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_recorded_at ON public.event (recorded_at DESC);

-- schedule_task：任务列表、超时/重试扫描、按事件查任务
CREATE INDEX IF NOT EXISTS idx_schedule_task_status ON public.schedule_task (status);
CREATE INDEX IF NOT EXISTS idx_schedule_task_created_at ON public.schedule_task (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_schedule_task_event_id ON public.schedule_task (event_id);
CREATE INDEX IF NOT EXISTS idx_schedule_task_status_timeout ON public.schedule_task (status, timeout_at);
CREATE INDEX IF NOT EXISTS idx_schedule_task_status_retry ON public.schedule_task (status, next_retry_at);

-- plan_version：版本列表、父版本回溯、按状态查当前发布
CREATE INDEX IF NOT EXISTS idx_plan_version_status ON public.plan_version (status);
CREATE INDEX IF NOT EXISTS idx_plan_version_created_at ON public.plan_version (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_plan_version_parent_id ON public.plan_version (parent_id);

-- execution_record：按工序/状态查执行记录
CREATE INDEX IF NOT EXISTS idx_execution_record_operation ON public.execution_record (operation_id);
CREATE INDEX IF NOT EXISTS idx_execution_record_status ON public.execution_record (status);

-- schedule_operation：按设备过滤工序（(plan_version_id, operation_id) 唯一约束已覆盖 plan_version_id 前缀）
CREATE INDEX IF NOT EXISTS idx_schedule_operation_machine ON public.schedule_operation (machine_id);

-- audit_log：按对象/操作者/时间/请求检索
CREATE INDEX IF NOT EXISTS idx_audit_log_object ON public.audit_log (object_type, object_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_operator ON public.audit_log (operator);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON public.audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_request_id ON public.audit_log (request_id);
