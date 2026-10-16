-- Migration 0002 — audit_risks delete guard compares against the purge cutoff.
--
-- 0001 let any audit_risks row go while a purge window was open; the audit rows
-- themselves were already compared with the cutoff. The risk rows now follow
-- their parent entry: a row of an entry newer than the cutoff aborts the delete,
-- window or not (spec §6 "immutable audit"; P0 cycle-end finding).
--
-- Applied migrations are immutable, hence a new file instead of an edit of 0001.

DROP TRIGGER audit_risks_no_delete;

CREATE TRIGGER audit_risks_no_delete
BEFORE DELETE ON audit_risks
WHEN NOT EXISTS (
  SELECT 1 FROM audit_purge_guard g JOIN audit a ON a.id = OLD.audit_id WHERE a.ts < g.cutoff
)
BEGIN
  SELECT RAISE(ABORT, 'audit is append-only; use the retention purge'); -- sqlite: RAISE syntax
END;
