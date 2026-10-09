-- V10: F-04 订单修订控制（order_revision 修订记录 + 订单备注/修订号）
--      F-02 日历版本管理（work_calendar 版本元数据：创建时间 + 变更说明）
-- IF NOT EXISTS / IF NOT EXISTS 保证在 ddl-auto=update 已建表或重复执行时不报错（dev profile）。

CREATE TABLE IF NOT EXISTS public.order_revision (
    id character varying(255) NOT NULL,
    order_id character varying(255) NOT NULL,
    revision_no integer NOT NULL,
    reason character varying(1000) NOT NULL,
    changed_fields jsonb NOT NULL,
    operator character varying(255),
    created_at timestamp(6) with time zone NOT NULL,
    CONSTRAINT order_revision_pkey PRIMARY KEY (id),
    CONSTRAINT uk_order_revision_order_no UNIQUE (order_id, revision_no)
);

CREATE INDEX IF NOT EXISTS idx_order_revision_order_id ON public.order_revision (order_id);

ALTER TABLE public.production_order ADD COLUMN IF NOT EXISTS remark character varying(500);
ALTER TABLE public.production_order ADD COLUMN IF NOT EXISTS revision_no integer NOT NULL DEFAULT 0;

ALTER TABLE public.work_calendar ADD COLUMN IF NOT EXISTS created_at timestamp(6) with time zone NOT NULL DEFAULT now();
ALTER TABLE public.work_calendar ADD COLUMN IF NOT EXISTS change_note character varying(500);
