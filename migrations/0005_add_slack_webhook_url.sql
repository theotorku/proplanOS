-- Add slack_webhook_url to business_profiles so users can paste their
-- Slack incoming-webhook URL once and have the backend push lead
-- digests to their channel without every-run OAuth.
--
-- Idempotent: re-running is a no-op thanks to IF NOT EXISTS.
--
-- Apply via the Supabase SQL editor.

alter table public.business_profiles
    add column if not exists slack_webhook_url text;

notify pgrst, 'reload schema';
