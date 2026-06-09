-- =============================================================================
-- 0019_runner_services.sql
--
-- Per-project annotated-bash services. Each row is a bash file annotated
-- with `# @vaubaan: …` comments that declare the capability surface
-- (plane / ring / read|write / args). The parser turns the file into a
-- provider entry : tools = annotated functions, capabilities = derived from
-- the annotations.
--
-- Slug = the provider slug used in the capability notation
-- (`<service_slug>:<ring>:<action>@<host_slug>`). Must avoid the built-in
-- provider slugs (github / vercel / supabase / railway / ssh) — guarded by
-- CHECK.
--
-- `parsed_meta` caches the parser output ; refreshed at every update by the
-- API. `parse_error` is set when the file is structurally invalid so the
-- UI can show a friendly error without re-parsing.
--
-- Spec : docs/spec/gateway-capability-model.md §6 (classify, plugin layer).
-- =============================================================================

create table runner_services (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,

  slug text not null
    check (slug ~ '^[a-z][a-z0-9-]*$'
           and slug not in ('github','vercel','supabase','railway','ssh')),
  display_name text not null,
  description text,

  bash_content text not null,
  parsed_meta jsonb,
  parse_error text,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (project_id, slug)
);

create index runner_services_project_idx on runner_services (project_id);

alter table runner_services enable row level security;

create policy "org members can read their project's services"
  on runner_services
  for select
  using (
    project_id in (
      select p.id
      from projects p
      join org_members om on om.organization_id = p.organization_id
      where om.user_id = auth.uid()
    )
  );
