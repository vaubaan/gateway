-- Migration 0036 — one word per thing: connection becomes account, and the instance's
-- password accounts become sign-in accounts (ADR one-word-per-thing-account-service-plugin).
--
-- Every table and column is renamed in place: no row moves, no id changes. A credential
-- blob is sealed with its row id as associated data and under a key derived from
-- 'vaubaan/connection-key/v1:' || id; neither the id nor that context changes, so every
-- stored credential still opens. SQLite's RENAME carries the foreign keys, the triggers
-- and the indexes along; the indexes are recreated only for their names.
--
-- The stored names of acts, refusal codes and object types follow, in the same
-- transaction: the audit is append-only, so its update trigger is dropped for the
-- rewrite and created again as it was. The JSON snapshots of the audit, the session
-- events and the decisions of requests carry the protocol's field names
-- (`connection_id`, `connections_added`…): rewritten too, so that history reads with the
-- new names. A tool name an agent called (`vaubaan__list_my_connections`) is history
-- and is kept as called. The telemetry payload is not stored here.
--
-- Portable SQL but `DROP TRIGGER`/`CREATE TRIGGER … RAISE` (sqlite).

------------------------------------------------------------------------------
-- Sign-in accounts (were local accounts)
------------------------------------------------------------------------------

ALTER TABLE local_accounts RENAME TO sign_in_accounts;
ALTER TABLE local_secrets RENAME COLUMN account_id TO sign_in_account_id;

DROP INDEX local_accounts_provider_email;
CREATE UNIQUE INDEX sign_in_accounts_provider_email ON sign_in_accounts (provider, email);
DROP INDEX local_secrets_account;
CREATE INDEX local_secrets_sign_in_account ON local_secrets (sign_in_account_id);

------------------------------------------------------------------------------
-- Accounts (were connections)
------------------------------------------------------------------------------

ALTER TABLE connections RENAME TO accounts;
ALTER TABLE connection_resources RENAME TO account_resources;
ALTER TABLE mission_connections RENAME TO mission_accounts;

ALTER TABLE account_resources     RENAME COLUMN connection_id TO account_id;
ALTER TABLE shares                RENAME COLUMN connection_id TO account_id;
ALTER TABLE mission_accounts      RENAME COLUMN connection_id TO account_id;
ALTER TABLE mission_resource_sets RENAME COLUMN connection_id TO account_id;
ALTER TABLE mission_resources     RENAME COLUMN connection_id TO account_id;
ALTER TABLE git_pending_refs      RENAME COLUMN connection_id TO account_id;
ALTER TABLE audit                 RENAME COLUMN connection_id TO account_id;

DROP INDEX connections_owner_user;
CREATE INDEX accounts_owner_user ON accounts (owner_user_id);
DROP INDEX connections_owner_group;
CREATE INDEX accounts_owner_group ON accounts (owner_group_id);
DROP INDEX connections_provider;
CREATE INDEX accounts_provider ON accounts (provider);
DROP INDEX shares_connection;
CREATE INDEX shares_account ON shares (account_id);
DROP INDEX mission_connections_connection;
CREATE INDEX mission_accounts_account ON mission_accounts (account_id);
DROP INDEX mission_resource_sets_connection;
CREATE INDEX mission_resource_sets_account ON mission_resource_sets (mission_id, account_id, position);

------------------------------------------------------------------------------
-- Stored names
------------------------------------------------------------------------------

DROP TRIGGER audit_no_update;

UPDATE audit SET act = replace(act, 'local-account-', 'sign-in-account-')
  WHERE act IN ('local-account-created', 'local-account-removed');
UPDATE audit SET act = replace(act, 'connection', 'account') WHERE act LIKE '%connection%';
UPDATE audit SET object_type = 'account' WHERE object_type = 'connection';
UPDATE audit SET object_id = 'sign-in-account:' || substr(object_id, length('local-account:') + 1)
  WHERE object_id LIKE 'local-account:%';
UPDATE audit SET refusal_code = replace(refusal_code, 'connection-', 'account-')
  WHERE refusal_code IN ('connection-unavailable', 'connection-revoked');
UPDATE audit SET
  before_json = replace(replace(replace(before_json,
    '"connection', '"account'), '"lost_connections"', '"lost_accounts"'), '"mission_connection', '"mission_account'),
  after_json = replace(replace(replace(after_json,
    '"connection', '"account'), '"lost_connections"', '"lost_accounts"'), '"mission_connection', '"mission_account')
  WHERE before_json LIKE '%connection%' OR after_json LIKE '%connection%';

CREATE TRIGGER audit_no_update
BEFORE UPDATE ON audit
BEGIN
  SELECT RAISE(ABORT, 'audit is append-only'); -- sqlite: RAISE syntax
END;

UPDATE events SET kind = replace(kind, 'connection', 'account') WHERE kind LIKE '%connection%';
UPDATE events SET details_json = replace(replace(replace(details_json,
    '"connection', '"account'), '"lost_connections"', '"lost_accounts"'), '"mission_connection', '"mission_account')
  WHERE details_json LIKE '%connection%';
UPDATE requests SET decision_json = replace(decision_json, '"connection', '"account')
  WHERE decision_json LIKE '%connection%';
