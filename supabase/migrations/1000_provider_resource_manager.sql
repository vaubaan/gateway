-- =====================================================================
-- 1000_provider_resource_manager.sql
--
-- Initial schema for the Cloud Resource Manager (CRM).
-- Reference: docs/spec/cloud-resource-manager.md §3.1, §3.2, §3.3, §4.1.
--
-- Greenfield migration (spec §13): no drop of legacy tables, no dual
-- write. The Supabase prod project's public schema is reset before this
-- migration applies.
--
-- Layout:
--   1. Foundational tenant tables: organizations, org_members, projects.
--   2. CRM-specific: user_crypto_keys, secret_managers, resources,
--      resource_access, mcp_configs, audit_log.
--   3. Indices (spec §3.2).
--   4. RLS enable + policies (spec §3.3, §8).
--      Two roles only: `member` (R), `admin` (RW). Fine-grain access
--      is enforced by the crypto recipient list (spec §4.4), not RBAC.
-- =====================================================================

set check_function_bodies = off;

-- ---------------------------------------------------------------------
-- 1. Tenant skeleton
-- ---------------------------------------------------------------------

create table public.organizations (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint organizations_slug_format check (slug ~ '^[a-z0-9](-?[a-z0-9])*$')
);

create table public.org_members (
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  role             text not null default 'member' check (role in ('member', 'admin')),
  joined_at        timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create index org_members_user_id_idx on public.org_members (user_id);

create table public.projects (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  slug             text not null,
  name             text not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, slug),
  constraint projects_slug_format check (slug ~ '^[a-z0-9](-?[a-z0-9])*$')
);

-- ---------------------------------------------------------------------
-- 2. CRM tables (spec §3.1)
-- ---------------------------------------------------------------------

-- 2.1 user_crypto_keys (spec §4.1.1)
create table public.user_crypto_keys (
  user_id              uuid primary key references auth.users(id) on delete cascade,
  public_key           bytea not null,
  fingerprint          text not null,
  wrapped_private_key  bytea not null,
  kdf_salt             bytea not null,
  kdf_params           jsonb not null default '{"m":67108864,"t":3,"p":1,"alg":"argon2id"}'::jsonb,
  created_at           timestamptz not null default now(),
  rotated_at           timestamptz not null default now()
);

-- 2.2 secret_managers (spec §3.1, §5.2)
create table public.secret_managers (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  kind                text not null,
  name                text not null,
  is_default          boolean not null default false,
  config              jsonb not null default '{}'::jsonb,
  auth_sealed_blob    bytea,
  created_at          timestamptz not null default now(),
  unique (organization_id, name)
);

-- Exactly one is_default=true per organization (partial unique index).
create unique index secret_managers_one_default_per_org
  on public.secret_managers (organization_id)
  where is_default;

-- 2.3 resources (spec §3.1)
create table public.resources (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations(id) on delete cascade,
  project_id             uuid references public.projects(id) on delete cascade,
  admin_resource_id      uuid references public.resources(id) on delete set null,
  provider_name          text not null,
  kind                   text not null,
  scope                  text not null,
  is_admin               boolean not null default false,
  name                   text not null,
  variant                text,
  provider_ref           text,
  console_url            text,
  setup_docs_url         text,
  health_test_cmd        text,
  status                 text not null default 'pending',
  secret_manager_id      uuid not null references public.secret_managers(id) on delete restrict,
  provider_metadata      jsonb not null default '{}'::jsonb,
  provider_permissions   jsonb not null default '{}'::jsonb,
  connection_status      text not null default 'unknown',
  connection_checked_at  timestamptz,
  connection_message     text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (organization_id, project_id, name),
  constraint resources_name_format check (name ~ '^[a-z0-9](-?[a-z0-9])*$'),
  constraint resources_variant_format check (variant is null or variant ~ '^[a-z0-9](-?[a-z0-9])*$'),
  constraint resources_scope_values check (scope in ('org', 'project')),
  constraint resources_scope_project_match check (
    (scope = 'org'     and project_id is null)
    or (scope = 'project' and project_id is not null)
  ),
  -- Only project-scoped resources can attach to an admin.
  constraint resources_admin_only_on_project check (
    admin_resource_id is null or scope = 'project'
  ),
  -- Admin resources are always org-scoped.
  constraint resources_admin_is_org_scoped check (
    is_admin = false or scope = 'org'
  )
);

-- 2.4 resource_access (spec §3.1, §4.3)
create table public.resource_access (
  id            uuid primary key default gen_random_uuid(),
  resource_id   uuid not null references public.resources(id) on delete cascade,
  key           text not null,
  sealed_blob   bytea not null,
  description   text,
  rotated_at    timestamptz not null default now(),
  unique (resource_id, key)
);

