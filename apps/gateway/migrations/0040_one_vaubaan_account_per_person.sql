-- Migration 0040 — one Vaubaan account per person, held by the store (handbook
-- services/vaubaan.md; ADR platform-management-is-a-plugin-on-the-execution-door).
--
-- A `host` account (the `vaubaan` service: no secret, owned by one person, never shared)
-- was kept one per person by `AccountService.connectHost` alone, a read then an insert:
-- two connects at once could store two. From now on a partial unique index refuses a
-- second `host` account not revoked for the same person and service, whatever path
-- writes it; `connectHost` reads the violation as "already connected" and hands back the
-- account that won.
--
-- An instance that already holds duplicates is resolved first, deterministically: per
-- person and service, the account kept is the oldest `active` one (else the oldest), ties
-- broken by id; every other one is revoked as an owner's disconnect revokes it (`status`
-- `revoked`, `revoked_at` now, credential erased; a `host` account holds none). Its
-- missions are not moved to the kept account: like after any disconnect, that account's
-- part of each of them is lost (calls through it are refused `account-revoked`, the card
-- says so) and the mission serves through its other accounts; a mission that held only
-- that account serves nothing until its creator edits it or issues a new one on the kept
-- account. Each revocation is written to the audit as an `account-revoked` entry by the
-- actor `migration`, naming the kept account and the missions that held the revoked one.
--
-- Portable SQL but `json_extract`, `json_object`, `json_group_array`, `randomblob` and the
-- `TEMP` table (sqlite).

CREATE TEMP TABLE host_account_duplicates AS
SELECT id, service, owner_user_id, display_name, status, kept_id
FROM (
  SELECT id, service, owner_user_id, display_name, status,
         ROW_NUMBER() OVER per_person AS rank,
         FIRST_VALUE(id) OVER per_person AS kept_id
  FROM accounts
  WHERE status <> 'revoked'
    AND owner_user_id IS NOT NULL
    AND json_extract(metadata_json, '$.credential_kind') = 'host'
  WINDOW per_person AS (
    PARTITION BY service, owner_user_id
    ORDER BY status = 'active' DESC, created_at, id
  )
)
WHERE rank > 1;

-- The audit first, while the status before is still the stored one. The id is a UUIDv7
-- (the time of the migration, then random bits), as the store's own ids are.
INSERT INTO audit (id, ts, kind, user_id, act, object_type, object_id, before_json, after_json)
SELECT
  lower(
    substr(printf('%012x', CAST(unixepoch('subsec') * 1000 AS INTEGER)), 1, 8) || '-'
    || substr(printf('%012x', CAST(unixepoch('subsec') * 1000 AS INTEGER)), 9, 4) || '-'
    || '7' || substr(hex(randomblob(2)), 2, 3) || '-'
    || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2, 3) || '-'
    || hex(randomblob(6))
  ),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'admin',
  'migration',
  'account-revoked',
  'account',
  d.id,
  json_object('status', d.status),
  json_object(
    'service', d.service,
    'display_name', d.display_name,
    'status', 'revoked',
    'owner', json_object('kind', 'user', 'id', d.owner_user_id),
    'cause', 'duplicate-host-account',
    'kept_account_id', d.kept_id,
    'mission_ids', (
      SELECT json_group_array(m.mission_id) FROM (
        SELECT mission_id FROM mission_accounts WHERE account_id = d.id ORDER BY mission_id
      ) m
    )
  )
FROM host_account_duplicates d;

UPDATE accounts
SET status = 'revoked',
    revoked_at = COALESCE(revoked_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    credential_blob = NULL,
    key_version = NULL,
    credential_expires_at = NULL
WHERE id IN (SELECT id FROM host_account_duplicates);

DROP TABLE host_account_duplicates;

CREATE UNIQUE INDEX accounts_one_host_per_person
  ON accounts (service, owner_user_id)
  WHERE status <> 'revoked' AND json_extract(metadata_json, '$.credential_kind') = 'host';
