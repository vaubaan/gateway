-- Migration 0019 — local accounts (spec §0 "Local account", §4.2 People, §6; ADR
-- local-accounts-sign-in-provider).
--
-- A sign-in provider of kind `local` keeps its accounts here: an e-mail and a
-- password, a second factor, recovery codes, and the single-use links through
-- which an account is created or its password reset. The person behind an
-- account is a row of `users` as for every provider — (issuer, subject) with the
-- issuer `urn:vaubaan:local:<provider>` and the subject the account id —, created
-- at the account's first sign-in by the same path as an OpenID Connect sign-in.
--
--   local_accounts   one row per account: the provider it belongs to, the address
--                    (lower-cased, unique per provider), the state of the second
--                    factor (confirmed when, the last time step accepted so that a
--                    code is never accepted twice), and the lockout counters: wrong
--                    passwords since `first_failure_at`, and `locked_until` once there
--                    were too many. Counted here rather than in memory so that a
--                    restart does not reset them.
--   local_secrets    the sealed blobs of an account, one row per secret (`kind`):
--                    the password hash (argon2id), the TOTP seed, the hashes of the
--                    unused recovery codes. The row id is `<account id>:<kind>` and is
--                    the associated data of its blob; `key_version` is the master
--                    key version the blob was sealed under, as in every sealed table
--                    (`SEALED_COLUMNS`), so that a rotation reseals these too.
--   local_links      the single-use links: an invitation to create an account, or
--                    a password reset. The store keeps the SHA-256 of the random
--                    token only, its expiry and its use; `created_by` is a user id,
--                    `bootstrap`, or `self` for a reset the person asked for.
--
-- Portable SQL: three tables, two indexes.

CREATE TABLE local_accounts (
  id                  TEXT NOT NULL PRIMARY KEY,
  provider            TEXT NOT NULL,                 -- the sign-in provider id
  email               TEXT NOT NULL,                 -- lower-cased
  totp_confirmed_at   TEXT,                          -- NULL: no second factor
  totp_last_step      INTEGER,                       -- the last time step a code was accepted for
  failed_attempts     INTEGER NOT NULL DEFAULT 0,
  first_failure_at    TEXT,
  locked_until        TEXT,
  password_changed_at TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
) STRICT; -- sqlite: STRICT

CREATE UNIQUE INDEX local_accounts_provider_email ON local_accounts (provider, email);

CREATE TABLE local_secrets (
  id          TEXT NOT NULL PRIMARY KEY,             -- '<account id>:<kind>'
  account_id  TEXT NOT NULL REFERENCES local_accounts (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('password', 'totp', 'recovery')),
  blob        BLOB NOT NULL,
  key_version INTEGER NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT; -- sqlite: STRICT

CREATE INDEX local_secrets_account ON local_secrets (account_id);

CREATE TABLE local_links (
  id           TEXT NOT NULL PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('invite', 'reset')),
  provider     TEXT NOT NULL,
  email        TEXT NOT NULL,                        -- lower-cased
  token_sha256 TEXT NOT NULL UNIQUE,
  created_by   TEXT NOT NULL,                        -- users.id, 'bootstrap' or 'self'
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  used_at      TEXT
) STRICT; -- sqlite: STRICT