-- 2.5 mcp_configs (spec §3.1, §6.6)
create table public.mcp_configs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  project_id       uuid references public.projects(id) on delete cascade,
  variant          text,
  mcp_snapshot     jsonb not null,
  env_snapshot     jsonb not null,
  generated_at     timestamptz not null default now(),
  constraint mcp_configs_variant_format check (variant is null or variant ~ '^[a-z0-9](-?[a-z0-9])*$')
);

-- One snapshot live per (org, project, variant) — UPSERT on regenerate.
-- NULLS NOT DISTINCT so (project_id null, variant null) collides with itself.
create unique index mcp_configs_unique_scope
  on public.mcp_configs (organization_id, project_id, variant) nulls not distinct;

-- 2.6 audit_log (spec §3.1, §9)
create table public.audit_log (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  actor_user_id    uuid references auth.users(id) on delete set null,
  action           text not null,
  scope            jsonb not null default '{}'::jsonb,
  subject          jsonb not null default '{}'::jsonb,
  at               timestamptz not null default now()
);

create index audit_log_org_at_idx on public.audit_log (organization_id, at desc);
create index audit_log_action_idx on public.audit_log (action);

-- ---------------------------------------------------------------------
-- 3. Indices (spec §3.2)
-- ---------------------------------------------------------------------

create index resources_org_scope_provider_kind_idx
  on public.resources (organization_id, scope, provider_name, kind);

create index resources_project_kind_variant_idx
  on public.resources (project_id, kind, variant);

create index resources_org_admins_idx
  on public.resources (organization_id, is_admin)
  where is_admin;

create index resource_access_resource_idx
  on public.resource_access (resource_id);

-- ---------------------------------------------------------------------
-- 4. Membership helper (used by RLS policies)
-- ---------------------------------------------------------------------

create or replace function public.is_org_member(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.org_members m
    where m.organization_id = p_org_id
      and m.user_id = auth.uid()
  );
$$;

create or replace function public.is_org_admin(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.org_members m
    where m.organization_id = p_org_id
      and m.user_id = auth.uid()
      and m.role = 'admin'
  );
$$;

