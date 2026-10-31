-- Migration 0028 — mission tokens still stored as an argon2id hash are revoked (ADR
-- mission-token-sha256-digest, amendment 2026-10-31).
--
-- Since 2.0.0-alpha.1 a mission token is stored as the SHA-256 digest of the Bearer;
-- a row an earlier build wrote as argon2id was still checked with argon2id and moved
-- to the digest on its first matching call. That path — a second algorithm and a
-- throttle of its own in the hot verifier — is removed. A row still holding argon2id
-- belongs to a token that has not been presented since the upgrade to the digest: it
-- cannot be moved (the digest needs the secret, which the instance sees only when the
-- holder presents it), so it is revoked. Its mission keeps serving its other tokens;
-- the creator issues a new one (or the holder rotates theirs).
--
-- Rows already retired (`rotated`, `revoked`) are left as they are: they authenticate
-- nothing. `retired_at` is stamped with the instant of the migration, as the
-- application writes every timestamp (ISO-8601 UTC, milliseconds).

UPDATE mission_tokens
SET status = 'revoked',
    retired_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') -- sqlite: strftime; Postgres: to_char(now() at time zone 'utc', …)
WHERE hash_alg = 'argon2id' AND status = 'active';
