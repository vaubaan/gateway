-- Migration 0029 — a mission connection is partitioned into resource sets, each with its
-- own policy and budget (risk model §4.7; ADR resource-sets-partition-a-mission-connection).
--
--   mission_resource_sets   one row per set of a connection of a mission: its id, its
--                           place among the sets of that connection (`position`, from 1),
--                           its resource scope (`all` / `selected` / `connection`, at most
--                           one `connection` set per connection: the partial unique index)
--                           and the trust levels it was composed from (display only, as
--                           `mission_connections.trust_levels_json` was).
--   mission_connections     keeps only (mission, connection): the scope and the trust
--                           levels moved to the sets.
--   mission_resources       each selected resource names its set (`resource_set_id`): a
--                           resource is in exactly one set of its connection (the primary
--                           key is still (mission, resource)).
--   mission_policy          keyed (set, risk): the same risk may be accepted in two sets of
--                           one connection with different limits and gates.
--   session_counters        keyed (session, set, risk, period): each set keeps its budget.
--   events                  `resource_set_id`: the set an event about one risk is about
--                           (gate opened or changed, limits, a claim answered…).
--   request_lines           the (set, risk) lines a request is about: a claim, its one
--                           line; an approval request, the gated line of each set the call
--                           was judged against; a permission request, the missing ones.
--   permission_refusal_lines  the (set, risk) lines a permission refusal found missing.
--   mission_trust_marks     per macro-action of a set, when its trust level changed and
--                           when a raise was last put off ("Not now").
--   audit_resource_sets     the sets a call entry was judged against and charged (rows, so
--                           the counters-vs-audit check is a join); append-only like
--                           `audit_risks`.
--
-- Existing missions get exactly one set per connection (`position` 1), whose id is
-- `<mission id>:<connection id>`, holding the connection's scope, resources and trust
-- levels; every policy line, counter, event, request and call entry is attributed to the
-- set of the connection of its provider (the first segment of the risk id, before `.`
-- or `[`). A mission with one set per connection behaves exactly as before. A counter or
-- a policy line of a provider the mission holds no connection for is dropped: no call
-- could reach it (the resource stage finds the connection by provider).
--
-- Tables are rebuilt as in 0018: children copied and dropped first, foreign-key
-- enforcement stays on. Portable SQL: temporary tables, CREATE/DROP, INSERT … SELECT,
-- correlated subqueries, `substr`/`length`/`||`, a partial unique index. `STRICT` and
-- `RAISE` are SQLite's.

CREATE TEMP TABLE saved_mission_connections AS SELECT * FROM mission_connections;
CREATE TEMP TABLE saved_mission_resources AS SELECT * FROM mission_resources;
CREATE TEMP TABLE saved_mission_policy AS SELECT * FROM mission_policy;
CREATE TEMP TABLE saved_session_counters AS SELECT * FROM session_counters;
DROP TABLE mission_resources;
DROP TABLE mission_policy;
DROP TABLE mission_connections;
DROP TABLE session_counters;

CREATE TABLE mission_connections (
  mission_id     TEXT NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
  connection_id  TEXT NOT NULL REFERENCES connections (id),
  PRIMARY KEY (mission_id, connection_id)
) STRICT; -- sqlite: STRICT

CREATE INDEX mission_connections_connection ON mission_connections (connection_id);

CREATE TABLE mission_resource_sets (
  id                 TEXT    NOT NULL PRIMARY KEY,
  mission_id         TEXT    NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
  connection_id      TEXT    NOT NULL,
  position           INTEGER NOT NULL CHECK (position >= 1),
  resource_scope     TEXT    NOT NULL CHECK (resource_scope IN ('all', 'selected', 'connection')),
  trust_levels_json  TEXT,
  FOREIGN KEY (mission_id, connection_id) REFERENCES mission_connections (mission_id, connection_id) ON DELETE CASCADE
) STRICT; -- sqlite: STRICT

CREATE INDEX mission_resource_sets_connection ON mission_resource_sets (mission_id, connection_id, position);
-- At most one set per connection reaches the whole connection (resources found later join it).
CREATE UNIQUE INDEX mission_resource_sets_one_whole ON mission_resource_sets (mission_id, connection_id)
  WHERE resource_scope = 'connection';

