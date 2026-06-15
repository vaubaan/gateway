-- =============================================================================
-- 0027_v4_drop_policy_rules.sql
--
-- Phase 3 of the v4 risk-based pivot — drops the legacy `policy_rules` table
-- (migration 0016). The new override mechanism lives in
-- `project_risk_policies` (migration 0026).
--
-- Pre-requisite : the gateway must be running on the v4 risk-based runtime
-- BEFORE this migration is applied. Otherwise the v1 code-path that reads
-- `policy_rules` will start throwing.
--
-- No data migration : the `policy_rules` content can NOT be mapped 1:1 to
-- `project_risk_policies` because the v1 (provider, plane, level, action,
-- env_pattern) shape does not align with the v4 (risk_id, env_scope) shape.
-- Operators re-build their overrides on the new UI (cf. spec v4 §6.2 —
-- the default seed is "no override, inherit catalog defaults").
-- =============================================================================

drop trigger if exists projects_seed_policy_rules on projects;
drop function if exists seed_default_policy_rules();
drop table if exists policy_rules cascade;
