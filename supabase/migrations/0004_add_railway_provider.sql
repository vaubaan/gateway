-- =============================================================================
-- 0004_add_railway_provider.sql
--
-- Add Railway (https://railway.com) to the provider catalogue.
--   1. Widen the `provider` CHECK constraints on the 3 provider-scoped tables.
--   2. Seed 2 builtin roles: railway:viewer (read) + railway:member (read+write).
--
-- Railway is a rewrap provider (mcp.railway.com), cf. ADR
-- railway-rewrap-remote-mcp.md. accept-deploy is the only DESTRUCTIVE tool and
-- is deny-listed by railway:member (same pattern as github:developer denying
-- merge_pull_request / delete_*).
-- =============================================================================

-- 1. Widen CHECK constraints -------------------------------------------------
alter table provider_admins   drop constraint if exists provider_admins_provider_check;
alter table provider_admins   add  constraint provider_admins_provider_check
  check (provider in ('github', 'vercel', 'supabase', 'railway'));

alter table provider_bindings drop constraint if exists provider_bindings_provider_check;
alter table provider_bindings add  constraint provider_bindings_provider_check
  check (provider in ('github', 'vercel', 'supabase', 'railway'));

alter table roles             drop constraint if exists roles_provider_check;
alter table roles             add  constraint roles_provider_check
  check (provider in ('github', 'vercel', 'supabase', 'railway'));

-- 2. Seed builtin roles ------------------------------------------------------
insert into roles (id, organization_id, provider, name, description, is_builtin, permissions)
values
  (
    gen_random_uuid(),
    null,
    'railway',
    'railway:viewer',
    'Read-only: whoami, list projects/services/deployments, get status & logs.',
    true,
    jsonb_build_object(
      'version', 1,
      'rules', jsonb_build_array(
        jsonb_build_object(
          'effect', 'allow',
          'target', '*',
          'tool_matches', jsonb_build_array('railway__whoami', 'railway__list-*', 'railway__get-*')
        )
      )
    )
  ),
  (
    gen_random_uuid(),
    null,
    'railway',
    'railway:member',
    'Read + write: create projects, redeploy, drive the railway-agent. Denies accept-deploy (DESTRUCTIVE).',
    true,
    jsonb_build_object(
      'version', 1,
      'rules', jsonb_build_array(
        jsonb_build_object(
          'effect', 'allow',
          'target', '*',
          'tool_matches', jsonb_build_array('railway__whoami', 'railway__list-*', 'railway__get-*')
        ),
        jsonb_build_object(
          'effect', 'allow',
          'target', '*',
          'tool_matches', jsonb_build_array('railway__create-project', 'railway__redeploy', 'railway__railway-agent')
        ),
        jsonb_build_object(
          'effect', 'deny',
          'tool_matches', jsonb_build_array('railway__accept-deploy')
        )
      )
    )
  )
on conflict (organization_id, name) do nothing;
