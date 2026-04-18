-- Adds the run_id column to agent_sessions so the orchestrator can correlate
-- a session row with its top-level run identifier instead of stuffing it
-- into output_data JSON.
--
-- Apply via the Supabase SQL editor (or `supabase db push`) and then revert
-- the workaround in api.py:_run_orchestrator_bg that currently omits run_id
-- from the AgentSessionModel insert.

alter table public.agent_sessions
    add column if not exists run_id text;

create index if not exists agent_sessions_run_id_idx
    on public.agent_sessions (run_id);
