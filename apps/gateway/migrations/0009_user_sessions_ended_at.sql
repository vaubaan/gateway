-- Migration 0009 — the operator deactivates a user (spec §2.3 "creator removed from the
-- IdP"; ADR operator-deactivates-a-user).
--
-- `users.status = 'removed'` was honoured everywhere and set by nothing: offboarding
-- depended on the identity provider alone. An operator now deactivates a user from
-- Administration, and reactivates them. One fact is missing from the row for that:
--
--   users.sessions_ended_at   the instant of the user's last deactivation; a web
--                             session created at or before it is nobody, whatever the
--                             status says since. Without it, a session opened before a
--                             deactivation would work again after a reactivation, for
--                             the rest of its eight hours. NULL: never deactivated.
--
-- `removed_at` cannot carry it: it is cleared when the user is active again.
--
-- Portable SQL: one nullable `ADD COLUMN`, no default, no backfill.

ALTER TABLE users ADD COLUMN sessions_ended_at TEXT;
