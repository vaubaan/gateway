-- Migration 0022 — the accepted-risk snapshot of a call entry is stored once per
-- distinct set (spec §8, gateway-risk-model §12; ADR audit-risk-snapshot-stored-once).
--
-- Until now every call entry wrote one `audit_risks` row per risk of the mission's
-- accepted snapshot, touched or not: about 100 rows (12 KB) per call for a mission
-- holding everything. From this migration on:
--
--   audit_risk_sets         one row per distinct accepted set; `id` is the SHA-256 (hex)
--                           of the set's sorted risk ids joined by a line feed, so the
--                           same set is written once whatever the mission or the call
--                           (insert, ignored on conflict); `risk_count` the number of
--                           its members.
--   audit_risk_set_members  the set's risk ids, one row each ("enumerations are rows").
--   audit.accepted_set_id   the set of a call entry written from this migration on;
--                           NULL on every entry written before it (and on
--                           administrative entries).
--   audit_risks             keeps only the risks the call touched (a refused call's
--                           refused risk is one of them), with `accepted`, `touched`
--                           and the remaining budget after the call.
--
-- Existing rows are not rewritten (the audit is immutable): an entry with no set id
-- still reads its snapshot from its own `audit_risks` rows, and ages out with the
-- retention. The sets follow the audit's immutability: no update; a delete only inside
-- the retention purge window and only for a set no remaining entry references.
--
-- Portable SQL: two tables, one column, one index, triggers. `STRICT` and `RAISE` are
-- SQLite's.

CREATE TABLE audit_risk_sets (
  id          TEXT    NOT NULL PRIMARY KEY,
  risk_count  INTEGER NOT NULL CHECK (risk_count >= 0)
) STRICT; -- sqlite: STRICT

CREATE TABLE audit_risk_set_members (
  set_id   TEXT NOT NULL REFERENCES audit_risk_sets (id),
  risk_id  TEXT NOT NULL CHECK (risk_id <> '' AND risk_id NOT LIKE '%*%'),
  PRIMARY KEY (set_id, risk_id)
) STRICT; -- sqlite: STRICT

ALTER TABLE audit ADD COLUMN accepted_set_id TEXT REFERENCES audit_risk_sets (id);

CREATE INDEX audit_accepted_set ON audit (accepted_set_id) WHERE accepted_set_id IS NOT NULL;

CREATE TRIGGER audit_risk_sets_no_update
BEFORE UPDATE ON audit_risk_sets
BEGIN
  SELECT RAISE(ABORT, 'audit is append-only'); -- sqlite: RAISE syntax
END;

CREATE TRIGGER audit_risk_sets_no_delete
BEFORE DELETE ON audit_risk_sets
WHEN NOT EXISTS (SELECT 1 FROM audit_purge_guard)
  OR EXISTS (SELECT 1 FROM audit WHERE accepted_set_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'audit is append-only; use the retention purge'); -- sqlite: RAISE syntax
END;

CREATE TRIGGER audit_risk_set_members_no_update
BEFORE UPDATE ON audit_risk_set_members
BEGIN
  SELECT RAISE(ABORT, 'audit is append-only'); -- sqlite: RAISE syntax
END;

CREATE TRIGGER audit_risk_set_members_no_delete
BEFORE DELETE ON audit_risk_set_members
WHEN NOT EXISTS (SELECT 1 FROM audit_purge_guard)
  OR EXISTS (SELECT 1 FROM audit WHERE accepted_set_id = OLD.set_id)
BEGIN
  SELECT RAISE(ABORT, 'audit is append-only; use the retention purge'); -- sqlite: RAISE syntax
END;
