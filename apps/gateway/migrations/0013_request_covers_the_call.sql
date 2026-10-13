-- Migration 0013 — one approval request covers the call (spec §3.5; ADR
-- one-approval-request-covers-the-call).
--
-- An approval request, and the approval a grant produces, named ONE risk. A call that
-- touches two risks gated `approval` therefore took two requests, two decisions and two
-- replays. A request now lists every gated risk of the call it was dropped for, and the
-- approval it produces covers them all: the creator answers once.
--
--   requests.risk_ids_json    JSON array of risk ids. Approval requests: every gated risk
--                             of the call, `risk_id` being the first of them. NULL for a
--                             claim, which is about one risk (`risk_id`).
--   approvals.risk_ids_json   JSON array of risk ids: every risk the approval covers.
--
-- Rows that exist keep the meaning they had: each named one risk and now lists that one
-- risk. An approval request that is open while this migration runs is still granted for
-- the risk it named, and an approval not consumed yet is still consumed by the identical
-- call. Nothing is widened: a row never comes to cover a risk its author did not see.
-- (A risk id holds letters, digits, `.`, `-`, `[` and `]`: no character JSON escapes.)
--
-- An approval is now looked up by the call — mission, tool, fingerprint — and then by the
-- risks it lists, so the index follows.
--
-- Portable SQL: two nullable `ADD COLUMN`, two backfills by concatenation, an index
-- dropped and recreated.

ALTER TABLE requests ADD COLUMN risk_ids_json TEXT;
ALTER TABLE approvals ADD COLUMN risk_ids_json TEXT;

UPDATE requests SET risk_ids_json = '["' || risk_id || '"]' WHERE kind = 'approval';
UPDATE approvals SET risk_ids_json = '["' || risk_id || '"]';

DROP INDEX approvals_lookup;
CREATE INDEX approvals_lookup ON approvals (mission_id, tool, fingerprint)
  WHERE consumed_at IS NULL;
