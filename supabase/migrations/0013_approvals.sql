-- =============================================================================
-- 0013_approvals.sql
--
-- Adds the human-approval flow for human-gated capabilities (spec §8).
--
-- Two tables :
--   - `project_approval_channels` : per-project channel binding. MVP supports
--     `manual` (operator approves via API/dashboard) and `telegram` (bot
--     message with inline ✅/❌). New channels (slack, email) plug in by
--     extending the check constraint.
--   - `approval_requests` : a request to mint an access token whose
--     capabilities include at least one human-gated one. Lifecycle :
--         pending → approved | denied | expired | cancelled
--         approved → consumed (api_key returned to caller)
--
-- The approved row carries a *plaintext* `pending_api_key` until the caller
-- first reads it (then cleared) or the row expires. The risk window is bounded
-- by `expires_at` (default 15 min) and by RLS (service-role-only).
--
-- Spec : docs/spec/gateway-capability-model.draft.md §8.
-- =============================================================================

create table project_approval_channels (
  project_id uuid primary key references projects(id) on delete cascade,
  channel text not null check (channel in ('manual', 'telegram')),
  -- Telegram-specific (null when channel != 'telegram').
  telegram_chat_id text,
  -- Optional per-project bot token override (encrypted bytea). When null the
  -- impl falls back to the global TELEGRAM_BOT_TOKEN env var.
  telegram_bot_token_encrypted bytea,
  updated_at timestamptz not null default now(),
  -- Coherence : telegram channel requires a chat_id.
  constraint approval_channel_telegram_needs_chat
    check (channel != 'telegram' or telegram_chat_id is not null)
);

alter table project_approval_channels enable row level security;
-- Service-role-only at MVP : reads go through the mint route, not user clients.

create table approval_requests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  -- Who requested
  requested_by_management_key_id uuid
    references org_management_keys(id) on delete set null,
  requested_by_user_id uuid references auth.users(id) on delete set null,
  -- What's requested
  requested_capabilities jsonb not null,
  requested_token_name text not null,
  requested_ttl_hours int not null default 24,
  context jsonb,
  -- Decision
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied', 'expired', 'cancelled', 'consumed')),
  decided_by text,
  decided_at timestamptz,
  consumed_at timestamptz,
  -- Channel routing
  channel text not null check (channel in ('manual', 'telegram')),
  channel_ref text,
  -- Output (set on approval, cleared on consume)
  access_token_id uuid references access_tokens(id) on delete set null,
  pending_api_key text,
  -- TTL
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes')
);

create index approval_requests_project_status_idx
  on approval_requests (project_id, status);
create index approval_requests_status_expires_idx
  on approval_requests (status, expires_at);

alter table approval_requests enable row level security;

-- Org members may SELECT their project's approval requests (for the dashboard
-- to surface pending ones). Mutations go via service role through the API.
create policy "org members can read their project's approval requests"
  on approval_requests
  for select
  using (
    project_id in (
      select p.id
      from projects p
      join org_members om on om.organization_id = p.organization_id
      where om.user_id = auth.uid()
    )
  );

-- Sweep expired pending approvals (called by the existing cron in 0010 or by
-- an upcoming dedicated sweeper).
create or replace function expire_stale_approval_requests() returns int
language plpgsql as $$
declare
  n int;
begin
  with upd as (
    update approval_requests
       set status = 'expired'
     where status = 'pending'
       and expires_at < now()
    returning id
  )
  select count(*) into n from upd;
  -- Also clear pending_api_key on rows that approved but were never consumed
  -- past their expires_at (safety net).
  update approval_requests
     set pending_api_key = null
   where status = 'approved'
     and pending_api_key is not null
     and expires_at < now();
  return n;
end;
$$;
