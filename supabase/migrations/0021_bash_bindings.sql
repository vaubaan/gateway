-- =============================================================================
-- 0021_bash_bindings.sql
--
-- Split the bash provider into two concepts :
--   • bash_bindings → the SCRIPT (= identity of the binding).
--   • ssh_bindings  → a HOST attached to a binding (= one env).
--
-- 1 bash_binding can have N ssh_bindings attached. Each attached host is one
-- env in `bash:<ring>:<action>@<host_slug>`. If the operator wants a
-- different script, they create a new bash_binding (with its own hosts).
--
-- Backfill : the two existing ssh_bindings (vps-rp, vps-fidi) carry the same
-- runner script. We group by md5(bash_content) → create one bash_binding
-- "runner" → link both hosts to it. Then we drop the script columns from
-- ssh_bindings since they now live in bash_bindings.
-- =============================================================================

create table bash_bindings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z][a-z0-9-]*$'),
  display_name text not null,
  description text,

  bash_content text,
  parsed_meta jsonb,
  parse_error text,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (project_id, slug)
);

create index bash_bindings_project_idx on bash_bindings (project_id);

alter table bash_bindings enable row level security;

create policy "org members read their project's bash_bindings"
  on bash_bindings
  for select
  using (
    project_id in (
      select p.id
      from projects p
      join org_members om on om.organization_id = p.organization_id
      where om.user_id = auth.uid()
    )
  );

-- ── Attach ssh_bindings to a bash_binding ────────────────────────────────────
alter table ssh_bindings
  add column bash_binding_id uuid references bash_bindings(id) on delete cascade;

-- ── Backfill : group existing rows by content into bash_bindings ─────────────
do $$
declare
  v_project uuid;
  v_content text;
  v_meta jsonb;
  v_bid uuid;
  v_slug text;
  v_counter int;
begin
  for v_project, v_content in
    select project_id, bash_content
    from ssh_bindings
    where bash_content is not null
    group by project_id, bash_content
  loop
    -- Pick parsed_meta from any row in the group ; they share the script
    -- so they share the meta.
    select parsed_meta into v_meta
    from ssh_bindings
    where project_id = v_project
      and bash_content = v_content
    limit 1;

    -- Slug : 'runner' if free, else 'runner-2', 'runner-3', …
    v_slug := 'runner';
    v_counter := 1;
    while exists (
      select 1 from bash_bindings
      where project_id = v_project and slug = v_slug
    ) loop
      v_counter := v_counter + 1;
      v_slug := 'runner-' || v_counter;
    end loop;

    insert into bash_bindings
      (project_id, slug, display_name, bash_content, parsed_meta)
    values
      (v_project, v_slug, initcap(v_slug), v_content, v_meta)
    returning id into v_bid;

    update ssh_bindings
    set bash_binding_id = v_bid
    where project_id = v_project
      and bash_content = v_content;
  end loop;
end$$;

-- ── Drop the redundant per-host script columns ───────────────────────────────
alter table ssh_bindings
  drop column bash_content,
  drop column parsed_meta,
  drop column parse_error;

create index ssh_bindings_bash_binding_idx on ssh_bindings (bash_binding_id);
