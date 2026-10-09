-- V3: auth — app_user table only; seed accounts are owned by auth/UserSeedRunner.
-- 历史上本脚本同时插入 4 个演示账号（弱口令 Fj@123456 的 BCrypt hash），prod 也跑 Flyway，
-- 导致迁移即写入弱口令账号、UserSeedRunner 的 FJSP_SEED_ADMIN_PASSWORD 检查成为死代码。
-- 上线前一次性修正：种子插入从迁移移至 UserSeedRunner（按 profile 选密码，prod 强制环境变量）。
-- 注意 checksum 变化只影响已应用过旧版 V3 的库——本项目尚无生产库，local profile 不跑 Flyway，
-- Testcontainers 库均为临时库；若有个别存量默认 profile 库，需 flyway repair 或重建。
-- IF NOT EXISTS keeps this migration safe on databases where ddl-auto=update
-- already created the table (local profile).

CREATE TABLE IF NOT EXISTS public.app_user (
    id character varying(255) NOT NULL,
    username character varying(255) NOT NULL,
    password_hash character varying(255) NOT NULL,
    role character varying(255) NOT NULL,
    display_name character varying(255),
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamp(6) with time zone NOT NULL,
    CONSTRAINT app_user_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_app_user_username ON public.app_user (username);
