-- =============================================================================
-- 0001_init.sql — schema initial du MCP Proxy v4
--
-- Spec : docs/spec/mcp-proxy.md §3
-- ADRs :
--   - docs/decisions/rbac-org-role-bot-project.md
--   - docs/decisions/roles-naming-provider-scoped.md
--   - docs/decisions/policy-dsl-declarative-jsonb.md
--   - docs/decisions/api-key-format-vbn-live-argon2id.md
--   - docs/decisions/trust-model-clear-at-rest-idp-style.md
--
-- 9 tables : organizations, org_members, provider_admins, projects,
-- provider_bindings, roles, bots, bot_roles, audit_log.
-- RLS strict ; 2 rôles humains Org (member/admin).
-- Builtin roles seedés en fin de migration.
-- =============================================================================

create extension if not exists pgcrypto;

-- ─────────────────────────────────────────────────────────────────────────────
-- organizations
-- ─────────────────────────────────────────────────────────────────────────────
create table organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text not null unique check (slug ~ '^[a-z0-9](-?[a-z0-9])*$'),
  created_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- org_members  (2 rôles humains : member / admin)
-- ─────────────────────────────────────────────────────────────────────────────
create table org_members (
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  role            text not null default 'member' check (role in ('member', 'admin')),
  added_at        timestamptz not null default now(),
  primary key (organization_id, user_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- provider_admins  (1 row par (org, provider). Tokens chiffrés at-rest.)
-- ─────────────────────────────────────────────────────────────────────────────
create table provider_admins (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references organizations(id) on delete cascade,
  provider                 text not null check (provider in ('github', 'vercel', 'supabase')),
  status                   text not null default 'connected'
                              check (status in ('connected', 'expired', 'revoked')),
  installation_id          text,       -- github (App install)
  team_id                  text,       -- vercel
  access_token_encrypted   bytea,      -- vercel + supabase (chiffré at-rest via Vault)
  refresh_token_encrypted  bytea,      -- supabase
  expires_at               timestamptz,-- supabase access_token expiry
  connected_by_user_id     uuid references auth.users(id),
  connected_at             timestamptz not null default now(),
  unique (organization_id, provider)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- projects
-- ─────────────────────────────────────────────────────────────────────────────
create table projects (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name            text not null,
  slug            text not null check (slug ~ '^[a-z0-9](-?[a-z0-9])*$'),
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  unique (organization_id, slug)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- provider_bindings  (1 row par (project, provider))
-- ─────────────────────────────────────────────────────────────────────────────
create table provider_bindings (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references projects(id) on delete cascade,
  provider     text not null check (provider in ('github', 'vercel', 'supabase')),
  resource_ref text not null,
                -- github:  'owner/repo'
                -- vercel:  'prj_xxx'
                -- supabase: '<project_ref>'
  display_name text,
  created_at   timestamptz not null default now(),
  unique (project_id, provider)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- roles  (builtin global = organization_id NULL ; custom = scoped to an org)
-- ─────────────────────────────────────────────────────────────────────────────
create table roles (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  provider        text not null check (provider in ('github', 'vercel', 'supabase')),
  name            text not null check (name like provider || ':%'),
  description     text,
  is_builtin      boolean not null default false,
  permissions     jsonb not null,
                  -- {version: 1, rules: [{effect, tool|tool_matches, target?, constraints?, priority?}]}
  created_at      timestamptz not null default now(),
  unique nulls not distinct (organization_id, name)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- bots  (project-scoped, identifié par api_key)
-- ─────────────────────────────────────────────────────────────────────────────
create table bots (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references projects(id) on delete cascade,
  name            text not null check (name ~ '^[a-z0-9](-?[a-z0-9])*$'),
  api_key_prefix  text not null unique,
                  -- 8 chars random base62, fast lookup au hot-path
  api_key_hash    text not null,
                  -- argon2id(full api_key)
  status          text not null default 'active'
                      check (status in ('active', 'revoked')),
  last_used_at    timestamptz,
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  unique (project_id, name)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- bot_roles  (N-N Bot × Role)
-- ─────────────────────────────────────────────────────────────────────────────
create table bot_roles (
  bot_id   uuid not null references bots(id) on delete cascade,
  role_id  uuid not null references roles(id) on delete restrict,
  added_at timestamptz not null default now(),
  primary key (bot_id, role_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- audit_log  (append-only depuis l'app ; rétention 90j en hot DB)
-- ─────────────────────────────────────────────────────────────────────────────
create table audit_log (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references organizations(id) on delete cascade,
  project_id          uuid references projects(id) on delete set null,
  bot_id              uuid references bots(id) on delete set null,
  ts                  timestamptz not null default now(),
  tool_name           text not null,
  arguments_hash      text not null,  -- sha256(JSON.stringify(args)).slice(0, 16)
  role_matched        text,           -- role.name qui a allow ; null si denied
  decision            text not null check (decision in ('allowed', 'denied')),
  denial_reason       text,
  upstream_latency_ms int,
  client_ip           inet,
  client_user_agent   text
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Indices (cf. spec §3.2)
-- ─────────────────────────────────────────────────────────────────────────────
create index idx_provider_bindings_project on provider_bindings (project_id);
create index idx_bot_roles_bot on bot_roles (bot_id);
create index idx_bots_project on bots (project_id);
create index idx_audit_org_ts on audit_log (organization_id, ts desc);
create index idx_audit_bot_ts on audit_log (bot_id, ts desc);
create index idx_audit_denied
  on audit_log (organization_id, ts desc)
  where decision = 'denied';

-- ─────────────────────────────────────────────────────────────────────────────
-- Helper functions (utilisées par RLS)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.is_org_member(org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from org_members
    where organization_id = org and user_id = auth.uid()
  );
$$;

create or replace function public.is_org_admin(org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from org_members
    where organization_id = org
      and user_id = auth.uid()
      and role = 'admin'
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS  (cf. spec §3.3)
-- ─────────────────────────────────────────────────────────────────────────────
alter table organizations    enable row level security;
alter table org_members      enable row level security;
alter table provider_admins  enable row level security;
alter table projects         enable row level security;
alter table provider_bindings enable row level security;
alter table roles            enable row level security;
alter table bots             enable row level security;
alter table bot_roles        enable row level security;
alter table audit_log        enable row level security;

-- organizations : member R, admin RW (sauf delete = admin)
create policy "orgs select for members"
  on organizations for select
  using (is_org_member(id));
create policy "orgs insert for authenticated"
  on organizations for insert
  with check (auth.uid() is not null);
create policy "orgs update for admins"
  on organizations for update
  using (is_org_admin(id))
  with check (is_org_admin(id));
create policy "orgs delete for admins"
  on organizations for delete
  using (is_org_admin(id));

-- org_members : member R, admin RW
create policy "org_members select for members"
  on org_members for select
  using (is_org_member(organization_id));
create policy "org_members write for admins"
  on org_members for all
  using (is_org_admin(organization_id))
  with check (is_org_admin(organization_id));

-- provider_admins : member R, admin RW
create policy "provider_admins select for members"
  on provider_admins for select
  using (is_org_member(organization_id));
create policy "provider_admins write for admins"
  on provider_admins for all
  using (is_org_admin(organization_id))
  with check (is_org_admin(organization_id));

-- projects : member peut créer ses projects + R sur tous ; admin RW total
create policy "projects select for members"
  on projects for select
  using (is_org_member(organization_id));
create policy "projects insert for members"
  on projects for insert
  with check (is_org_member(organization_id));
create policy "projects update own or admin"
  on projects for update
  using (is_org_admin(organization_id) or created_by = auth.uid())
  with check (is_org_admin(organization_id) or created_by = auth.uid());
create policy "projects delete own or admin"
  on projects for delete
  using (is_org_admin(organization_id) or created_by = auth.uid());

-- provider_bindings : member R, admin RW
create policy "provider_bindings select"
  on provider_bindings for select
  using (
    exists (
      select 1 from projects p
      where p.id = project_id and is_org_member(p.organization_id)
    )
  );
create policy "provider_bindings write for admins"
  on provider_bindings for all
  using (
    exists (
      select 1 from projects p
      where p.id = project_id and is_org_admin(p.organization_id)
    )
  )
  with check (
    exists (
      select 1 from projects p
      where p.id = project_id and is_org_admin(p.organization_id)
    )
  );

-- roles : builtin R for all authenticated ; org-scoped R member, RW admin
create policy "roles select builtin"
  on roles for select
  using (organization_id is null and is_builtin = true);
create policy "roles select org members"
  on roles for select
  using (organization_id is not null and is_org_member(organization_id));
create policy "roles write org admins"
  on roles for all
  using (organization_id is not null and is_org_admin(organization_id))
  with check (organization_id is not null and is_org_admin(organization_id));

-- bots : member R (par-projet de son Org), admin RW
create policy "bots select"
  on bots for select
  using (
    exists (
      select 1 from projects p
      where p.id = project_id and is_org_member(p.organization_id)
    )
  );
create policy "bots write for admins"
  on bots for all
  using (
    exists (
      select 1 from projects p
      where p.id = project_id and is_org_admin(p.organization_id)
    )
  )
  with check (
    exists (
      select 1 from projects p
      where p.id = project_id and is_org_admin(p.organization_id)
    )
  );

-- bot_roles : member R, admin RW
create policy "bot_roles select"
  on bot_roles for select
  using (
    exists (
      select 1 from bots b
      join projects p on p.id = b.project_id
      where b.id = bot_id and is_org_member(p.organization_id)
    )
  );
create policy "bot_roles write for admins"
  on bot_roles for all
  using (
    exists (
      select 1 from bots b
      join projects p on p.id = b.project_id
      where b.id = bot_id and is_org_admin(p.organization_id)
    )
  )
  with check (
    exists (
      select 1 from bots b
      join projects p on p.id = b.project_id
      where b.id = bot_id and is_org_admin(p.organization_id)
    )
  );

-- audit_log : strictement R pour members (admin lit tout, member lit sa propre activité)
-- Pas d'UPDATE/DELETE depuis l'app — append-only.
create policy "audit_log select for org members"
  on audit_log for select
  using (is_org_member(organization_id));
-- Aucune policy INSERT/UPDATE/DELETE → seul le service_role (gateway) peut écrire.

-- ─────────────────────────────────────────────────────────────────────────────
-- Builtin roles seed (cf. spec §5.3)
-- ─────────────────────────────────────────────────────────────────────────────
insert into roles (id, organization_id, provider, name, description, is_builtin, permissions)
values
  (
    gen_random_uuid(),
    null,
    'github',
    'github:reader',
    'Read-only sur les repos bindés du Project (list/get/search).',
    true,
    jsonb_build_object(
      'version', 1,
      'rules', jsonb_build_array(
        jsonb_build_object(
          'effect', 'allow',
          'target', 'project.repos',
          'tool_matches', jsonb_build_array('github__list_*', 'github__get_*', 'github__search_*')
        )
      )
    )
  ),
  (
    gen_random_uuid(),
    null,
    'github',
    'github:developer',
    'Read + writes sur branches feature/*, fix/*, claude/*. Ouvre des PRs vers main. Pas de merge, pas de delete.',
    true,
    jsonb_build_object(
      'version', 1,
      'rules', jsonb_build_array(
        jsonb_build_object(
          'effect', 'allow',
          'target', 'project.repos',
          'tool_matches', jsonb_build_array('github__list_*', 'github__get_*', 'github__search_*')
        ),
        jsonb_build_object(
          'effect', 'allow',
          'target', 'project.repos',
          'tool_matches', jsonb_build_array('github__create_or_update_file', 'github__push_files'),
          'constraints', jsonb_build_object(
            'arguments.branch', jsonb_build_object('match', jsonb_build_array('feature/*', 'fix/*', 'claude/*'))
          )
        ),
        jsonb_build_object(
          'effect', 'allow',
          'target', 'project.repos',
          'tool', 'github__create_branch',
          'constraints', jsonb_build_object(
            'arguments.branch', jsonb_build_object('match', jsonb_build_array('feature/*', 'fix/*', 'claude/*'))
          )
        ),
        jsonb_build_object(
          'effect', 'allow',
          'target', 'project.repos',
          'tool', 'github__create_pull_request',
          'constraints', jsonb_build_object(
            'arguments.head', jsonb_build_object('match', jsonb_build_array('feature/*', 'fix/*', 'claude/*')),
            'arguments.base', jsonb_build_object('equals', 'main')
          )
        ),
        jsonb_build_object(
          'effect', 'deny',
          'tool_matches', jsonb_build_array('github__delete_*', 'github__merge_pull_request')
        )
      )
    )
  );
