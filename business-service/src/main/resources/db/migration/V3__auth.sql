-- V3: auth — app_user table + 4 seed accounts (demo password for all: Fj@123456, BCrypt cost 10).
-- IF NOT EXISTS / ON CONFLICT keeps this migration safe on databases where ddl-auto=update
-- already created the table or UserSeedRunner already inserted the accounts (dev profile).

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

INSERT INTO public.app_user (id, username, password_hash, role, display_name, enabled, created_at)
SELECT 'seed-user-dispatcher', 'dispatcher',
       '$2y$10$lXaipc3FWD.njKwQ8CRXIO3.k/mo3ApVqhfDDd6HHmf17y1xV.jRe',
       'DISPATCHER', '调度员', true, now()
WHERE NOT EXISTS (SELECT 1 FROM public.app_user WHERE username = 'dispatcher');

INSERT INTO public.app_user (id, username, password_hash, role, display_name, enabled, created_at)
SELECT 'seed-user-reviewer', 'reviewer',
       '$2y$10$lXaipc3FWD.njKwQ8CRXIO3.k/mo3ApVqhfDDd6HHmf17y1xV.jRe',
       'REVIEWER', '审核员', true, now()
WHERE NOT EXISTS (SELECT 1 FROM public.app_user WHERE username = 'reviewer');

INSERT INTO public.app_user (id, username, password_hash, role, display_name, enabled, created_at)
SELECT 'seed-user-manager', 'manager',
       '$2y$10$lXaipc3FWD.njKwQ8CRXIO3.k/mo3ApVqhfDDd6HHmf17y1xV.jRe',
       'PRODUCTION_MANAGER', '生产主管', true, now()
WHERE NOT EXISTS (SELECT 1 FROM public.app_user WHERE username = 'manager');

INSERT INTO public.app_user (id, username, password_hash, role, display_name, enabled, created_at)
SELECT 'seed-user-admin', 'admin',
       '$2y$10$lXaipc3FWD.njKwQ8CRXIO3.k/mo3ApVqhfDDd6HHmf17y1xV.jRe',
       'ADMIN', '管理员', true, now()
WHERE NOT EXISTS (SELECT 1 FROM public.app_user WHERE username = 'admin');
