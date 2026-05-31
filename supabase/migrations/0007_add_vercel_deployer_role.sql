-- =============================================================================
-- 0007_add_vercel_deployer_role.sql
--
-- Seed a `vercel:deployer` builtin role.
--
-- vercel:viewer (migration 0002) covers read-only. vercel:editor (migration
-- 0006) covers settings + env var writes but not deploy. The cheat sheet in
-- docs/handbook/vercel-provider.md surfaced a distinct use case "trigger
-- deploy + read logs without edit" (typical CI-style coding agent) that
-- neither role serves: viewer lacks deploy_to_vercel, editor lacks it by
-- design (edit ≠ deploy separation, mirrors github:developer / no merge).
--
-- Target is `project.vercel` (deploy requires an explicit binding, never '*'),
-- matching vercel:editor and the github:developer convention.
-- =============================================================================

insert into roles (id, organization_id, provider, name, description, is_builtin, permissions)
values
  (
    gen_random_uuid(),
    null,
    'vercel',
    'vercel:deployer',
    'Read + trigger deploys on bound Vercel projects. No edit of settings or env vars.',
    true,
    jsonb_build_object(
      'version', 1,
      'rules', jsonb_build_array(
        jsonb_build_object(
          'effect', 'allow',
          'target', 'project.vercel',
          'tool_matches', jsonb_build_array(
            'vercel__list_*',
            'vercel__get_*',
            'vercel__deploy_to_vercel'
          )
        )
      )
    )
  )
on conflict (organization_id, name) do nothing;
