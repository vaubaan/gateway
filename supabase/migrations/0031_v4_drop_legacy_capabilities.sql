-- =============================================================================
-- 0031_v4_drop_legacy_capabilities.sql
--
-- Phase 8 (cleanup) of the v4 risk-based pivot — drops the legacy v1
-- `capabilities` column on `access_tokens` and `capability_matched` on
-- `audit_log`. Also drops legacy `requested_capabilities` on `approval_requests`.
--
-- PREREQUISITE — DO NOT apply until :
--   1. The gateway has been running on the v4 runtime (using `accepted_risks`)
--      for at least one full token TTL cycle (24h default).
--   2. All in-flight approval_requests with non-null `requested_capabilities`
--      have decayed (status = 'expired' or 'consumed').
--   3. The legacy code paths in `packages/policy-engine/src/policy.ts` and
--      `packages/shared/src/capability.ts` have been removed from the codebase.
--
-- Audit will be slightly degraded for pre-v4 rows : `slices_executed`,
-- `risks_touched`, `token_accepted_risks_snapshot` will be NULL on rows
-- written before Phase 3. The schema accommodates this (nullable).
-- =============================================================================

-- 1. access_tokens.capabilities
drop index if exists access_tokens_capabilities_gin_idx;
alter table access_tokens
  drop column capabilities;

-- 2. audit_log.capability_matched
alter table audit_log
  drop column capability_matched;

-- 3. approval_requests.requested_capabilities
alter table approval_requests
  drop column requested_capabilities;
