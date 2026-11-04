-- Migration 0033 — a resource set is one environment, an explicit list, and optionally the
-- resources that appear there later (risk model §4.7; ADR
-- resource-set-is-one-environment-with-optional-future-resources).
--
--   mission_resource_sets.future     1 when resources that later appear on the connection
--                                    with the set's environment are written into its list
--                                    (discovered, or relabelled into it).
--   mission_resource_sets.env        the set's environment: the effective label every
--                                    resource of the set carries (own label, else the
--                                    connection's default); NULL for "no label".
--   mission_resource_sets.mixed_env  1 for a set stored before this rule whose resources
--                                    span several environments (or a whole-connection set
--                                    with no resource yet): `env` is NULL and, with
--                                    `future`, it takes a later resource of any environment,
--                                    as the whole-connection scope did, until the creator's
--                                    next edit (which must split it by environment).
--   mission_resource_sets.resource_scope  dropped, with the partial unique index of 0029:
--                                    what a mission reaches is its stored lists only.
--   mission_resources.source         one more value, `future`: the resource joined a set
--                                    with future on after issuance (rebuilt for the CHECK;
--                                    no table references it).
--
-- A whole-connection set (`connection`) becomes the explicit list of what it reached:
-- every resource of the connection no other set of the mission holds and the owner did
-- not hide (a stale one included: it is reached again if it comes back, as before; the
-- instance's own resources are written too and stay unreached, `isSelf` being read at
-- every reach), with `future` on. An `all` or `selected` set keeps its rows, `future` off.
--
-- Portable SQL: ADD COLUMN, INSERT … SELECT, correlated subqueries, DROP INDEX, DROP
-- COLUMN (SQLite ≥ 3.35; the column's own CHECK goes with it), a table rebuilt as in 0029,
-- a partial index.

CREATE TEMP TABLE saved_mission_resources AS SELECT * FROM mission_resources;
DROP TABLE mission_resources;

CREATE TABLE mission_resources (
  mission_id       TEXT NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
  connection_id    TEXT NOT NULL,
  resource_id      TEXT NOT NULL REFERENCES connection_resources (id) ON DELETE CASCADE,
  resource_set_id  TEXT NOT NULL REFERENCES mission_resource_sets (id) ON DELETE CASCADE,
  source           TEXT NOT NULL DEFAULT 'issuance' CHECK (source IN ('issuance', 'created', 'edit', 'future')),
  PRIMARY KEY (mission_id, resource_id),
  FOREIGN KEY (mission_id, connection_id) REFERENCES mission_connections (mission_id, connection_id) ON DELETE CASCADE
) STRICT; -- sqlite: STRICT

CREATE INDEX mission_resources_set ON mission_resources (resource_set_id);

INSERT INTO mission_resources (mission_id, connection_id, resource_id, resource_set_id, source)
  SELECT mission_id, connection_id, resource_id, resource_set_id, source FROM saved_mission_resources;
DROP TABLE saved_mission_resources;

ALTER TABLE mission_resource_sets ADD COLUMN future INTEGER NOT NULL DEFAULT 0 CHECK (future IN (0, 1));
ALTER TABLE mission_resource_sets ADD COLUMN env TEXT;
ALTER TABLE mission_resource_sets ADD COLUMN mixed_env INTEGER NOT NULL DEFAULT 0 CHECK (mixed_env IN (0, 1));

INSERT INTO mission_resources (mission_id, connection_id, resource_id, resource_set_id, source)
  SELECT s.mission_id, s.connection_id, r.id, s.id, 'issuance'
  FROM mission_resource_sets s
    JOIN connection_resources r ON r.connection_id = s.connection_id
  WHERE s.resource_scope = 'connection'
    AND r.hidden = 0
    AND NOT EXISTS (
      SELECT 1 FROM mission_resources mr WHERE mr.mission_id = s.mission_id AND mr.resource_id = r.id
    );

UPDATE mission_resource_sets SET future = 1 WHERE resource_scope = 'connection';

-- The environment of each set, from its resources' effective labels ('' stands for none
-- while counting).
UPDATE mission_resource_sets SET mixed_env = 1
  WHERE (
    SELECT COUNT(DISTINCT COALESCE(r.env, c.default_env, ''))
    FROM mission_resources mr
      JOIN connection_resources r ON r.id = mr.resource_id
      JOIN connections c ON c.id = r.connection_id
    WHERE mr.resource_set_id = mission_resource_sets.id
  ) > 1
  OR (
    resource_scope = 'connection'
    AND NOT EXISTS (SELECT 1 FROM mission_resources mr WHERE mr.resource_set_id = mission_resource_sets.id)
  );

UPDATE mission_resource_sets SET env = (
    SELECT MIN(COALESCE(r.env, c.default_env))
    FROM mission_resources mr
      JOIN connection_resources r ON r.id = mr.resource_id
      JOIN connections c ON c.id = r.connection_id
    WHERE mr.resource_set_id = mission_resource_sets.id
  )
  WHERE mixed_env = 0;

DROP INDEX mission_resource_sets_one_whole;
ALTER TABLE mission_resource_sets DROP COLUMN resource_scope;

-- Hourly discovery reads the connections a running future set depends on.
CREATE INDEX mission_resource_sets_future ON mission_resource_sets (connection_id) WHERE future = 1;
