-- =============================================================================
-- 0011_capabilities_replace_roles.sql
--
-- Replaces the role + policy-DSL model with the capability model.
--
--  - A capability is a 5-tuple (provider, plane, level, action, env?) carried
--    directly on the access token as a jsonb array. No more roles, no more
--    declarative policy rules in the DB — classification (tool,args)→capability
--    now lives in code, in each provider plugin (`classify()`).
--    A `plane` is a concentric stack of `level`s declared by the provider
--    (supabase exposes `db`/`storage`/`auth`/`functions` — cf. spec §2.1).
--    `action` is `read` or `write` ; `env` is dynamic (created on the fly like
--    a git branch) and present per-data, not per-level (spec §4).
--  - `provider_bindings` gains an `environment` so the same project can bind a
--    provider per env (staging Supabase vs prod Supabase). The old
--    unique(project_id, provider) blocked that.
--  - `audit_log.role_matched` → `capability_matched` (shorthand string).
--
-- Greenfield — pas de prod, pas de dual-write, pas de migration de données.
-- Les roles builtin seedés (0001, 0002, 0005-0009) disparaissent avec la table.
--
-- Spec : docs/spec/gateway-capability-model.draft.md
-- =============================================================================

-- 1. Drop the role model (access_token_roles first — it FKs roles). CASCADE
--    removes the attached RLS policies and indexes.
drop table if exists access_token_roles cascade;
drop table if exists roles cascade;

-- 2. Capabilities carried directly on the access token (the full tuples).
--    [{ "provider": "...", "plane": "...", "level": "...",
--       "action": "read"|"write", "env"?: "..." }, ...]
alter table access_tokens
  add column capabilities jsonb not null default '[]'::jsonb;

-- 3. Environment as a first-class dimension of a binding. Env exists where a
--    resource has parallel canonical instances (cf. spec §3.4). For providers
--    where env = a separate resource (Supabase), it's a distinct binding row ;
--    for providers where env = an argument (Vercel/Railway), it stays null and
--    the classifier resolves env from the call args.
alter table provider_bindings
  drop constraint if exists provider_bindings_project_id_provider_key;

alter table provider_bindings
  add column environment text
    check (environment is null or environment ~ '^[a-z0-9](-?[a-z0-9])*$');

-- nulls not distinct : a single env-less binding per provider, plus any number
-- of named-env bindings.
alter table provider_bindings
  add constraint provider_bindings_project_provider_env_key
    unique nulls not distinct (project_id, provider, environment);

-- 4. Audit : role_matched → capability_matched (notation, e.g.
--    'vercel:runtime/deployment:write@prod').
alter table audit_log
  rename column role_matched to capability_matched;
