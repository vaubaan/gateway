-- Migration 0030 — the devices a person receives notifications on (spec §4.2 bis; ADR
-- notifications-reach-the-persons-own-channels).
--
--   notification_devices   one row per push subscription a person made on one of their
--                          devices (the interface installed from the browser): its label,
--                          the subscription sealed (`subscription_blob`: the JSON of the
--                          push service's endpoint and the browser's keys `p256dh` and
--                          `auth`; the row id `notification-device:<id>` is the associated
--                          data; `key_version` as in every sealed table, `SEALED_COLUMNS`),
--                          when it was added and last delivered to, the last failure, and
--                          whether it was dropped and why (`gone`: the push service said
--                          the subscription no longer exists).
--
-- `endpoint_digest` is the SHA-256 of the endpoint, never the endpoint: one subscription is
-- one row, whoever made it last on that browser (a person subscribing on a shared browser
-- takes the device over). The endpoint itself is a capability URL and is read only from the
-- sealed blob, by the notifier.
--
-- Portable SQL: one table, two indexes.

CREATE TABLE notification_devices (
  id                   TEXT NOT NULL PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  label                TEXT NOT NULL,
  endpoint_digest      TEXT NOT NULL,
  subscription_blob    BLOB NOT NULL,
  key_version          INTEGER NOT NULL,
  created_at           TEXT NOT NULL,
  last_delivered_at    TEXT,
  last_failure_at      TEXT,
  last_failure_status  INTEGER,
  dropped_at           TEXT,
  dropped_reason       TEXT CHECK (dropped_reason IN ('gone')),
  CHECK ((dropped_at IS NULL) = (dropped_reason IS NULL))
) STRICT; -- sqlite: STRICT

CREATE UNIQUE INDEX notification_devices_endpoint ON notification_devices (endpoint_digest);
CREATE INDEX notification_devices_user ON notification_devices (user_id);
