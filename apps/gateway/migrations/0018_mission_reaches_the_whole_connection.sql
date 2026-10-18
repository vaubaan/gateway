-- Migration 0018 — a mission may reach the whole connection (spec §3.1 "Resource
-- selection"; ADR mission-reaches-the-whole-connection-on-request).
--
-- `mission_connections.resource_scope` gains a third value:
--
--   selected    the explicit ids stored at issuance (unchanged)
--   all         no id: nothing was known at issuance; the mission reaches none (unchanged)
--   connection  no id: the whole connection — every resource discovery returns at the
--               time of the call, discovered later included, except the hidden ones and
--               the instance's own. Resolved at read time, never stored as a list.
--
-- A CHECK constraint cannot be altered in place, so `mission_connections` is rebuilt,
-- and with it `mission_resources`, whose foreign key names it. Children are copied and
-- dropped first, as in 0016: foreign-key enforcement stays enabled, and dropping the
-- parent while its children exist would cascade. Every row is copied as is: no existing
-- mission changes scope, nothing is widened.
--
-- Portable SQL: temporary tables, CREATE/DROP, INSERT … SELECT. `STRICT` is SQLite's.

CREATE TEMP TABLE saved_mission_connections AS SELECT * FROM mission_connections;
CREATE TEMP TABLE saved_mission_resources AS SELECT * FROM mission_resources;
DROP TABLE mission_resources;
DROP TABLE mission_connections;

CREATE TABLE mission_connections (
  mission_id      TEXT NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
  connection_id   TEXT NOT NULL REFERENCES connections (id),
  resource_scope  TEXT NOT NULL CHECK (resource_scope IN ('all', 'selected', 'connection')),
  PRIMARY KEY (mission_id, connection_id)
) STRICT; -- sqlite: STRICT

CREATE INDEX mission_connections_connection ON mission_connections (connection_id);

-- Resource selection, one row per selected resource (used when resource_scope = 'selected').
CREATE TABLE mission_resources (
  mission_id     TEXT NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
  connection_id  TEXT NOT NULL,
  resource_id    TEXT NOT NULL REFERENCES connection_resources (id) ON DELETE CASCADE,
  PRIMARY KEY (mission_id, resource_id),
  FOREIGN KEY (mission_id, connection_id) REFERENCES mission_connections (mission_id, connection_id) ON DELETE CASCADE
) STRICT; -- sqlite: STRICT

INSERT INTO mission_connections (mission_id, connection_id, resource_scope)
  SELECT mission_id, connection_id, resource_scope FROM saved_mission_connections;
INSERT INTO mission_resources (mission_id, connection_id, resource_id)
  SELECT mission_id, connection_id, resource_id FROM saved_mission_resources;

DROP TABLE saved_mission_resources;
DROP TABLE saved_mission_connections;
