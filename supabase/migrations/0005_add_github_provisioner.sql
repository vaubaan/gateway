-- =============================================================================
-- 0005_add_github_provisioner.sql
--
-- 1. Seed builtin role `github:provisioner` — single permission : invoke the
--    new `github__mint_install_token` tool with `purpose=clone`. Used by CAR
--    (Coding Agent Runner) at session-bootstrap to mint a short-lived
--    installation token for `git clone` only. Internal — do not assign to
--    humans.
--
-- 2. Extend builtin `github:developer` to ALSO allow `github__mint_install_token`,
--    accepting either `purpose=clone` or `purpose=push` — the agent uses the
--    same tool to mint a push-scoped token for its commits.
--
-- Together this kills host-side git credentials on runner VPS : CAR clones with
-- a short-lived read token, the agent pushes with a short-lived write token,
-- both minted on demand via the gateway. ADR
-- `mint-install-token-runner-credential.md`.
-- =============================================================================

-- 1. Append a mint rule to the existing github:developer permissions.
update roles
set permissions = jsonb_set(
  permissions,
  '{rules}',
  permissions->'rules' || jsonb_build_array(
    jsonb_build_object(
      'effect', 'allow',
      'tool', 'github__mint_install_token',
      'constraints', jsonb_build_object(
        'arguments.purpose', jsonb_build_object('in', jsonb_build_array('clone', 'push'))
      )
    )
  )
)
where organization_id is null
  and name = 'github:developer'
  and is_builtin = true
  -- Idempotency : skip if a mint rule is already there.
  and not exists (
    select 1
    from jsonb_array_elements(permissions->'rules') as r
    where r->>'tool' = 'github__mint_install_token'
  );

-- 2. Seed the github:provisioner role.
insert into roles (id, organization_id, provider, name, description, is_builtin, permissions)
values
  (
    gen_random_uuid(),
    null,
    'github',
    'github:provisioner',
    'Internal — mint short-lived install tokens scoped to the project repos for clone. Used by CAR runner bootstrap ; do not assign to humans.',
    true,
    jsonb_build_object(
      'version', 1,
      'rules', jsonb_build_array(
        jsonb_build_object(
          'effect', 'allow',
          'tool', 'github__mint_install_token',
          'constraints', jsonb_build_object(
            'arguments.purpose', jsonb_build_object('equals', 'clone')
          )
        )
      )
    )
  )
on conflict (organization_id, name) do nothing;
