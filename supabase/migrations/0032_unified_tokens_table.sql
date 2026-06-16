-- =============================================================================
-- 0032_unified_tokens_table.sql
--
-- Single `tokens` table replacing `org_management_keys` + `access_tokens`,
-- with parent_id self-FK + pre-computed delegation_chain (cf. ADR
-- unified-tokens-delegation-chain-and-escalation-channel.md §D1, D2).
--
-- Wire change : drops `vbn_mgmt_*` distinction entirely. Every token is a
-- `vbn_live_*` ; the (formerly) management-key role is just a root org-scoped
-- token (`scope='org', parent_id IS NULL`).
--
-- This migration ONLY creates the new table + indices. Data migration from
-- the legacy tables happens in 0033 ; the drop of the legacy tables happens
-- in 0035. The split keeps each migration small + reviewable, and lets us
-- re-point FKs cleanly in 0033 before the cascade-drops fire.
-- =============================================================================

create table tokens (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references organizations(id) on delete cascade,
  parent_id         uuid references tokens(id) on delete cascade,
  scope             text not null check (scope in ('org', 'project')),
  project_id        uuid references projects(id) on delete cascade,
  name              text not null check (name ~ '^[a-z0-9](-?[a-z0-9])*$'),
  api_key_prefix    text not null unique,
  api_key_hash      text not null,
  status            text not null default 'active'
                        check (status in ('active', 'revoked')),
  accepted_risks    jsonb not null default '[]'::jsonb,
  denied_risks      jsonb not null default '[]'::jsonb,
  depth             int not null default 0 check (depth >= 0 and depth <= 5),
  delegation_chain  jsonb not null default '[]'::jsonb,
  context           jsonb,
  expires_at        timestamptz,
  single_use        boolean not null default false,
  consumed_at       timestamptz,
  last_used_at      timestamptz,
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  -- scope ↔ project_id coherence : project-scoped must have a project ;
  -- org-scoped must not.
  constraint tokens_scope_project_coherence
    check (
      (scope = 'project' and project_id is not null)
      or (scope = 'org' and project_id is null)
    ),
  -- risk arrays are validated by the same regex function as access_tokens.
  constraint tokens_accepted_risks_valid
    check (valid_risk_id_array(accepted_risks)),
  constraint tokens_denied_risks_valid
    check (valid_risk_id_array(denied_risks)),
  -- name uniqueness per org (mirrors org_management_keys ; we now extend to
  -- project tokens since they all live in the same table).
  unique (organization_id, name)
);

-- ─── Indices ───────────────────────────────────────────────────────────────
create index tokens_org_idx              on tokens (organization_id);
create index tokens_project_idx          on tokens (project_id);
create index tokens_parent_idx           on tokens (parent_id);
create index tokens_status_idx           on tokens (status);
create index tokens_expires_at_idx       on tokens (expires_at) where expires_at is not null;
create index tokens_accepted_risks_idx   on tokens using gin (accepted_risks);
create index tokens_delegation_chain_idx on tokens using gin (delegation_chain);
create index tokens_single_use_unconsumed_idx
  on tokens (id) where single_use = true and consumed_at is null;

-- ─── RLS ───────────────────────────────────────────────────────────────────
-- Same posture as access_tokens : org members RW through the user-scoped
-- Supabase client ; hash never read by the app (only by gateway hot-path via
-- service role).
alter table tokens enable row level security;

create policy "tokens select for org members"
  on tokens for select
  using (is_org_member(organization_id));

create policy "tokens write for org members"
  on tokens for all
  using (is_org_member(organization_id))
  with check (is_org_member(organization_id));
