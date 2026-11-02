-- Migration 0032 — mail as a notification channel, switched on by the person (spec §4.2 bis:
-- "Mail is a channel when the instance delivers mail (§4.3), switched on by the person").
--
--   notification_mail   one row per person who switched mail notifications on, with when;
--                       no row is off. The address is the person's own (`users.email`), read
--                       when a notification leaves, never copied here.
--
-- A table rather than a column of `users`: the users table is the identity the sign-in
-- writes; a channel the person switches is theirs, and removed with them (cascade).
--
-- Portable SQL: one table.

CREATE TABLE notification_mail (
  user_id         TEXT NOT NULL PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  switched_on_at  TEXT NOT NULL
) STRICT; -- sqlite: STRICT
