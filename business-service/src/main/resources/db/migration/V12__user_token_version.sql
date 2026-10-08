-- V12: 安全加固 — app_user.token_version 支持 JWT 实时失效
-- 停用/改角色/重置密码时递增，JwtAuthenticationFilter 比对 JWT 中的 tv claim；
-- IF NOT EXISTS + DEFAULT 0 保证已有数据的 dev 库（ddl-auto=update）也能安全执行。

ALTER TABLE public.app_user ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;
