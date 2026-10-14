-- Migration 0015 — temporary refs a push created at the provider (spec §4.1 ter "Git
-- remote"; ADR gateway-as-git-remote D5).
--
-- A push through the git remote stores its pack at the provider under temporary refs
-- (`refs/vaubaan/<mission>/<nonce>/<n>`) so that the provider can compare what it
-- brings. Each is recorded here before the pack leaves, with the request's deadline, and
-- the row is dropped once the ref is deleted — as soon as the push is decided, except
-- when the decision is `approval-required`: then the deadline becomes the request's
-- expiry, so the person who answers reads the diff at the provider. A sweeper deletes at
-- the provider whatever outlived its deadline (a crash, a client gone, a provider down).
--
--   ref            the temporary ref, unique at the provider (`refs/vaubaan/<random>`: no
--                  mission id in it, since every reader of the repository sees it)
--   target_ref     the branch or tag the push asked for: a later push of the same mission
--                  to the same ref supersedes a pending one
--   connection_id  the connection whose credential deletes it (not a foreign key: a
--                  revoked connection leaves rows the sweeper drops without a call)
--   repository     the resource ref (`owner/repo`)
--   mission_id     the mission whose push it holds
--   object_id      what it points at: the delete is a compare-and-swap on it
--   expires_at     the push's deadline, or the request's expiry; the sweeper deletes the
--                  ref after it
--
-- Portable SQL: one table, two indexes.

CREATE TABLE git_pending_refs (
  ref            TEXT NOT NULL PRIMARY KEY,
  target_ref     TEXT NOT NULL,
  connection_id  TEXT NOT NULL,
  repository     TEXT NOT NULL,
  mission_id     TEXT NOT NULL,
  object_id      TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL
) STRICT; -- sqlite: STRICT

CREATE INDEX git_pending_refs_expires_at ON git_pending_refs (expires_at);
CREATE INDEX git_pending_refs_mission ON git_pending_refs (mission_id, repository);
