-- =============================================================================
-- 0002_add_builtin_roles_vercel_supabase.sql
--
-- Seed 2 additional builtin roles for the Vercel + Supabase providers.
-- Both are read-only — write semantics for these providers land in v1.5+
-- once we have OAuth flows registered (cf. ADR oauth-app-install-per-provider).
-- =============================================================================

insert into roles (id, organization_id, provider, name, description, is_builtin, permissions)
values
  (
    gen_random_uuid(),
    null,
    'vercel',
    'vercel:viewer',
    'Read-only: list/get projects, list/get deployments, fetch build & runtime logs.',
    true,
    jsonb_build_object(
      'version', 1,
      'rules', jsonb_build_array(
        jsonb_build_object(
          'effect', 'allow',
          'target', '*',
          'tool_matches', jsonb_build_array('vercel__list_*', 'vercel__get_*')
        )
      )
    )
  ),
  (
    gen_random_uuid(),
    null,
    'supabase',
    'supabase:reader',
    'Read-only: get project, list tables/migrations, execute SELECT-style SQL, get advisors.',
    true,
    jsonb_build_object(
      'version', 1,
      'rules', jsonb_build_array(
        jsonb_build_object(
          'effect', 'allow',
          'target', '*',
          'tool_matches', jsonb_build_array('supabase__get_*', 'supabase__list_*', 'supabase__execute_sql')
        )
      )
    )
  )
on conflict (organization_id, name) do nothing;