CREATE TABLE mission_resources (
  mission_id       TEXT NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
  connection_id    TEXT NOT NULL,
  resource_id      TEXT NOT NULL REFERENCES connection_resources (id) ON DELETE CASCADE,
  resource_set_id  TEXT NOT NULL REFERENCES mission_resource_sets (id) ON DELETE CASCADE,
  source           TEXT NOT NULL DEFAULT 'issuance' CHECK (source IN ('issuance', 'created', 'edit')),
  PRIMARY KEY (mission_id, resource_id),
  FOREIGN KEY (mission_id, connection_id) REFERENCES mission_connections (mission_id, connection_id) ON DELETE CASCADE
) STRICT; -- sqlite: STRICT

CREATE INDEX mission_resources_set ON mission_resources (resource_set_id);

-- Policy = (set, RiskId) -> (quota, rate limit, gate). One row per accepted risk of a set.
CREATE TABLE mission_policy (
  mission_id           TEXT    NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
  resource_set_id      TEXT    NOT NULL REFERENCES mission_resource_sets (id) ON DELETE CASCADE,
  risk_id              TEXT    NOT NULL CHECK (risk_id <> '' AND risk_id NOT LIKE '%*%'),
  quota                INTEGER NOT NULL CHECK (quota >= 0),
  rate_limit           INTEGER NOT NULL CHECK (rate_limit >= 0),
  rate_window_seconds  INTEGER NOT NULL CHECK (rate_window_seconds > 0),
  gate                 TEXT    NOT NULL CHECK (gate IN ('auto', 'approval')),
  PRIMARY KEY (resource_set_id, risk_id)
) STRICT; -- sqlite: STRICT

CREATE INDEX mission_policy_mission ON mission_policy (mission_id);

-- Durable quota counters, per set: a set removed by an edit leaves its rows to the
-- retention sweep (no foreign key to the set on purpose).
CREATE TABLE session_counters (
  session_id       TEXT    NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  resource_set_id  TEXT    NOT NULL,
  risk_id          TEXT    NOT NULL,
  period_start     TEXT    NOT NULL,
  consumed         INTEGER NOT NULL DEFAULT 0 CHECK (consumed >= 0),
  PRIMARY KEY (session_id, resource_set_id, risk_id, period_start)
) STRICT; -- sqlite: STRICT

INSERT INTO mission_connections (mission_id, connection_id)
  SELECT mission_id, connection_id FROM saved_mission_connections;

INSERT INTO mission_resource_sets (id, mission_id, connection_id, position, resource_scope, trust_levels_json)
  SELECT mission_id || ':' || connection_id, mission_id, connection_id, 1, resource_scope, trust_levels_json
  FROM saved_mission_connections;

INSERT INTO mission_resources (mission_id, connection_id, resource_id, resource_set_id, source)
  SELECT mission_id, connection_id, resource_id, mission_id || ':' || connection_id, source
  FROM saved_mission_resources;

INSERT INTO mission_policy (mission_id, resource_set_id, risk_id, quota, rate_limit, rate_window_seconds, gate)
  SELECT p.mission_id, s.id, p.risk_id, p.quota, p.rate_limit, p.rate_window_seconds, p.gate
  FROM saved_mission_policy p
    JOIN mission_resource_sets s ON s.mission_id = p.mission_id
    JOIN connections c ON c.id = s.connection_id
  WHERE substr(p.risk_id, 1, length(c.provider) + 1) IN (c.provider || '.', c.provider || '[');

INSERT INTO session_counters (session_id, resource_set_id, risk_id, period_start, consumed)
  SELECT sc.session_id, s.id, sc.risk_id, sc.period_start, sc.consumed
  FROM saved_session_counters sc
    JOIN sessions se ON se.id = sc.session_id
    JOIN mission_resource_sets s ON s.mission_id = se.mission_id
    JOIN connections c ON c.id = s.connection_id
  WHERE substr(sc.risk_id, 1, length(c.provider) + 1) IN (c.provider || '.', c.provider || '[');

DROP TABLE saved_session_counters;
DROP TABLE saved_mission_policy;
DROP TABLE saved_mission_resources;
DROP TABLE saved_mission_connections;

