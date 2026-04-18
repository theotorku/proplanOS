-- Replace the partial unique index from 0003 with a regular unique
-- index so `INSERT ... ON CONFLICT (email)` (used by SupabaseDatabase
-- .create_lead via supabase-py's upsert(on_conflict="email")) can
-- actually find a constraint to anchor against.
--
-- Why this is needed:
--   Postgres' simple `ON CONFLICT (col)` form requires a UNIQUE
--   CONSTRAINT or a NON-PARTIAL UNIQUE INDEX on `col`. The partial
--   index `leads_email_uniq ... WHERE email IS NOT NULL` from
--   migration 0003 does not satisfy that — PostgREST surfaces the
--   mismatch as `42P10: there is no unique or exclusion constraint
--   matching the ON CONFLICT specification`, and every lead insert
--   gets rejected (test 4: `LEADS: extracted 3 · saved 0`).
--
-- NULL handling: a regular UNIQUE INDEX on a nullable column treats
-- each NULL as distinct (Postgres default), so leads without an
-- email can still coexist without violating the constraint — the
-- same behavior we wanted from the partial index.
--
-- Idempotent: drops the partial index if present, then creates the
-- replacement only if it isn't already there.
--
-- Apply via the Supabase SQL editor.

drop index if exists public.leads_email_uniq;

create unique index if not exists leads_email_uniq
    on public.leads (email);

notify pgrst, 'reload schema';
