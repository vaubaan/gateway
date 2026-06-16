-- =============================================================================
-- 0034_audit_log_delegation_chain.sql
--
-- Adds `audit_log.delegation_chain jsonb` (nullable) — snapshot of the token's
-- delegation chain at call time. Pre-migration rows have NULL.
--
-- Spec : ADR unified-tokens-delegation-chain-and-escalation-channel.md §D2.
-- =============================================================================

alter table audit_log
  add column delegation_chain jsonb;

-- GIN index for "show me every call descended from this root" forensics.
create index audit_log_delegation_chain_idx
  on audit_log using gin (delegation_chain);
