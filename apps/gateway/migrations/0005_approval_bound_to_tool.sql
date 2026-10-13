-- Migration 0005 — an approval is bound to the tool as well (spec §3.5; Phase 1 security
-- review, closed by feature P2.1).
--
-- An approval was keyed `(mission, risk, fingerprint)`. Two tools may touch the same
-- risk with byte-identical arguments (a file write and a file delete on the same path,
-- say): the approval the creator granted while reading one tool's name would have been
-- consumed by the other. The key is now `(mission, risk, tool, fingerprint)`.
--
-- No approval could be granted before this migration (the decision arrived with P2.1),
-- so the default only has to be safe: an empty tool name matches no call, and a row
-- written by an older image can never be consumed.
--
-- Portable SQL: `ADD COLUMN` with a constant default, a dropped and recreated index.

ALTER TABLE approvals ADD COLUMN tool TEXT NOT NULL DEFAULT '';

DROP INDEX approvals_lookup;
CREATE INDEX approvals_lookup ON approvals (mission_id, risk_id, tool, fingerprint)
  WHERE consumed_at IS NULL;
