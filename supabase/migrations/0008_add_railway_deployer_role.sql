-- =============================================================================
-- 0008_add_railway_deployer_role.sql
--
-- Seed a `railway:deployer` builtin role.
--
-- railway:viewer / railway:member (migration 0004) cover read-only and
-- read+write-minus-destructive. The DESTRUCTIVE `railway__accept-deploy` is
-- deny-listed in railway:member — it commits all staged environment patches
-- and triggers a deploy, the Railway equivalent of clicking the "Deploy"
-- button after staging settings/env-var/service patches in the UI.
--
-- Without a builtin role that allows accept-deploy, downstream bots can stage
-- changes via `railway__redeploy` / `railway__railway-agent` but cannot ever
-- commit them — the staged patches sit in the environment until a human
-- clicks Deploy in the dashboard. Following the vercel:deployer pattern
-- (migration 0007), we add a standalone role that grants read + accept-deploy
-- only. Caller assigns this in addition to (or instead of) railway:member
-- depending on the trust profile.
--
-- Target is `project.railway` (deploy requires an explicit binding, never
-- '*'), matching the vercel:deployer / github:developer convention.
-- =============================================================================

insert into roles (id, organization_id, provider, name, description, is_builtin, permissions)
values
  (
    gen_random_uuid(),
    null,
    'railway',
    'railway:deployer',
    'Read + commit staged changes & deploy on bound Railway projects. No create-project, no edit via railway-agent.',
    true,
    jsonb_build_object(
      'version', 1,
      'rules', jsonb_build_array(
        jsonb_build_object(
          'effect', 'allow',
          'target', 'project.railway',
          'tool_matches', jsonb_build_array(
            'railway__whoami',
            'railway__list-*',
            'railway__get-*',
            'railway__accept-deploy'
          )
        )
      )
    )
  )
on conflict (organization_id, name) do nothing;
