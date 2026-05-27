-- =============================================================================
-- 0003_org_management_keys.sql
--
-- Adds the `org_management_keys` table: org-scoped Bearer credential used by
-- external services (e.g. the Coding Agent Runner) to mint AccessTokens
-- programmatically via POST /api/v1/runner/tokens.
--
-- Also adds `access_tokens.expires_at` so runner-minted tokens can carry a TTL
-- enforced at the gateway hot-path.
--
-- Spec : docs/spec/mcp-proxy.md §3.1 (ManagementKey)
-- ADR  : docs/decisions/org-management-keys-for-runner.md
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- org_management_keys  (org-scoped; never grants MCP access — only used to
-- authenticate the Runner against /api/v1/runner/*).
-- ─────────────────────────────────────────────────────────────────────────────
create table org_management_keys (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name            text not null check (name ~ '^[a-z0-9](-?[a-z0-9])*$'),
  api_key_prefix  text not null unique,
                  -- 8 chars random base62, fast lookup at /runner/* auth
  api_key_hash    text not null,
                  -- argon2id(full api_key)
  status          text not null default 'active'
                      check (status in ('active', 'revoked')),
  last_used_at    timestamptz,
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  unique (organization_id, name)
);

create index idx_org_management_keys_org on org_management_keys (organization_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- access_tokens.expires_at  (NULL = no TTL ; rejected by the gateway when
-- now() > expires_at).
-- ─────────────────────────────────────────────────────────────────────────────
alter table access_tokens add column expires_at timestamptz;

create index idx_access_tokens_expires_at
  on access_tokens (expires_at)
  where expires_at is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS — flat membership: any org member can RW management keys.
-- The hash is never read by the app (only by the runner auth path via
-- service_role).
-- ─────────────────────────────────────────────────────────────────────────────
alter table org_management_keys enable row level security;

create policy "org_management_keys select for members"
  on org_management_keys for select
  using (is_org_member(organization_id));

create policy "org_management_keys write for members"
  on org_management_keys for all
  using (is_org_member(organization_id))
  with check (is_org_member(organization_id));
