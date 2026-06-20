-- =============================================================================
-- 0039_project_env_vars.sql
--
-- Project-scoped env var store ("venv"). Secrets are written server-side by
-- gateway tools (_to_venv) and consumed server-side by gateway tools
-- (_from_venv). Values never transit through the LLM context.
--
-- Spec : docs/spec/project-env-vars.md
-- =============================================================================

create table project_env_vars (
  project_id uuid    not null references projects(id) on delete cascade,
  key        text    not null,
  value      text    not null,
  source     text    not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, key)
);

alter table project_env_vars enable row level security;
-- No RLS policies: access only via service_role (gateway server-side).
