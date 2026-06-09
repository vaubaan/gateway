-- =============================================================================
-- 0012_policy_rules.sql
--
-- Adds the policy layer (spec §5, §5.1). A `policy_rule` maps a capability
-- pattern (provider, plane, level, action, env) to a *gate* :
--   - `ai`    : the mint endpoint may issue a token carrying this capability
--               without human intervention.
--   - `human` : the mint endpoint MUST hold a human approval (Phase 4 wires
--               the ApprovalChannel + approval_requests). For now, mint
--               refuses with an actionable error.
--
-- Default-deny : a capability with no matching `ai` rule falls back to
-- human-gated. So leaving the table empty for a project locks every mint
-- behind human approval — explicit allow-list.
--
-- Per-project seed (and trigger for future projects) :
--   - reads on anything → `ai` (low blast, fan-out tolerated).
--   - writes on anything → `human` (high blast by default ; operators add
--                                   explicit `write@feature/*` → ai rules etc.).
--
-- Anti-pattern guard (spec §5.1 #2) : a CHECK constraint rejects rules of the
-- shape `(action='write', env_pattern='*', gate='ai')` — a blanket ai-allow on
-- writes would silently authorize prod. The seed above is exempt because it
-- sets gate='human' on that exact pattern (the safe direction).
--
-- Spec : docs/spec/gateway-capability-model.draft.md §5, §5.1.
-- =============================================================================

create table policy_rules (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  provider text not null
    check (provider = '*' or provider ~ '^[a-z][a-z0-9-]*$'),
  plane text not null
    check (plane = '*' or plane ~ '^[a-z][a-z0-9-]*$'),
  level text not null
    check (level = '*' or level ~ '^[a-z][a-z0-9-]*$'),
  action text not null
    check (action in ('read', 'write', '*')),
  env_pattern text not null
    check (env_pattern = '*' or env_pattern ~ '^[a-z0-9](?:[a-z0-9/_-]*[a-z0-9])?$'),
  gate text not null
    check (gate in ('ai', 'human')),
  -- Higher specificity wins ; ties broken by priority desc.
  priority int not null default 100,
  created_at timestamptz not null default now(),
  -- Anti-pattern guard : refuse a blanket ai-allow on writes
  -- (env_pattern='*' AND action='write' AND gate='ai').
  constraint policy_rules_no_blanket_ai_write
    check (not (action = 'write' and env_pattern = '*' and gate = 'ai'))
);

create index policy_rules_project_idx on policy_rules (project_id);

-- ─── Seed default rules for every existing project ──────────────────────────
insert into policy_rules (project_id, provider, plane, level, action, env_pattern, gate, priority)
  select id, '*', '*', '*', 'read',  '*', 'ai',    0 from projects;
insert into policy_rules (project_id, provider, plane, level, action, env_pattern, gate, priority)
  select id, '*', '*', '*', 'write', '*', 'human', 0 from projects;

-- ─── Auto-seed for new projects ─────────────────────────────────────────────
create or replace function seed_default_policy_rules() returns trigger as $$
begin
  insert into policy_rules
    (project_id, provider, plane, level, action, env_pattern, gate, priority)
  values
    (new.id, '*', '*', '*', 'read',  '*', 'ai',    0),
    (new.id, '*', '*', '*', 'write', '*', 'human', 0);
  return new;
end;
$$ language plpgsql;

create trigger projects_seed_policy_rules
  after insert on projects
  for each row execute function seed_default_policy_rules();

-- ─── RLS ────────────────────────────────────────────────────────────────────
-- Service role bypasses RLS (used by the mint route). Org-member read access
-- is added as a separate policy so the future Policy management UI can list
-- rules ; mutations stay service-role-only for now.
alter table policy_rules enable row level security;

create policy "org members can read their project's policy rules"
  on policy_rules
  for select
  using (
    project_id in (
      select p.id
      from projects p
      join org_members om on om.organization_id = p.organization_id
      where om.user_id = auth.uid()
    )
  );
