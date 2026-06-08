-- =============================================================================
-- 0014_single_use_tokens.sql
--
-- Adds single-use semantics to access tokens (spec §8). A `single_use` token
-- carries a single grant + a short TTL ; the gateway consumes it on the first
-- /mcp call that matches a capability (status → 'revoked', consumed_at = now())
-- and atomically rejects every subsequent call. Combined with the human-gate
-- at mint (Phase 4), this gives per-act granularity without making the /mcp
-- hot path stateful.
--
-- Approval-request side : the original mint request carries the singleUse
-- flag, which must survive the approval pause until the operator clicks ✅
-- and we mint the token with the right single_use value.
-- =============================================================================

alter table access_tokens
  add column single_use boolean not null default false,
  add column consumed_at timestamptz;

create index access_tokens_single_use_unconsumed_idx
  on access_tokens (id)
  where single_use = true and consumed_at is null;

alter table approval_requests
  add column requested_single_use boolean not null default false;
