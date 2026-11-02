-- Migration 0031 — the messaging addresses a person receives notifications at (spec §4.2 bis;
-- ADR notifications-reach-the-persons-own-channels).
--
--   notification_addresses   one row per incoming address of a company messaging service a
--                            person pasted (a Slack, Teams, Discord or ntfy webhook, or any
--                            https URL that takes a JSON body): its kind, its label, the URL
--                            sealed (`url_blob`; the row id `notification-address:<id>` is
--                            the associated data; `key_version` as in every sealed table,
--                            `SEALED_COLUMNS`), when it was added and last delivered to, and
--                            the last failure with the service's HTTP status (`NULL`: no
--                            answer, or the destination was refused).
--
-- `url_digest` is the SHA-256 of the person's id and the URL, never the URL: one address is
-- one row per person (the same URL pasted twice is refused). The URL itself is a secret of the
-- person — whoever holds it posts to their channel — and is read only from the sealed blob, by
-- the notifier.
--
-- Portable SQL: one table, two indexes.

CREATE TABLE notification_addresses (
  id                   TEXT NOT NULL PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL CHECK (kind IN ('slack', 'teams', 'discord', 'ntfy', 'generic')),
  label                TEXT NOT NULL,
  url_digest           TEXT NOT NULL,
  url_blob             BLOB NOT NULL,
  key_version          INTEGER NOT NULL,
  created_at           TEXT NOT NULL,
  last_delivered_at    TEXT,
  last_failure_at      TEXT,
  last_failure_status  INTEGER
) STRICT; -- sqlite: STRICT

CREATE UNIQUE INDEX notification_addresses_user_url ON notification_addresses (user_id, url_digest);
CREATE INDEX notification_addresses_user ON notification_addresses (user_id);
