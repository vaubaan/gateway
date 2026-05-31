-- =============================================================================
-- 0006_add_vercel_editor_role.sql
--
-- Seed a `vercel:editor` builtin role.
--
-- vercel:viewer (migration 0002) is read-only. Once the provider gained the
-- custom REST-backed tools `vercel__update_project_settings` and
-- `vercel__upsert_env_var` (cf. docs/decisions/vercel-augment-with-rest-tools.md),
-- downstream bots need a role that grants those write verbs to actually use
-- them — default-deny otherwise filters them out of `tools/list`.
--
-- Target is `project.vercel` (scoped to bound projects), not '*' — write
-- operations should require an explicit binding, matching the github:developer
-- convention.
-- =============================================================================

insert into roles (id, organization_id, provider, name, description, is_builtin, permissions)
values
  (
    gen_random_uuid(),
    null,
    'vercel',
    'vercel:editor',
    'Read + edit project settings (root directory, framework, build commands…) + upsert env vars on bound Vercel projects. No deploy.',
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
            'vercel__update_*',
            'vercel__upsert_*'
          )
        )
      )
    )
  )
on conflict (organization_id, name) do nothing;
