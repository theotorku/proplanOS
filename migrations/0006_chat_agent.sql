-- Chat agent tables + lead source tracking.
--
-- Adds two new tables (chat_conversations, chat_messages) powering the
-- embeddable site chat + /chat landing page, plus one new column on leads
-- so a captured lead can be traced back to the conversation that produced it.
--
-- Idempotent: safe to re-run via the Supabase SQL editor.

-- -----------------------------------------------------------------
-- Conversations — one row per visitor session
-- -----------------------------------------------------------------
create table if not exists public.chat_conversations (
    id                   uuid primary key default gen_random_uuid(),
    user_id              text,
    status               text not null default 'active',
    origin               text,
    ip                   text,
    user_agent           text,
    referrer             text,
    utm                  jsonb,
    message_count        integer not null default 0,
    input_tokens         integer not null default 0,
    output_tokens        integer not null default 0,
    cost_usd             numeric(10, 4) not null default 0,
    escalated_to_slack   boolean not null default false,
    lead_captured        boolean not null default false,
    started_at           timestamptz not null default now(),
    last_message_at      timestamptz,
    ended_at             timestamptz
);

create index if not exists idx_chat_conversations_user_id
    on public.chat_conversations (user_id);
create index if not exists idx_chat_conversations_ip_started
    on public.chat_conversations (ip, started_at desc);
create index if not exists idx_chat_conversations_started
    on public.chat_conversations (started_at desc);

-- -----------------------------------------------------------------
-- Messages — one row per user/assistant turn in a conversation
-- -----------------------------------------------------------------
create table if not exists public.chat_messages (
    id                uuid primary key default gen_random_uuid(),
    conversation_id   uuid not null references public.chat_conversations (id) on delete cascade,
    role              text not null check (role in ('user', 'assistant', 'system', 'tool')),
    content           text not null,
    tool_name         text,
    tool_payload      jsonb,
    input_tokens      integer,
    output_tokens     integer,
    cost_usd          numeric(10, 4),
    created_at        timestamptz not null default now()
);

create index if not exists idx_chat_messages_conversation
    on public.chat_messages (conversation_id, created_at);

-- -----------------------------------------------------------------
-- Lead provenance — link chat-captured leads back to the conversation
-- -----------------------------------------------------------------
-- `source` already exists on leads (see database.py LeadModel) but adding
-- it here idempotently keeps this migration self-contained for fresh DBs.
alter table public.leads
    add column if not exists source text default 'agent';

alter table public.leads
    add column if not exists source_conversation_id uuid
        references public.chat_conversations (id) on delete set null;

create index if not exists idx_leads_source_conversation
    on public.leads (source_conversation_id);

notify pgrst, 'reload schema';
