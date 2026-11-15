-- Migration 0038 — the bytes of a forwarded call, for the Overview of Activity
-- (spec §4.2 "Activity"; handbook audit.md).
--
--   audit.request_bytes    what the call sent to the service: the arguments as JSON (MCP),
--                          the request git sent or the pack a push carried (git door).
--   audit.response_bytes   what came back: the result as JSON, the relayed pack.
--
-- Both NULL on a refused call (nothing was sent), `response_bytes` NULL on a call that
-- failed upstream, and both NULL on every entry written before this migration: the
-- Overview sums what is known and never guesses the rest.
--
-- The Overview sums the calls of the missions a reader may see over a span, grouped by
-- mission, account and key holder: one covering index over the call entries serves both
-- the scope by mission and the span, so the sum never reads the table itself.
--
-- Portable SQL (a partial index is `WHERE` on both SQLite and Postgres).

ALTER TABLE audit ADD COLUMN request_bytes INTEGER;
ALTER TABLE audit ADD COLUMN response_bytes INTEGER;

CREATE INDEX audit_calls_overview ON audit (
  mission_id, ts, account_id, token_kind, token_holder, decision, request_bytes, response_bytes
) WHERE kind = 'call';
