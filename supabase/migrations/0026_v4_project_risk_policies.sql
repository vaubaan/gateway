-- =============================================================================
-- 0026_v4_project_risk_policies.sql
--
-- Phase 3 of the v4 risk-based pivot — replaces `policy_rules` (migration
-- 0016) with a lighter table that ONLY overrides the catalog's `default_gate`
-- per project.
--
-- Schema rationale (cf. spec v4 §6) :
--   - The catalog of risks (YAML, versioned in the repo) is the source of
--     truth for `default_gate`. No risk → DB row is required for a project
--     to inherit the default.
--   - A row in `project_risk_policies` exists ONLY when the project deviates
--     from the catalog default.
--   - `env_scope = null` → overrides for every binding env on this project.
--   - `env_scope = '<env>'` → overrides only when the binding env matches.
--     The most-specific override wins (env-scoped > global > catalog default).
--
-- Anti-pattern guards (cf. ADR §D1, §D2) :
--   - RiskId regex CHECK (same shape as access_tokens).
--   - env_scope slug CHECK.
--   - A row with gate='allow' overriding a catalog risk whose vector has
--     `persistence: posture` OR (`data ∈ {secret,pii}` AND action='W') must be
--     gated by application-level admin-role check. CANNOT be enforced in pure
--     SQL because the catalog lives in YAML — moved to the API middleware.
--     We mark such overrides with `requires_admin_override boolean` so the
--     UI and audit log can trace them, and the API ensures the writer is admin.
--
-- Migration : the legacy `policy_rules` table is dropped in migration 0027,
-- after the API & gateway have been switched to read from the new table.
-- =============================================================================

create table project_risk_policies (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  risk_id text not null
    check (risk_id ~ '^[a-z][a-z0-9]*(\[[a-z][a-z0-9-]*\])?(\.[a-z][a-z0-9-]+)+$'),
  -- Null = applies to every binding env. Slug = applies only to that env.
  env_scope text
    check (env_scope is null or env_scope ~ '^[a-z][a-z0-9-]*$'),
  gate text not null check (gate in ('allow', 'confirm', 'deny')),
  -- Marked TRUE iff the override is 'allow' on a risk that the catalog
  -- typically would defend (posture / secret W / pii W). Surface to UI.
  requires_admin_override boolean not null default false,
  -- Audit trail
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  -- Uniqueness : at most one override per (project, risk_id, env_scope).
  -- nulls not distinct so that NULL env_scope deduplicates correctly.
  constraint project_risk_policies_unique_scope
    unique nulls not distinct (project_id, risk_id, env_scope)
);

create index project_risk_policies_project_idx
  on project_risk_policies (project_id);
create index project_risk_policies_risk_idx
  on project_risk_policies (risk_id);

-- ─── updated_at trigger ─────────────────────────────────────────────────────
create or replace function project_risk_policies_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger project_risk_policies_set_updated_at
  before update on project_risk_policies
  for each row execute function project_risk_policies_touch_updated_at();

-- ─── RLS ────────────────────────────────────────────────────────────────────
alter table project_risk_policies enable row level security;

create policy "org members can read their project's risk policies"
  on project_risk_policies for select
  using (
    project_id in (
      select p.id from projects p
      join org_members om on om.organization_id = p.organization_id
      where om.user_id = auth.uid()
    )
  );

-- Writes go through the API (service role) — no client-side mutation policy.
