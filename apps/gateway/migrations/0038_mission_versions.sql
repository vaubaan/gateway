-- Migration 0038 — the versions of a mission's configuration (spec §4.2 "History",
-- §8 "Retention").
--
--   mission_versions  one immutable row per change of a mission's configuration, numbered
--                     from 1 per mission: when, who (a person, a mission through its
--                     `vaubaan` account, or the gateway itself), why (`cause`), the version
--                     a rollback restored (`restored_from`), the whole configuration as
--                     JSON (`config_json`: name, end, period, accounts with their resource
--                     sets, policy lines) and what moved from the previous version
--                     (`changes_json`, the shape of a `mission-changed` session event;
--                     NULL for a first version).
--
-- Keys, teammates and counters are not configuration: they are in no version. A version is
-- never updated, and deleted only with its mission (ON DELETE CASCADE): the audit's
-- retention never reaches it. It is in every backup, as every table is.
--
-- Backfill: every mission gets its version 1 now, from its current state, with the cause
-- `before-versions` and the gateway as author: what it was before cannot be rebuilt.
--
-- Portable SQL but the JSON functions of the backfill and `RAISE` (sqlite).

CREATE TABLE mission_versions (
  mission_id        TEXT NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
  number            INTEGER NOT NULL CHECK (number >= 1),
  created_at        TEXT NOT NULL,
  cause             TEXT NOT NULL CHECK (cause IN (
                      'issued', 'before-versions', 'edit', 'permission-request',
                      'resource-created', 'resources-discovered', 'claim-granted', 'rollback')),
  author_kind       TEXT NOT NULL CHECK (author_kind IN ('person', 'mission', 'gateway')),
  -- The person; for a mission author, the person it acted for.
  author_user_id    TEXT,
  -- The mission whose key made the change through the `vaubaan` plugin.
  author_mission_id TEXT,
  restored_from     INTEGER CHECK (restored_from IS NULL OR restored_from >= 1),
  config_json       TEXT NOT NULL CHECK (json_valid(config_json)),
  changes_json      TEXT CHECK (changes_json IS NULL OR json_valid(changes_json)),
  PRIMARY KEY (mission_id, number),
  CHECK (author_kind <> 'person' OR (author_user_id IS NOT NULL AND author_mission_id IS NULL)),
  CHECK (author_kind <> 'mission' OR author_mission_id IS NOT NULL),
  CHECK (author_kind <> 'gateway' OR (author_user_id IS NULL AND author_mission_id IS NULL)),
  CHECK ((cause = 'rollback') = (restored_from IS NOT NULL))
) STRICT; -- sqlite: STRICT

CREATE TRIGGER mission_versions_no_update
BEFORE UPDATE ON mission_versions
BEGIN
  SELECT RAISE(ABORT, 'a mission version is immutable'); -- sqlite: RAISE syntax
END;

-- Deleted only with the mission: while its row exists, a version stays.
CREATE TRIGGER mission_versions_no_delete
BEFORE DELETE ON mission_versions
WHEN EXISTS (SELECT 1 FROM missions WHERE id = OLD.mission_id)
BEGIN
  SELECT RAISE(ABORT, 'a mission version is deleted only with its mission'); -- sqlite: RAISE syntax
END;

INSERT INTO mission_versions
  (mission_id, number, created_at, cause, author_kind, config_json)
SELECT
  m.id, 1, m.updated_at, 'before-versions', 'gateway',
  json_object(
    'name', m.name,
    'expires_at', m.expires_at,
    'period', CASE WHEN m.period_seconds IS NULL
                THEN json_object('kind', 'one-off')
                ELSE json_object('kind', 'recurring', 'length_seconds', m.period_seconds) END,
    'accounts', (
      SELECT json_group_array(json(a.doc)) FROM (
        SELECT json_object(
          'account_id', ma.account_id,
          'resource_sets', (
            SELECT json_group_array(json(s.doc)) FROM (
              SELECT json_object(
                'id', rs.id,
                'position', rs.position,
                'future', json(CASE rs.future WHEN 1 THEN 'true' ELSE 'false' END),
                'env', rs.env,
                'mixed_env', json(CASE rs.mixed_env WHEN 1 THEN 'true' ELSE 'false' END),
                'resource_ids', (
                  SELECT json_group_array(r.resource_id) FROM (
                    SELECT resource_id FROM mission_resources
                    WHERE resource_set_id = rs.id ORDER BY resource_id
                  ) r
                ),
                'trust_levels', json(COALESCE(rs.trust_levels_json, '{}'))
              ) AS doc
              FROM mission_resource_sets rs
              WHERE rs.mission_id = m.id AND rs.account_id = ma.account_id
              ORDER BY rs.position
            ) s
          )
        ) AS doc
        FROM mission_accounts ma WHERE ma.mission_id = m.id ORDER BY ma.account_id
      ) a
    ),
    'policy', (
      SELECT json_group_array(json(p.doc)) FROM (
        SELECT json_object(
          'resource_set_id', mp.resource_set_id,
          'risk_id', mp.risk_id,
          'quota', mp.quota,
          'rate_limit', json_object('max', mp.rate_limit,
                                    'window_seconds', mp.rate_window_seconds),
          'gate', mp.gate
        ) AS doc
        FROM mission_policy mp WHERE mp.mission_id = m.id
        ORDER BY mp.resource_set_id, mp.risk_id
      ) p
    )
  )
FROM missions m;
