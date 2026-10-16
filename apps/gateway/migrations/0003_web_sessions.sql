-- Migration 0003 — web sessions (human authentication, spec §6).
--
-- The opaque server-side session rows behind the composition root's
-- `SessionStore` port (P1.1, ADR oidc-relying-party-and-web-session). One row
-- per cookie value: the id is the random cookie value, `value_json` the
-- session record (a signed-in user, a bootstrap operator, or a pending OIDC
-- login with its state / nonce / PKCE verifier), `expires_at` the absolute
-- expiry. Expired rows are swept opportunistically by the store on write.
--
-- Not to be confused with `sessions`, which is the living history of a
-- mission (spec §0 "Session").

CREATE TABLE web_sessions (
  id          TEXT NOT NULL PRIMARY KEY,
  value_json  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
) STRICT; -- sqlite: STRICT

CREATE INDEX web_sessions_expires ON web_sessions (expires_at);
