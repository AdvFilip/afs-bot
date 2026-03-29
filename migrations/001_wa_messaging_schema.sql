-- =============================================================================
-- Migration 001: WhatsApp Messaging Schema
-- Prereqs: client_contacts, cases
-- Tables:  wa_contact_prefs, wa_conversations, wa_messages_outbound,
--          wa_messages_inbound, wa_commands
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRE-0) client_contacts
--   Core identity table. Each row is one real-world contact (by phone).
--   Other WA tables hang off this via client_contact_id FK.
-- ---------------------------------------------------------------------------
create table if not exists public.client_contacts (
  id          uuid    primary key default gen_random_uuid(),
  phone_e164  text    not null,
  name        text,
  email       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (phone_e164)
);

-- ---------------------------------------------------------------------------
-- PRE-1) cases
--   Stub table. Populated later via file import or external API sync.
--   Uses bigint PK to allow external system IDs to be inserted directly.
-- ---------------------------------------------------------------------------
create table if not exists public.cases (
  id          bigint  primary key,           -- external / imported ID
  reference   text,                          -- e.g. "AFS-2024-001"
  title       text,
  status      text    not null default 'open'
                check (status in ('open','closed','archived')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 1) wa_contact_prefs
--   One row per contact. Stores opt status, quiet hours, language, etc.
-- ---------------------------------------------------------------------------
create table if not exists public.wa_contact_prefs (
  id                   uuid    primary key default gen_random_uuid(),
  client_contact_id    uuid    not null references public.client_contacts(id) on delete cascade,
  whatsapp_enabled     boolean not null default true,
  opt_status           text    not null default 'opted_in'
                         check (opt_status in ('opted_in','opted_out','blocked','invalid')),
  preferred_language   text    not null default 'en',
  quiet_hours_start    time,
  quiet_hours_end      time,
  timezone             text    default 'UTC',
  last_opt_change_at   timestamptz not null default now(),
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (client_contact_id)
);

-- ---------------------------------------------------------------------------
-- 2) wa_conversations
--   One row per (contact × provider). Tracks the active chat thread.
-- ---------------------------------------------------------------------------
create table if not exists public.wa_conversations (
  id                uuid    primary key default gen_random_uuid(),
  client_contact_id uuid    not null references public.client_contacts(id) on delete cascade,
  provider          text    not null check (provider in ('baileys','meta')),
  provider_chat_id  text,
  status            text    not null default 'active'
                      check (status in ('active','muted','closed')),
  last_inbound_at   timestamptz,
  last_outbound_at  timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (client_contact_id, provider)
);

-- ---------------------------------------------------------------------------
-- 3) wa_messages_outbound
--   Every message sent to a contact. Tracks delivery lifecycle.
--   reminder_id / case_id are optional links to business objects.
-- ---------------------------------------------------------------------------
create table if not exists public.wa_messages_outbound (
  id                  uuid    primary key default gen_random_uuid(),
  conversation_id     uuid    not null references public.wa_conversations(id) on delete cascade,
  reminder_id         uuid    references public.reminders(id) on delete set null,
  case_id             bigint  references public.cases(id)    on delete set null,
  provider            text    not null check (provider in ('baileys','meta')),
  provider_message_id text,
  message_type        text    not null default 'text'
                        check (message_type in ('text','template','interactive')),
  payload             jsonb   not null default '{}'::jsonb,
  send_status         text    not null default 'queued'
                        check (send_status in ('queued','sent','delivered','read','failed')),
  failure_reason      text,
  sent_at             timestamptz,
  delivered_at        timestamptz,
  read_at             timestamptz,
  created_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 4) wa_messages_inbound
--   Every message received from a contact.
-- ---------------------------------------------------------------------------
create table if not exists public.wa_messages_inbound (
  id                  uuid    primary key default gen_random_uuid(),
  conversation_id     uuid    not null references public.wa_conversations(id) on delete cascade,
  provider            text    not null check (provider in ('baileys','meta')),
  provider_message_id text,
  from_phone_e164     text    not null,
  message_type        text    not null default 'text'
                        check (message_type in ('text','button','list','media','unknown')),
  message_text        text,
  payload             jsonb   not null default '{}'::jsonb,
  received_at         timestamptz not null default now(),
  created_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 5) wa_commands
--   Parsed commands extracted from inbound messages.
--   Command semantics:
--     DONE   – contact confirms a reminder/task is handled
--     SNOOZE – delay the linked reminder (args: {"minutes": N})
--     STOP   – opt out; sets wa_contact_prefs.opt_status = 'opted_out'
--     NEXT   – reply with the contact's next scheduled reminder
--     STATUS – reply with a summary of open reminders / case status
--     UNKNOWN – unrecognised free-text; logged but not actioned
-- ---------------------------------------------------------------------------
create table if not exists public.wa_commands (
  id               bigserial primary key,
  inbound_id       uuid    not null references public.wa_messages_inbound(id) on delete cascade,
  command          text    not null
                     check (command in ('DONE','SNOOZE','STOP','NEXT','STATUS','UNKNOWN')),
  command_args     jsonb   not null default '{}'::jsonb,
  execution_status text    not null default 'pending'
                     check (execution_status in ('pending','executed','failed')),
  execution_note   text,
  executed_at      timestamptz,
  created_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 6) Indexes
-- ---------------------------------------------------------------------------
create index if not exists idx_wa_pref_status   on public.wa_contact_prefs(opt_status);
create index if not exists idx_wa_conv_contact  on public.wa_conversations(client_contact_id);
create index if not exists idx_wa_out_conv      on public.wa_messages_outbound(conversation_id, created_at desc);
create index if not exists idx_wa_in_conv       on public.wa_messages_inbound(conversation_id, received_at desc);
create index if not exists idx_wa_cmd_status    on public.wa_commands(execution_status, created_at);
