-- Add every column AgentSessionModel writes that the deployed
-- agent_sessions table may be missing. Test 3 surfaced user_id as the
-- next gap after run_id was added in 0001 — adding the rest at once so
-- we don't iterate one PGRST204 error per deploy.
--
-- Idempotent: every column uses IF NOT EXISTS, so re-running is safe
-- even if some columns already exist.
--
-- Apply via the Supabase SQL editor.

alter table public.agent_sessions
    add column if not exists user_id        text,
    add column if not exists lead_id        text,
    add column if not exists input_data     jsonb,
    add column if not exists output_data    jsonb,
    add column if not exists reasoning_trace text,
    add column if not exists cost_usd       numeric,
    add column if not exists input_tokens   integer,
    add column if not exists output_tokens  integer,
    add column if not exists model_used     text,
    add column if not exists duration_ms    integer,
    add column if not exists steps_taken    integer,
    add column if not exists started_at     timestamptz,
    add column if not exists completed_at   timestamptz;

create index if not exists agent_sessions_user_id_idx
    on public.agent_sessions (user_id);

create index if not exists agent_sessions_started_at_idx
    on public.agent_sessions (started_at desc);

-- Force PostgREST to reload its schema cache so new columns are
-- queryable immediately without waiting for the periodic refresh.
notify pgrst, 'reload schema';
