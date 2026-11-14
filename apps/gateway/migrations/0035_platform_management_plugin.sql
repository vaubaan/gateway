-- Migration 0035 — the gateway's own management tools are a plugin on the execution door;
-- the OAuth authorization server and its delegations are retired (spec §4.1 bis, §6; ADR
-- platform-management-is-a-plugin-on-the-execution-door).
--
--   missions.issued_by_mission_id   the mission whose agent issued this one through its
--                                   `vaubaan` account; NULL for a mission a person issued.
--                                   `rotate_mission_token` reaches only the missions the
--                                   calling mission issued.
--   missions.issued_via_client_name history: the name the OAuth client gave itself when it
--                                   issued the mission by delegation, copied here before
--                                   the clients go, so the mission still says who prepared
--                                   it. NULL for every mission issued after this migration.
--
-- Every mission row is kept, and so is its token: a mission issued by a delegation keeps
-- serving its executing agent. Only the delegation behind it ends.
--
-- Dropped: the OAuth clients and their redirect URIs, the authorization codes, the access
-- and refresh tokens. The rows of `delegations` are deleted and the table is kept EMPTY:
-- `missions.delegation_id` still references it, and SQLite can neither drop that column
-- (it is in a foreign key) nor rebuild `missions` inside a migration (the rebuild drops the
-- old table, and with foreign keys on every row of the tables referencing `missions` would
-- be deleted with it). Nothing reads or writes either any more; a Postgres port drops both.
--
-- `audit.delegated_client_id` is kept: the entries written by a delegated client still
-- name it. An act done through the `vaubaan` plugin is an admin entry whose `mission_id`
-- names the mission whose key made the call.
--
-- The `oauth.*` configuration keys are accepted and ignored at boot (one warning): an
-- existing configuration file still boots. Nothing of them is stored.
--
-- Portable SQL: ADD COLUMN, a correlated subquery, DELETE, DROP TABLE.

ALTER TABLE missions ADD COLUMN issued_by_mission_id TEXT REFERENCES missions (id);
ALTER TABLE missions ADD COLUMN issued_via_client_name TEXT;

CREATE INDEX missions_issued_by ON missions (issued_by_mission_id);

UPDATE missions
   SET issued_via_client_name = (
         SELECT c.name
           FROM delegations d JOIN oauth_clients c ON c.id = d.client_id
          WHERE d.id = missions.delegation_id
       )
 WHERE delegation_id IS NOT NULL;

UPDATE missions SET delegation_id = NULL WHERE delegation_id IS NOT NULL;

DROP TABLE oauth_access_tokens;
DROP TABLE oauth_refresh_tokens;
DROP TABLE oauth_codes;
DELETE FROM delegations;
DROP TABLE oauth_client_redirect_uris;
DROP TABLE oauth_clients;
