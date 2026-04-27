-- Triggers: cron-driven recurring missions.
--
-- A trigger fires a stored prompt on a cron schedule. Each fire produces
-- one row in trigger_runs (audit trail) plus a normal agent_sessions row
-- via the existing /agent/run path.
--
-- Idempotent: safe to re-run via the Supabase SQL editor.

create table if not exists public.triggers (
    id              uuid primary key default gen_random_uuid(),
    user_id         text not null,
    name            text not null,
    schedule_cron   text not null,
    prompt_template text not null,
    enabled         boolean not null default true,
    last_run_at     timestamptz,
    next_run_at     timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create index if not exists idx_triggers_user_id
    on public.triggers (user_id);
create index if not exists idx_triggers_enabled_next_run
    on public.triggers (enabled, next_run_at);

create table if not exists public.trigger_runs (
    id          uuid primary key default gen_random_uuid(),
    trigger_id  uuid not null references public.triggers (id) on delete cascade,
    run_id      text,
    status      text not null default 'dispatched',
    error       text,
    fired_at    timestamptz not null default now()
);

create index if not exists idx_trigger_runs_trigger_id
    on public.trigger_runs (trigger_id, fired_at desc);

notify pgrst, 'reload schema';
