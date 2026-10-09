-- V2: task resilience — retry / timeout / cooperative cancel columns on schedule_task.
-- Columns are nullable with defaults so existing rows migrate cleanly; the JPA entity
-- normalizes NULL to the same defaults (dev profile ddl-auto=update adds them as nullable).
-- IF NOT EXISTS keeps this migration safe on databases where ddl-auto=update already added
-- the columns (dev profile), so dev-then-prod startup order does not break Flyway.

ALTER TABLE public.schedule_task ADD COLUMN IF NOT EXISTS retry_count integer DEFAULT 0;
ALTER TABLE public.schedule_task ADD COLUMN IF NOT EXISTS max_retries integer DEFAULT 3;
ALTER TABLE public.schedule_task ADD COLUMN IF NOT EXISTS next_retry_at timestamp(6) with time zone;
ALTER TABLE public.schedule_task ADD COLUMN IF NOT EXISTS timeout_at timestamp(6) with time zone;
ALTER TABLE public.schedule_task ADD COLUMN IF NOT EXISTS cancel_requested boolean DEFAULT false;
