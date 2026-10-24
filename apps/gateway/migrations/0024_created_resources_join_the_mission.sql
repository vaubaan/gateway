-- Migration 0024 — what a mission creates, it reaches (spec §3.1 "Resource selection";
-- ADR created-resources-join-the-mission).
--
--   mission_resources.source         where a selected resource came from:
--                                      issuance  stored when the mission was issued
--                                                (every row before this migration)
--                                      created   created by the mission itself, through a
--                                                tool its plugin declares as creating one,
--                                                and added right after that call
--                                      edit      added by the creator after issuance
--                                                ("Edit mission")
--   connection_resources.first_seen_at
--                                    when the row was first seen — inserted, or seen
--                                    again after it was stale. A discovery that does not
--                                    return a row first seen less than 15 minutes ago
--                                    does not mark it stale (a provider that lists a
--                                    resource a while after creating it). Backfilled with
--                                    `discovered_at`: every existing row is past the grace.
--
-- Portable SQL: two `ADD COLUMN`, one `UPDATE`. `STRICT` tables accept a CHECK on an added
-- column with a default.

ALTER TABLE mission_resources ADD COLUMN source TEXT NOT NULL DEFAULT 'issuance'
  CHECK (source IN ('issuance', 'created', 'edit'));

ALTER TABLE connection_resources ADD COLUMN first_seen_at TEXT;
UPDATE connection_resources SET first_seen_at = discovered_at;
