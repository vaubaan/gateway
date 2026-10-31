-- Migration 0026 — a lockout on the second factor, as on the password (security
-- audit 2026-10-31, M1; handbook authentication, threat model).
--
-- Whoever holds a person's password reaches the step that asks for the code of the
-- authenticator app. Without a counter, that step could be retried without end. Wrong
-- codes are now counted per person, as `local_accounts` counts wrong passwords
-- (migration 0019), in the store so that a restart does not reset them:
--
--   user_second_factors.failed_attempts    wrong codes since `first_failure_at`
--   user_second_factors.first_failure_at   the first wrong code of the window
--   user_second_factors.locked_until       set once there were too many; no code
--                                          is checked before it has passed
--
-- Portable SQL: three `ADD COLUMN`, the counter defaulting to 0, no backfill.

ALTER TABLE user_second_factors ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_second_factors ADD COLUMN first_failure_at TEXT;
ALTER TABLE user_second_factors ADD COLUMN locked_until TEXT;
