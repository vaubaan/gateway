-- Migration 0021 — a second factor per person, whatever their sign-in provider (spec §6;
-- ADR administrators-live-in-the-instance, §7).
--
-- The second factor of the local accounts (migration 0019) moves to the user: every
-- person enrols the instance's TOTP at their first sign-in, through any provider,
-- unless an administrator waived it for that provider (never for an administrator).
--
--   user_second_factors         one row per user who has a factor: when it was
--                               confirmed, and the last time step accepted (a code is
--                               never accepted twice).
--   user_second_factor_secrets  the sealed blobs, one per (user, kind): `totp` the
--                               base32 seed, `recovery` the JSON list of the unused
--                               recovery codes' SHA-256. The row id `<user id>:<kind>`
--                               is the associated data of its blob; `key_version` as in
--                               every sealed table (`SEALED_COLUMNS`).
--
-- The factors local accounts already had are moved by the boot (open with their old
-- associated data, seal with the new one), once; `local_accounts.totp_*` and the
-- `totp` / `recovery` rows of `local_secrets` are then unused.
--
-- Portable SQL: two tables, one index.

CREATE TABLE user_second_factors (
  user_id       TEXT NOT NULL PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  confirmed_at  TEXT NOT NULL,
  last_step     INTEGER,
  updated_at    TEXT NOT NULL
) STRICT; -- sqlite: STRICT

CREATE TABLE user_second_factor_secrets (
  id          TEXT NOT NULL PRIMARY KEY,             -- '<user id>:<kind>'
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('totp', 'recovery')),
  blob        BLOB NOT NULL,
  key_version INTEGER NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT; -- sqlite: STRICT

CREATE INDEX user_second_factor_secrets_user ON user_second_factor_secrets (user_id);
