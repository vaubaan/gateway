-- Migration 0006 — the authorization server of the management door (spec §4.1 bis, §6
-- "short, traceable delegated tokens"; ADR management-door-authorization-server).
--
-- 0001 created the tables of the OAuth clients, the delegations and their codes and
-- tokens. The authorization server (P2.3) needs a few more facts:
--
--   oauth_clients.registration                'dynamic' (RFC 7591) or 'metadata-document'
--                                             (the client_id is the https URL of a Client
--                                             ID Metadata Document)
--   oauth_clients.token_endpoint_auth_method  how the client authenticates at /oauth/token
--   oauth_clients.client_uri                  the home page the client declares, shown as is
--   oauth_clients.metadata_expires_at         when a fetched metadata document must be
--                                             fetched again
--   oauth_clients.operator_decision           NULL until an operator approves or disables
--                                             the client; the registration policy of the
--                                             configuration decides for an undecided client,
--                                             at every use, never from a stored snapshot
--   oauth_clients.decided_at / decided_by     when, and the operator (user id or the
--                                             bootstrap actor)
--   delegations.revoke_reason                 who ended the delegation: its user, its
--                                             client, an operator, or the instance on a
--                                             replayed refresh token or authorization code
--
-- Portable SQL: plain `ADD COLUMN` with constant defaults and CHECKs. The closed set of
-- `revoke_reason` is checked by the repository (`DELEGATION_REVOKE_REASONS`), like the
-- acts of the audit table: adding a reason must not need a table rebuild.

ALTER TABLE oauth_clients ADD COLUMN registration TEXT NOT NULL DEFAULT 'dynamic'
  CHECK (registration IN ('dynamic', 'metadata-document'));
ALTER TABLE oauth_clients ADD COLUMN token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none'
  CHECK (token_endpoint_auth_method IN ('none', 'client_secret_basic', 'client_secret_post'));
ALTER TABLE oauth_clients ADD COLUMN client_uri TEXT;
ALTER TABLE oauth_clients ADD COLUMN metadata_expires_at TEXT;
ALTER TABLE oauth_clients ADD COLUMN operator_decision TEXT
  CHECK (operator_decision IS NULL OR operator_decision IN ('approved', 'disabled'));
ALTER TABLE oauth_clients ADD COLUMN decided_at TEXT;
ALTER TABLE oauth_clients ADD COLUMN decided_by TEXT;

ALTER TABLE delegations ADD COLUMN revoke_reason TEXT;

CREATE INDEX delegations_client ON delegations (client_id);
