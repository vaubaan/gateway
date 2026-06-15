-- =============================================================================
-- 0030_v4_approval_requests_risks.sql
--
-- Phase 3 of the v4 risk-based pivot — `approval_requests.requested_capabilities`
-- (migration 0013) is renamed to `requested_risks` and reshaped from
-- Capability[] to RiskId[].
--
-- The shape change is needed because the new mint endpoint receives
-- `accepted_risks: RiskId[]` (cf. spec v4 §5). The approval record reflects
-- exactly what's being requested.
--
-- The `context jsonb` field gains a few canonical sub-keys for the v4 mint
-- payload :
--   - context.task                  : free-text description from the requester.
--   - context.agent_id              : the agent emitting the mint.
--   - context.requester_user_id     : the human / system identity backing
--                                     the management key (when known).
--   - context.story_dev_recommendation : optional manager note (cf. scenarios
--                                        in spec v4 annex B §4).
--   - context.parent_token_id        : when re-minting in continuation of an
--                                      existing session (cf. annex B §3).
-- The sub-keys are conventional — the column stays free jsonb.
--
-- Backward compatibility : `requested_capabilities` is kept for one release
-- to enable dual-mode reads ; dropped in a later migration after all in-flight
-- approvals have decayed past their 15-min TTL.
-- =============================================================================

alter table approval_requests
  add column requested_risks jsonb;

-- Validate the array shape with the same regex used by access_tokens.
alter table approval_requests
  add constraint approval_requests_requested_risks_valid
    check (
      requested_risks is null
      or valid_risk_id_array(requested_risks)
    );

-- Index for "show me all pending approvals that need risk X" UX queries.
create index approval_requests_requested_risks_idx
  on approval_requests using gin (requested_risks);
