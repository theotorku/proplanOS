-- Durable job queue for orchestrator runs.
--
-- A worker thread polls claim_jobs() at a fixed cadence; the SQL function
-- claims a batch atomically with FOR UPDATE SKIP LOCKED so multiple workers
-- can run side-by-side without double-firing. Stale claims (worker crashed
-- mid-run) are recovered after stale_seconds.
--
-- Idempotent: safe to re-run.

create table if not exists public.jobs (
    id              uuid        primary key default gen_random_uuid(),
    kind            text        not null,
    payload         jsonb       not null default '{}'::jsonb,
    status          text        not null default 'queued',  -- queued|claimed|done|failed
    attempts        int         not null default 0,
    max_attempts    int         not null default 3,
    claimed_at      timestamptz,
    claimed_by      text,
    scheduled_for   timestamptz not null default now(),
    last_error      text,
    run_id          uuid,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create index if not exists idx_jobs_status_scheduled
    on public.jobs (status, scheduled_for);

create index if not exists idx_jobs_run_id
    on public.jobs (run_id)
    where run_id is not null;

-- Atomic claim: returns up to p_limit rows, marking each as claimed.
-- Recovers stale claims older than p_stale_seconds.
create or replace function public.claim_jobs(
    p_worker_id     text,
    p_limit         int default 5,
    p_stale_seconds int default 600
) returns setof public.jobs
language sql
as $$
    update public.jobs
    set status     = 'claimed',
        claimed_at = now(),
        claimed_by = p_worker_id,
        attempts   = attempts + 1,
        updated_at = now()
    where id in (
        select id from public.jobs
        where (
            (status = 'queued' and scheduled_for <= now())
            or (status = 'claimed' and claimed_at < now() - make_interval(secs => p_stale_seconds))
        )
        order by scheduled_for asc
        limit p_limit
        for update skip locked
    )
    returning *;
$$;

notify pgrst, 'reload schema';
