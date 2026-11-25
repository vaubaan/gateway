-- Migration 0043 — the living history of a mission is its mission log, never a session
-- (ADR the-missions-session-becomes-the-mission-log).
--
-- `sessions` and `session_counters` named the mission log beside `web_sessions` (a person's
-- signed-in visit) and the MCP transport's sessions. Every table, column and index is renamed
-- in place: no row moves, no id changes. SQLite's RENAME carries the foreign keys, the
-- triggers and the indexes along; the indexes are recreated only for their names.
--
-- No stored value changes: no event kind, act, refusal code or JSON field carries the word.
-- `web_sessions` and `users.sessions_ended_at` are the web session's and stay.
--
-- Portable SQL.

ALTER TABLE sessions RENAME TO mission_logs;
ALTER TABLE session_counters RENAME TO mission_log_counters;

ALTER TABLE mission_log_counters RENAME COLUMN session_id TO mission_log_id;
ALTER TABLE events               RENAME COLUMN session_id TO mission_log_id;
ALTER TABLE requests             RENAME COLUMN session_id TO mission_log_id;
ALTER TABLE audit                RENAME COLUMN session_id TO mission_log_id;

DROP INDEX events_session_ts;
CREATE INDEX events_mission_log_ts ON events (mission_log_id, ts);
DROP INDEX events_session_label_ts;
CREATE INDEX events_mission_log_label_ts ON events (mission_log_id, agent_label, ts, id);
DROP INDEX events_session_holder_ts;
CREATE INDEX events_mission_log_holder_ts ON events (mission_log_id, token_kind, token_holder, ts, id);
