-- Dedupe existing leads by email (keeping the newest row), then enforce
-- uniqueness so future agent runs upsert instead of producing duplicates
-- when the same lead is re-discovered.
--
-- Code-side change: extract_leads_from_memory now lowercases emails
-- before insert, so a plain unique index on email is sufficient and lets
-- supabase-py's upsert(on_conflict="email") work directly.
--
-- Apply via the Supabase SQL editor.

-- 1. Lowercase existing emails so the dedupe and the unique index treat
--    case-variant duplicates as the same row.
update public.leads
   set email = lower(email)
 where email is not null
   and email <> lower(email);

-- 2. Drop older duplicates so the unique index can be created.
delete from public.leads l1
using public.leads l2
where l1.id <> l2.id
  and l1.email is not null
  and l2.email is not null
  and l1.email = l2.email
  and l1.created_at < l2.created_at;

-- 3. Partial unique index — ignores rows with no email so older
--    agent output (before the field-mapping fix in 83c251d) doesn't
--    block the migration.
create unique index if not exists leads_email_uniq
    on public.leads (email)
    where email is not null;

notify pgrst, 'reload schema';
