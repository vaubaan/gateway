-- Migration 0015 — temporary refs of pushes waiting for an approval (spec §4.1 bis "Git
-- remote"; ADR gateway-as-git-remote D5).
--
-- A push through the git remote stores its pack at the provider under temporary refs
-- (`refs/vaubaan/<mission>/<nonce>/<n>`) so that the provider can compare what it
-- brings. They are deleted as soon as the push is decided — except when the decision is
-- `approval-required`: then they stay while the request is open, so the person who
-- answers reads the diff at the provider, and a sweeper deletes them once the request
-- has expired. One row per temporary ref left at the provider.
--
--   ref            the temporary ref, unique at the provider (it carries a random nonce)
--   connection_id  the connection whose credential deletes it (not a foreign key: a
--                  revoked connection leaves rows the sweeper drops without a call)
--   repository     the resource ref (`owner/repo`)
--   mission_id     the mission whose push it holds
--   object_id      what it points at: the delete is a compare-and-swap on it
--   expires_at     the request's expiry; the sweeper deletes the ref after it
--
-- Portable SQL: one table, one index.

CREATE TABLE git_pending_refs (
  ref            TEXT NOT NULL PRIMARY KEY,
  connection_id  TEXT NOT NULL,
  repository     TEXT NOT NULL,
  mission_id     TEXT NOT NULL,
  object_id      TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL
) STRICT; -- sqlite: STRICT

CREATE INDEX git_pending_refs_expires_at ON git_pending_refs (expires_at);
