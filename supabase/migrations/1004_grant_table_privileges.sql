-- =====================================================================
-- 1004_grant_table_privileges.sql
--
-- Fixes a critical gap from the initial reset: when the previous prod
-- schema was dropped (`drop schema public cascade; create schema
-- public; ...`), only USAGE and CREATE were granted on the schema to
-- `authenticated` / `anon` / `service_role`. Table-level privileges
-- were never re-issued, so subsequent migrations created tables that
-- the Supabase REST/PostgREST roles cannot touch — every API insert
-- bounces with `42501 permission denied for table <name>` BEFORE the
-- RLS policy ever gets a chance to evaluate (RLS is row-level, the
-- grant gate is table-level and orthogonal).
--
-- Detected by the nightly e2e (run 26276984870) on POST
-- /api/crm/v1/me/crypto-key. The unit suite missed it because it
-- mocks the Supabase client.
--
-- Fix:
--   1. Grant the standard Supabase privilege bundle on every existing
--      public table.
--   2. Set ALTER DEFAULT PRIVILEGES so future migrations don't have to
--      remember to add grants — new tables in `public` automatically
--      get the right table-level access. RLS keeps row-level safety.
--
-- Reference: https://supabase.com/docs/guides/database/postgres/roles
-- =====================================================================

-- 1. Catch up on existing tables.
grant select, insert, update, delete on all tables    in schema public to authenticated;
grant select                                          on all tables    in schema public to anon;
grant all                                              on all tables    in schema public to service_role;

grant usage, select                                    on all sequences in schema public to authenticated, anon, service_role;

-- 2. Default for future tables created by `postgres` (the role
--    migrations run as on Supabase Cloud).
alter default privileges in schema public for role postgres
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public for role postgres
  grant select                          on tables to anon;
alter default privileges in schema public for role postgres
  grant all                              on tables to service_role;
alter default privileges in schema public for role postgres
  grant usage, select                    on sequences to authenticated, anon, service_role;