revoke all on function public.is_org_member(uuid) from public;
revoke all on function public.is_org_admin(uuid) from public;
grant execute on function public.is_org_member(uuid) to authenticated;
grant execute on function public.is_org_admin(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Row Level Security (spec §3.3, §8)
-- ---------------------------------------------------------------------
-- Two roles per organization, member (R) and admin (RW). Granularity
-- finer than "what blobs to decrypt" is enforced by the crypto recipient
-- list (spec §4.4), not by RLS.

alter table public.organizations    enable row level security;
alter table public.org_members      enable row level security;
alter table public.projects         enable row level security;
alter table public.user_crypto_keys enable row level security;
alter table public.secret_managers  enable row level security;
alter table public.resources        enable row level security;
alter table public.resource_access  enable row level security;
alter table public.mcp_configs      enable row level security;
alter table public.audit_log        enable row level security;

-- 5.1 organizations
-- Read: members. Write: admins only.
create policy organizations_select_member
  on public.organizations for select
  to authenticated
  using (public.is_org_member(id));

create policy organizations_update_admin
  on public.organizations for update
  to authenticated
  using (public.is_org_admin(id))
  with check (public.is_org_admin(id));

-- 5.2 org_members
-- Read: any member of the org.
-- Write (insert/update/delete): admins of the same org.
create policy org_members_select_member
  on public.org_members for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy org_members_insert_admin
  on public.org_members for insert
  to authenticated
  with check (public.is_org_admin(organization_id));

create policy org_members_update_admin
  on public.org_members for update
  to authenticated
  using (public.is_org_admin(organization_id))
  with check (public.is_org_admin(organization_id));

create policy org_members_delete_admin
  on public.org_members for delete
  to authenticated
  using (public.is_org_admin(organization_id));

-- 5.3 projects
create policy projects_select_member
  on public.projects for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy projects_insert_admin
  on public.projects for insert
  to authenticated
  with check (public.is_org_admin(organization_id));

create policy projects_update_admin
  on public.projects for update
  to authenticated
  using (public.is_org_admin(organization_id))
  with check (public.is_org_admin(organization_id));

create policy projects_delete_admin
  on public.projects for delete
  to authenticated
  using (public.is_org_admin(organization_id));

-- 5.4 user_crypto_keys
-- Each authenticated user owns one row. They can read it, insert it
-- (lazy bootstrap, spec §4.1) and update it (password rotation §4.6 /
-- lost password §4.7). They cannot delete it (deletion cascades from
-- auth.users deletion).
create policy user_crypto_keys_select_self
  on public.user_crypto_keys for select
  to authenticated
  using (user_id = auth.uid());

create policy user_crypto_keys_insert_self
  on public.user_crypto_keys for insert
  to authenticated
  with check (user_id = auth.uid());

create policy user_crypto_keys_update_self
  on public.user_crypto_keys for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Members of an org also need to read the public_key + fingerprint of
-- their peers (recipient list computation, spec §4.4). Spec §4.3 puts
-- the public_key in the row; reading the full row here is acceptable
-- because wrapped_private_key is useless without the user's password.
create policy user_crypto_keys_select_org_peer
  on public.user_crypto_keys for select
  to authenticated
  using (
    exists (
      select 1
      from public.org_members me
      join public.org_members peer
        on peer.organization_id = me.organization_id
      where me.user_id = auth.uid()
        and peer.user_id = public.user_crypto_keys.user_id
    )
  );

-- 5.5 secret_managers — admin RW, member R (spec §3.3).
create policy secret_managers_select_member
  on public.secret_managers for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy secret_managers_insert_admin
  on public.secret_managers for insert
  to authenticated
  with check (public.is_org_admin(organization_id));

create policy secret_managers_update_admin
  on public.secret_managers for update
  to authenticated
  using (public.is_org_admin(organization_id))
  with check (public.is_org_admin(organization_id));

create policy secret_managers_delete_admin
  on public.secret_managers for delete
  to authenticated
  using (public.is_org_admin(organization_id));

-- 5.6 resources — admin RW, member R.
create policy resources_select_member
  on public.resources for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy resources_insert_admin
  on public.resources for insert
  to authenticated
  with check (public.is_org_admin(organization_id));

create policy resources_update_admin
  on public.resources for update
  to authenticated
  using (public.is_org_admin(organization_id))
  with check (public.is_org_admin(organization_id));

create policy resources_delete_admin
  on public.resources for delete
  to authenticated
  using (public.is_org_admin(organization_id));

-- 5.7 resource_access — admin RW, member R (R is "fetch sealed_blob";
-- members cannot decrypt blobs where their pubkey isn't a recipient —
-- spec §3.3 footnote 1).
create policy resource_access_select_member
  on public.resource_access for select
  to authenticated
  using (
    exists (
      select 1 from public.resources r
      where r.id = resource_access.resource_id
        and public.is_org_member(r.organization_id)
    )
  );

create policy resource_access_insert_admin
  on public.resource_access for insert
  to authenticated
  with check (
    exists (
      select 1 from public.resources r
      where r.id = resource_access.resource_id
        and public.is_org_admin(r.organization_id)
    )
  );

create policy resource_access_update_admin
  on public.resource_access for update
  to authenticated
  using (
    exists (
      select 1 from public.resources r
      where r.id = resource_access.resource_id
        and public.is_org_admin(r.organization_id)
    )
  )
  with check (
    exists (
      select 1 from public.resources r
      where r.id = resource_access.resource_id
        and public.is_org_admin(r.organization_id)
    )
  );

create policy resource_access_delete_admin
  on public.resource_access for delete
  to authenticated
  using (
    exists (
      select 1 from public.resources r
      where r.id = resource_access.resource_id
        and public.is_org_admin(r.organization_id)
    )
  );

-- 5.8 mcp_configs — admin RW, member R.
create policy mcp_configs_select_member
  on public.mcp_configs for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy mcp_configs_insert_admin
  on public.mcp_configs for insert
  to authenticated
  with check (public.is_org_admin(organization_id));

create policy mcp_configs_update_admin
  on public.mcp_configs for update
  to authenticated
  using (public.is_org_admin(organization_id))
  with check (public.is_org_admin(organization_id));

create policy mcp_configs_delete_admin
  on public.mcp_configs for delete
  to authenticated
  using (public.is_org_admin(organization_id));

-- 5.9 audit_log — read for members of the org, no writes from clients
-- (server-side service-role inserts only; spec §9).
create policy audit_log_select_member
  on public.audit_log for select
  to authenticated
  using (public.is_org_member(organization_id));

-- ---------------------------------------------------------------------
-- 6. updated_at trigger helper
-- ---------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function public.set_updated_at();

create trigger projects_set_updated_at
  before update on public.projects
  for each row execute function public.set_updated_at();

create trigger resources_set_updated_at
  before update on public.resources
  for each row execute function public.set_updated_at();
