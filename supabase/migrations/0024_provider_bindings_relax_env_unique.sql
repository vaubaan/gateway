-- Relax provider_bindings uniqueness so multiple env-null bindings per
-- (project, provider) are allowed.
--
-- Reasoning (cf. UI rework binding slug ≠ env for github/vercel) :
--  - The "binding slug" (column `environment`) only doubles as env for
--    Supabase / Railway (one upstream project per env). For github / vercel
--    the slug is informational at most ; env comes from call args.
--  - Operators legitimately want to bind several github repos or several
--    Vercel projects in the same Vaubaan project without inventing a slug.
--    The previous `nulls not distinct` constraint blocked the second null.
--
-- New shape : the unique key is (project_id, provider, environment) with
-- default `nulls distinct` semantics — multiple NULLs are allowed (each row
-- is unique by `id`), but two non-null slugs of the same value on the same
-- (project, provider) are still rejected.
--
-- Spec : docs/spec/vaubaan-gateway.md §3.4 (binding shape), docs/handbook/
-- supabase-provider.md / railway-provider.md (env-from-binding semantics).

alter table provider_bindings
  drop constraint if exists provider_bindings_project_provider_env_key;

alter table provider_bindings
  add constraint provider_bindings_project_provider_env_key
    unique (project_id, provider, environment);
