-- Migration 0008 — the agent label of a call event is a column (spec §7.9 "the session
-- and the audit tell who did what"; Phase 2 cycle-end finding).
--
-- The label a call carried lived in `events.details_json` only, so the session page's
-- "timeline of one label" read the timeline in batches and parsed every event. It is
-- now a column the timeline filters on, as `audit.agent_label` already is.
--
--   events.agent_label   the label of a `call-allowed` / `call-refused` event; NULL for
--                        a call without a label and for every other kind of event
--
-- `details_json.agent_label` stays as written: it is part of the stored details of a
-- call event (`CallEventDetails`, `@vaubaan/shared`). The column is a copy made by the
-- sessions repository at insert, with the rule of the backfill below: a non-empty JSON
-- string, on a call event; anything else is no label.
--
-- Portable SQL but the backfill, which reads JSON text. SQLite: `json_valid`,
-- `json_type`, `json_extract` (built in from 3.38 and compiled into the bundled driver
-- before that). A Postgres port writes the same statement as
--
--   UPDATE events SET agent_label = NULLIF(details_json::jsonb ->> 'agent_label', '')
--   WHERE kind IN ('call-allowed', 'call-refused') AND details_json IS NOT NULL
--     AND jsonb_typeof(details_json::jsonb -> 'agent_label') = 'string';
--
-- (stored details are always written by `JSON.stringify`, so the cast cannot fail
-- there; SQLite checks `json_valid` because a row may have been edited by hand).

ALTER TABLE events ADD COLUMN agent_label TEXT;

UPDATE events
SET agent_label = NULLIF(json_extract(details_json, '$.agent_label'), '') -- sqlite: json_extract
WHERE kind IN ('call-allowed', 'call-refused')
  AND details_json IS NOT NULL
  AND json_valid(details_json) -- sqlite: json_valid
  AND json_type(details_json, '$.agent_label') = 'text'; -- sqlite: json_type

-- One label of one session, newest first: the keyset of the timeline.
CREATE INDEX events_session_label_ts ON events (session_id, agent_label, ts, id);
