-- V9: F-12 基础字典维护 — sys_config 键值型配置表（含配置版本与生效时间）。
-- IF NOT EXISTS / WHERE NOT EXISTS 保证在 ddl-auto=update 已建表或重复种子时不报错（dev profile）。

CREATE TABLE IF NOT EXISTS public.sys_config (
    id character varying(255) NOT NULL,
    config_key character varying(255) NOT NULL,
    config_value text,
    description character varying(500),
    version integer NOT NULL DEFAULT 1,
    effective_at timestamp(6) with time zone NOT NULL,
    updated_by character varying(255),
    updated_at timestamp(6) with time zone NOT NULL,
    CONSTRAINT sys_config_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_sys_config_key ON public.sys_config (config_key);

INSERT INTO public.sys_config (id, config_key, config_value, description, version, effective_at, updated_by, updated_at)
SELECT 'seed-config-deviation-threshold', 'EXECUTION_DEVIATION_THRESHOLD_MINUTES', '15',
       '执行偏差阈值（分钟）：实际开/完工与计划偏差超过该值时标记 EXECUTION_DEVIATION', 1, now(), 'system', now()
WHERE NOT EXISTS (SELECT 1 FROM public.sys_config WHERE config_key = 'EXECUTION_DEVIATION_THRESHOLD_MINUTES');

INSERT INTO public.sys_config (id, config_key, config_value, description, version, effective_at, updated_by, updated_at)
SELECT 'seed-config-freeze-window', 'DEFAULT_FREEZE_WINDOW_MINUTES', '30',
       '重调度冻结窗口默认值（分钟），与 fjsp.freeze-window 一致；可在任务参数中覆盖', 1, now(), 'system', now()
WHERE NOT EXISTS (SELECT 1 FROM public.sys_config WHERE config_key = 'DEFAULT_FREEZE_WINDOW_MINUTES');

INSERT INTO public.sys_config (id, config_key, config_value, description, version, effective_at, updated_by, updated_at)
SELECT 'seed-config-reason-codes', 'EXCEPTION_REASON_CODES',
       'MACHINE_BREAKDOWN,MATERIAL_SHORTAGE,QUALITY_ISSUE,CALENDAR_BLOCKED,PREDECESSOR_WAIT,OPERATOR_ERROR,OTHER',
       '执行异常原因码字典（逗号分隔）', 1, now(), 'system', now()
WHERE NOT EXISTS (SELECT 1 FROM public.sys_config WHERE config_key = 'EXCEPTION_REASON_CODES');
