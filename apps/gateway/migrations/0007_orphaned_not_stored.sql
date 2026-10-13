-- Migration 0007 — `orphaned` is no longer a stored mission status (spec §2.3; feature
-- P2.2b; ADR orphaned-missions-and-ownerless-connections, amendment of 2026-10-13).
--
-- P2.2 wrote `orphaned` into `missions.status` as a final verdict the first time the
-- creator's authority was found missing. The state is now derived from the creator's
-- current authority on every read: the mission serves calls again when the authority
-- comes back, with its session and counters intact.
--
-- 1. Every stored verdict is reset. The mission reads `orphaned` again at once if its
--    grounds are still missing (a revoked connection, a share never made again), and
--    `active` if they came back in the meantime. `closed_at` was set by that write
--    only (no other transition reaches an `orphaned` row), so it is cleared with it.
--    Tokens were never retired by the orphaning: the same Bearer works again.
-- 2. The value can no longer be written. The CHECK of 0001 still lists it (applied
--    migrations are immutable, and rebuilding the table is not worth it): two triggers
--    refuse it instead.
--
-- Portable SQL but the trigger bodies (a Postgres port writes the same guard as a
-- CHECK constraint or a trigger function).

UPDATE missions SET status = 'active', closed_at = NULL WHERE status = 'orphaned';

CREATE TRIGGER missions_orphaned_not_stored_insert
BEFORE INSERT ON missions
WHEN NEW.status = 'orphaned'
BEGIN
  SELECT RAISE(ABORT, 'orphaned is derived from the creator''s current authority, never stored'); -- sqlite: RAISE syntax
END;

CREATE TRIGGER missions_orphaned_not_stored_update
BEFORE UPDATE OF status ON missions
WHEN NEW.status = 'orphaned'
BEGIN
  SELECT RAISE(ABORT, 'orphaned is derived from the creator''s current authority, never stored'); -- sqlite: RAISE syntax
END;
