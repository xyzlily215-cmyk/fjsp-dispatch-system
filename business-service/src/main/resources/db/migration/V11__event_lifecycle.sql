-- V11: F-07 事件生命周期管理 — event 表补充生命周期字段。
-- 状态机：CREATED -> CONFIRMED -> USED_FOR_SOLVE -> CLOSED（终态）。
-- revision_reason：修订原因（修订生成的新事件上记录，revision_of 指向原事件）；
-- closed_at：关闭时间（手动关闭或修订时原事件自动关闭）。
ALTER TABLE public.event
    ADD COLUMN IF NOT EXISTS revision_reason character varying(1000),
    ADD COLUMN IF NOT EXISTS closed_at timestamp(6) with time zone;

-- 事件列表按生命周期状态过滤（OPEN 类状态与 CLOSED 分开展示）。
CREATE INDEX IF NOT EXISTS idx_event_status ON public.event (status);
