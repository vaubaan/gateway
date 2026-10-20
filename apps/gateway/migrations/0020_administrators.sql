-- Migration 0020 — the administrators live in the instance (spec §0 "Administrator",
-- §4.2 Users, §4.3; ADR administrators-live-in-the-instance).
--
-- Until now the administrators were whoever matched the admin rule of the
-- configuration, recomputed on every request. From this version the store keeps
-- them, one designation per row:
--
--   kind 'user'   one user (`user_id`), administrator until unmade;
--   kind 'email'  an address (lower-cased) for one sign-in provider (`provider`) or
--                 for any (`provider` NULL): pending — the first sign-in it admits
--                 turns it into a 'user' row and deletes it;
--   kind 'group'  a group (`group_name`) of one sign-in provider (`provider`), or of
--                 the only one when `provider` is NULL (a bare `admin.group` carried
--                 over from the configuration): every member that provider claims.
--
-- `granted_by` is a user id, or `bootstrap`, `configuration`, `recovery`;
-- `origin` says why the row exists. Nothing here is a secret.
--
-- The configuration's rule is applied once, by the boot, while this table is empty
-- (`administrators.seeded_rule` in `instance_config` records what was applied).
--
-- Portable SQL: one table, three partial unique indexes.

CREATE TABLE administrators (
  id          TEXT NOT NULL PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('user', 'email', 'group')),
  user_id     TEXT REFERENCES users (id) ON DELETE CASCADE,
  email       TEXT,
  provider    TEXT,
  group_name  TEXT,
  granted_by  TEXT NOT NULL,
  origin      TEXT NOT NULL CHECK (origin IN ('setup', 'granted', 'configuration', 'recovered')),
  created_at  TEXT NOT NULL,
  CHECK (
    (kind = 'user'  AND user_id IS NOT NULL AND email IS NULL AND provider IS NULL AND group_name IS NULL) OR
    (kind = 'email' AND user_id IS NULL AND email IS NOT NULL AND group_name IS NULL) OR
    (kind = 'group' AND user_id IS NULL AND email IS NULL AND group_name IS NOT NULL)
  )
) STRICT; -- sqlite: STRICT

CREATE UNIQUE INDEX administrators_user ON administrators (user_id) WHERE kind = 'user';
CREATE UNIQUE INDEX administrators_email ON administrators (email, COALESCE(provider, '')) WHERE kind = 'email';
CREATE UNIQUE INDEX administrators_group ON administrators (group_name, COALESCE(provider, '')) WHERE kind = 'group';
