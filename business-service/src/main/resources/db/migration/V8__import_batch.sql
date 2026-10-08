-- V8: F-05 批量导入与校验（订单/设备，CSV）。import_batch 持久化批次：
-- 预览建批（PENDING，rows_json 保存解析后的行数据供提交复用），
-- 整批入库成功置 COMMITTED，提交时复检失败置 FAILED；
-- errors 保存逐行错误明细（行号/错误码/字段/原值/修正建议）。
CREATE TABLE public.import_batch (
    id character varying(255) NOT NULL,
    batch_code character varying(255) NOT NULL,
    import_type character varying(50) NOT NULL,
    status character varying(20) NOT NULL,
    file_name character varying(255),
    file_sha256 character varying(64) NOT NULL,
    total_rows integer NOT NULL,
    success_rows integer NOT NULL,
    error_rows integer NOT NULL,
    errors jsonb,
    rows_json jsonb,
    operator character varying(255),
    created_at timestamp(6) with time zone NOT NULL,
    committed_at timestamp(6) with time zone
);

ALTER TABLE ONLY public.import_batch
    ADD CONSTRAINT import_batch_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.import_batch
    ADD CONSTRAINT uk_import_batch_batch_code UNIQUE (batch_code);

-- 批次追溯按时间倒序检索
CREATE INDEX IF NOT EXISTS idx_import_batch_created_at ON public.import_batch (created_at DESC);

-- 批次号 IMP-000001：与 V7 相同的序列方案（数据库层并发唯一，允许跳号）
CREATE SEQUENCE IF NOT EXISTS import_batch_code_seq;
SELECT setval('import_batch_code_seq',
    COALESCE((SELECT max(CAST(substring(batch_code from '[0-9]+$') AS bigint))
              FROM public.import_batch), 0) + 1, false);