-- Events about one risk name their set.
ALTER TABLE events ADD COLUMN resource_set_id TEXT;

UPDATE events SET resource_set_id = (
  SELECT s.id FROM sessions se
    JOIN mission_resource_sets s ON s.mission_id = se.mission_id
    JOIN connections c ON c.id = s.connection_id
  WHERE se.id = events.session_id
    AND substr(events.risk_id, 1, length(c.provider) + 1) IN (c.provider || '.', c.provider || '[')
  ORDER BY s.id LIMIT 1
)
WHERE risk_id IS NOT NULL;

-- The (set, risk) lines a request is about, one row each. No foreign key: a request is
-- never deleted, and 0016-style rebuilds of `requests` must not take its lines along.
CREATE TABLE request_lines (
  request_id       TEXT NOT NULL,
  resource_set_id  TEXT NOT NULL,
  risk_id          TEXT NOT NULL,
  PRIMARY KEY (request_id, resource_set_id, risk_id)
) STRICT; -- sqlite: STRICT

CREATE INDEX request_lines_set ON request_lines (resource_set_id, risk_id);

-- An existing request is about its risk in the one set of its mission's connection of
-- that provider; the other risks an approval request lists are read in the same set.
INSERT INTO request_lines (request_id, resource_set_id, risk_id)
  SELECT r.id, s.id, r.risk_id
  FROM requests r
    JOIN mission_resource_sets s ON s.mission_id = r.mission_id
    JOIN connections c ON c.id = s.connection_id
  WHERE substr(r.risk_id, 1, length(c.provider) + 1) IN (c.provider || '.', c.provider || '[');

-- The (set, risk) lines a permission refusal found missing, one row each. No foreign
-- key: a refusal is a short-lived reference, and its lines go with it in the sweep.
CREATE TABLE permission_refusal_lines (
  refusal_id       TEXT NOT NULL,
  resource_set_id  TEXT NOT NULL,
  risk_id          TEXT NOT NULL,
  PRIMARY KEY (refusal_id, resource_set_id, risk_id)
) STRICT; -- sqlite: STRICT

-- The sets a call entry was judged against and charged.
CREATE TABLE audit_resource_sets (
  audit_id         TEXT NOT NULL REFERENCES audit (id),
  resource_set_id  TEXT NOT NULL,
  PRIMARY KEY (audit_id, resource_set_id)
) STRICT; -- sqlite: STRICT

CREATE INDEX audit_resource_sets_set ON audit_resource_sets (resource_set_id);

INSERT INTO audit_resource_sets (audit_id, resource_set_id)
  SELECT a.id, s.id
  FROM audit a
    JOIN mission_resource_sets s ON s.mission_id = a.mission_id AND s.connection_id = a.connection_id
  WHERE a.kind = 'call';

CREATE TRIGGER audit_resource_sets_no_update
BEFORE UPDATE ON audit_resource_sets
BEGIN
  SELECT RAISE(ABORT, 'audit is append-only'); -- sqlite: RAISE syntax
END;

CREATE TRIGGER audit_resource_sets_no_delete
BEFORE DELETE ON audit_resource_sets
WHEN NOT EXISTS (
  SELECT 1 FROM audit_purge_guard g JOIN audit a ON a.id = OLD.audit_id WHERE a.ts < g.cutoff
)
BEGIN
  SELECT RAISE(ABORT, 'audit is append-only; use the retention purge'); -- sqlite: RAISE syntax
END;

-- Trust-raise proposals (risk model §4.7), per macro-action of a set: when its trust
-- level last changed by an edit, and when the creator last answered "Not now". The
-- approvals granted on that macro-action are counted from the latest of these, of the
-- mission's issuance and of the last approval refused on it. No row: neither happened.
CREATE TABLE mission_trust_marks (
  mission_id        TEXT NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
  resource_set_id   TEXT NOT NULL REFERENCES mission_resource_sets (id) ON DELETE CASCADE,
  macro_action_id   TEXT NOT NULL CHECK (macro_action_id <> ''),
  level_changed_at  TEXT,
  snoozed_at        TEXT,
  PRIMARY KEY (resource_set_id, macro_action_id)
) STRICT; -- sqlite: STRICT

CREATE INDEX mission_trust_marks_mission ON mission_trust_marks (mission_id);
