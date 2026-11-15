-- Migration 0037 — provider becomes service, and the sign-in provider says so
-- (ADR one-word-per-thing-account-service-plugin, rename R2).
--
-- The word provider had two senses in the store. For an account it named the service the
-- account is at (GitHub, Vercel…): the column says `service` now. For a group, a
-- designated administrator, a sign-in account and its links it named the sign-in
-- provider (the identity provider people sign in through): the column says
-- `sign_in_provider`. Every column is renamed in place: no row moves, no id or value
-- changes. SQLite's RENAME COLUMN carries the CHECK constraints, the indexes (their
-- expressions included) and the triggers along; an index is recreated only for its name.
--
-- The stored names follow, in the same transaction. The audit is append-only: its update
-- trigger is dropped for the rewrite and created again exactly as it was. In the JSON
-- snapshots, a `provider` field of an entry of sign-in, people or administration is the
-- sign-in provider (`sign_in_provider`), and its refusal codes say so
-- (`sign-in-provider-unknown`…); everywhere else it is the service (`service`,
-- `service_grant`, `service_label`…), but in `config-changed`, whose broker settings keep
-- the broker's `providers`. The web sessions keep the sign-in provider of a signed-in person and
-- of a sign-in in progress: renamed so that nobody is signed out. Values are unchanged —
-- a RiskId (`github.merge-protected`) holds a service id, never the word. Acts, object
-- types and refusal codes carry no provider in the service sense; the sign-in provider's
-- acts (`sign-in-provider-tested`…) already say what they are.
--
-- Portable SQL but `DROP TRIGGER`/`CREATE TRIGGER … RAISE` (sqlite).

------------------------------------------------------------------------------
-- Accounts: the service they are at
------------------------------------------------------------------------------

ALTER TABLE accounts RENAME COLUMN provider TO service;
ALTER TABLE accounts RENAME COLUMN provider_grant TO service_grant;

DROP INDEX accounts_provider;
CREATE INDEX accounts_service ON accounts (service);

------------------------------------------------------------------------------
-- The sign-in provider, named as such
------------------------------------------------------------------------------

ALTER TABLE groups           RENAME COLUMN provider TO sign_in_provider;
ALTER TABLE administrators   RENAME COLUMN provider TO sign_in_provider;
ALTER TABLE sign_in_accounts RENAME COLUMN provider TO sign_in_provider;
ALTER TABLE local_links      RENAME COLUMN provider TO sign_in_provider;

DROP INDEX sign_in_accounts_provider_email;
CREATE UNIQUE INDEX sign_in_accounts_sign_in_provider_email
  ON sign_in_accounts (sign_in_provider, email);

------------------------------------------------------------------------------
-- Stored names
------------------------------------------------------------------------------

DROP TRIGGER audit_no_update;

-- The acts of sign-in, people and administration: provider is the sign-in provider, and
-- the codes of a refused sign-in say so.
UPDATE audit SET
  before_json = replace(replace(replace(before_json,
    '"provider":', '"sign_in_provider":'),
    '"provider-unknown"', '"sign-in-provider-unknown"'),
    '"provider-disabled"', '"sign-in-provider-disabled"'),
  after_json = replace(replace(replace(after_json,
    '"provider":', '"sign_in_provider":'),
    '"provider-unknown"', '"sign-in-provider-unknown"'),
    '"provider-disabled"', '"sign-in-provider-disabled"')
  WHERE (act LIKE 'administrator%' OR act LIKE 'sign-in-%' OR act LIKE 'local-%'
         OR act LIKE 'second-factor-%' OR act LIKE 'user-%' OR act LIKE 'group-%'
         OR act LIKE 'invitation-%' OR act = 'setup-finished')
    AND (before_json LIKE '%"provider%' OR after_json LIKE '%"provider%');
-- Every other act and every call: provider is the service (`provider_grant`,
-- `provider_label`… included). `config-changed` is left as written: what it carries of an
-- OAuth broker is the broker's `providers`, and of a sign-in provider no such field.
UPDATE audit SET
  before_json = replace(before_json, '"provider', '"service'),
  after_json  = replace(after_json,  '"provider', '"service')
  WHERE NOT (act IS NOT NULL AND (act LIKE 'administrator%' OR act LIKE 'sign-in-%'
         OR act LIKE 'local-%' OR act LIKE 'second-factor-%' OR act LIKE 'user-%'
         OR act LIKE 'group-%' OR act LIKE 'invitation-%' OR act = 'setup-finished'
         OR act = 'config-changed'))
    AND (before_json LIKE '%"provider%' OR after_json LIKE '%"provider%');

CREATE TRIGGER audit_no_update
BEFORE UPDATE ON audit
BEGIN
  SELECT RAISE(ABORT, 'audit is append-only'); -- sqlite: RAISE syntax
END;

UPDATE events SET details_json = replace(details_json, '"provider', '"service')
  WHERE details_json LIKE '%"provider%';
UPDATE requests SET decision_json = replace(decision_json, '"provider', '"service')
  WHERE decision_json LIKE '%"provider%';

UPDATE web_sessions SET value_json =
  replace(replace(value_json, '"providerId":', '"signInProviderId":'), '"provider":', '"signInProvider":')
  WHERE value_json LIKE '%"provider%';
