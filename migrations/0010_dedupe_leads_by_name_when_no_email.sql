-- Dedupe leads that lack an email by (full_name, company_name).
--
-- Why this is needed:
--   The unique index from 0004 only covers email-bearing rows because
--   it's keyed on `email`. Agents frequently produce leads without an
--   email (cold prospects scraped from web search, partial signals from
--   intake forms, etc.) — each of those slips past the existing index
--   and shows up as a duplicate row in the Leads tab.
--
-- Strategy:
--   Add a partial unique index keyed on case-insensitive
--   (full_name, company_name) restricted to rows where email IS NULL.
--   coalesce is used so leads without a company still dedupe by name
--   alone instead of being treated as distinct (NULL ≠ NULL).
--
-- Note on enforcement:
--   `INSERT ... ON CONFLICT` in supabase-py upsert() targets a single
--   column, so the application code (SupabaseDatabase.create_lead and
--   InMemoryDatabase.create_lead) does an explicit lookup-then-update
--   path for email-less leads. This index is the safety net that
--   prevents two concurrent inserts from both succeeding.
--
-- Idempotent — safe to re-apply.
--
-- Apply via the Supabase SQL editor.

-- One-time cleanup of pre-existing duplicates: keep the row with the
-- highest icp_score (ties broken by oldest created_at). Rows are joined
-- on case-insensitive name + company so the surviving row matches what
-- the new index will allow going forward.
with ranked as (
    select id,
           row_number() over (
               partition by lower(full_name), lower(coalesce(company_name, ''))
               order by coalesce(icp_score, 0) desc, created_at asc
           ) as rn
      from public.leads
     where email is null
)
delete from public.leads
 where id in (select id from ranked where rn > 1);

create unique index if not exists leads_name_company_uniq
    on public.leads (lower(full_name), lower(coalesce(company_name, '')))
    where email is null;

notify pgrst, 'reload schema';
