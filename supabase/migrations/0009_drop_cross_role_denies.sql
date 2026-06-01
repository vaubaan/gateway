-- =============================================================================
-- 0009_drop_cross_role_denies.sql
--
-- Drop the cross-role deny rules from `github:developer` and `railway:member`.
--
-- WHY
-- ---
-- Both roles allow specific tools (no wildcards), then carry an explicit
-- `deny` rule on destructive tools — `github__delete_*` /
-- `github__merge_pull_request` for developer, `railway__accept-deploy` for
-- member. Those denies are load-bearing nowhere: none of the allow rules
-- match the denied tools, so default-deny already blocks them when the role
-- is assigned alone.
--
-- The visible side-effect is bad UX : per the engine's `deny override allow`
-- semantics, assigning `railway:member` + `railway:deployer` together kept
-- `accept-deploy` denied — checking more roles should never *remove* rights.
-- By dropping these deny rules, multi-role assignment becomes additive
-- (union of allows), aligning with the user's mental model.
--
-- WHAT STAYS
-- ----------
-- Engine semantics (`deny override allow`, default-deny) are unchanged. The
-- intra-role pattern "allow `foo__*` then deny `foo__delete_*`" remains
-- supported for custom roles that need wildcard-with-exception. We just stop
-- using cross-role denies in builtin seeds.
--
-- IDEMPOTENCY
-- -----------
-- Rewrites `permissions` JSONB for the two affected builtin rows. Safe to
-- re-run.
-- =============================================================================

update roles
set permissions = jsonb_build_object(
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
    )
  )
)
where organization_id is null
  and is_builtin = true
  and provider = 'github'
  and name = 'github:developer';

update roles
set permissions = jsonb_build_object(
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
    )
  )
)
where organization_id is null
  and is_builtin = true
  and provider = 'railway'
  and name = 'railway:member';
