-- =============================================================================
-- 0028_v4_audit_log_v4_columns.sql
--
-- Phase 3 of the v4 risk-based pivot — enriches `audit_log` with the new
-- decision evidence required by Five Eyes (2026-05) + NIST AI RMF Agentic
-- Profile : capture (a) the technical slice(s) the plugin classified, (b) the
-- business risks touched, (c) a snapshot of the token's accepted_risks at
-- decision time (reproducibility).
--
-- Backward compatibility : `capability_matched text` (migration 0015) is
-- KEPT during Phase 2-3 dual-mode. It will be dropped in a later cleanup
-- migration after no more v1 calls flow through.
--
-- Spec : docs/spec/gateway-risk-model.md §12 (audit log).
-- =============================================================================

alter table audit_log
  add column slices_executed jsonb,
  add column risks_touched jsonb,
  add column token_accepted_risks_snapshot jsonb;

-- Indices for forensic queries.
create index audit_log_risks_touched_idx
  on audit_log using gin (risks_touched);
