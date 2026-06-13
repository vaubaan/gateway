-- =============================================================================
-- 0023_github_binding_env_less_exclude.sql
--
-- Adds per-binding configuration that narrows the fan-out semantics of an
-- env-less grant (spec gateway-capability-model.md §5.1 #4).
--
-- An env-less GitHub grant (`github:repo/code:write`) covers any branch at
-- runtime — too broad when the operator wants to protect `main` (or the set
-- of protected branches) without writing per-branch policy rules. Two opt-in
-- knobs on the binding solve this :
--
--   - `env_less_exclude_branch`    : a single branch name (typically 'main')
--     to exclude from the fan-out.
--   - `env_less_exclude_protected` : when true, exclude the set of *protected
--     branches* of the repo, resolved at call time via the GitHub install
--     token (cached short-TTL — implementation detail).
--
-- The two knobs are mutually exclusive (XOR) per the UI radio : an operator
-- picks either a named branch OR the protected set. Both null = no exclude
-- (true fan-out).
--
-- Greenfield — pas de data à migrer, pas de prod.
-- =============================================================================

alter table provider_bindings
  add column env_less_exclude_branch    text,
  add column env_less_exclude_protected boolean not null default false;

-- Shape : branch slug (lowercase, with optional `/` for `feature/x`-style refs).
alter table provider_bindings
  add constraint provider_bindings_env_less_exclude_branch_shape
    check (
      env_less_exclude_branch is null
      or env_less_exclude_branch ~ '^[a-z0-9](?:[a-z0-9/_-]*[a-z0-9])?$'
    );

-- XOR : either a named branch is excluded, or the protected set, never both.
alter table provider_bindings
  add constraint provider_bindings_env_less_exclude_xor
    check (
      not (env_less_exclude_branch is not null and env_less_exclude_protected = true)
    );

-- Non-github bindings must not carry github-only knobs (the gateway only reads
-- them on the github classifier path ; on other providers they'd be dead config
-- that misleads operators).
alter table provider_bindings
  add constraint provider_bindings_env_less_exclude_github_only
    check (
      provider = 'github'
      or (env_less_exclude_branch is null and env_less_exclude_protected = false)
    );
