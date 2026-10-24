-- Migration 0023 — the OAuth clients an administrator declared are removed (spec §4.3;
-- ADR gmail-over-imap-with-an-app-password).
--
-- Gmail, the only service that connected through an OAuth client declared by an
-- administrator, now connects with an app password over IMAP. The settings the
-- connect page saved for such a client (`provider_apps.<provider>.<field>`, the
-- client secret sealed) are no longer read by any build: they are deleted, so that
-- no sealed secret is kept for nothing. The clients the gateway registers itself
-- (`oauth_clients.<provider>.*`, Miro) are not touched.
--
-- Portable SQL.

DELETE FROM instance_config WHERE substr(key, 1, 14) = 'provider_apps.';
