-- Event-driven triggers: webhook intake + internal events.
--
-- Extends the triggers table from 0007 so a trigger can fire on:
--   * cron       (existing — schedule_cron required)
--   * webhook    (POST /triggers/webhook/{webhook_token})
--   * <event>    (internal events: lead.created, run.completed)
--
-- Idempotent: safe to re-run.

alter table public.triggers
    add column if not exists event_type    text not null default 'cron',
    add column if not exists webhook_token text,
    add column if not exists event_filter  jsonb;

-- schedule_cron only applies to cron triggers; non-cron triggers carry NULL.
alter table public.triggers
    alter column schedule_cron drop not null;

create unique index if not exists idx_triggers_webhook_token
    on public.triggers (webhook_token)
    where webhook_token is not null;

create index if not exists idx_triggers_event_type_enabled
    on public.triggers (event_type, enabled);

notify pgrst, 'reload schema';
