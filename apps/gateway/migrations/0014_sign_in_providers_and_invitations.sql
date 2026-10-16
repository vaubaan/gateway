-- Migration 0014 — several sign-in providers and the invitation list (spec §0 "Identity
-- provider", "Invitation", §4.2 People, §4.3; ADR sign-in-providers-admission-and-admin-rule).
--
-- An instance may now offer several sign-in providers at once. Two things follow for the
-- store.
--
--   groups.provider   the sign-in provider that claims an IdP-sourced group (its id, e.g.
--                     `idp`, `github`), NULL for a local group. A group name is unique in
--                     the instance; a group belongs to the provider that first claimed it,
--                     and the same name claimed by another provider is skipped at sign-in
--                     (logged), exactly as a name held by a local group is. Without it, a
--                     group claimed by provider B would hand B's users the connections,
--                     the shares and the admin rule of provider A's group of that name.
--                     Every IdP-sourced group that exists was claimed by the one provider
--                     an instance had until now, whose id is `idp` (the single-provider
--                     keys, or the settings saved from the interface).
--
--   invitations       the instance-wide list of email addresses an administrator allowed
--                     to sign in, through any provider that verified the address. An entry
--                     admits; it signs nobody in and sends nothing. `invited_by` is the
--                     user id of the administrator, or `bootstrap` for the install token —
--                     not a foreign key, like the actor of an audit entry.
--
-- Portable SQL: one nullable `ADD COLUMN`, one backfill, one table.

ALTER TABLE groups ADD COLUMN provider TEXT;

UPDATE groups SET provider = 'idp' WHERE source = 'idp';

CREATE TABLE invitations (
  email       TEXT NOT NULL PRIMARY KEY,   -- lower-cased address
  invited_by  TEXT NOT NULL,               -- users.id, or 'bootstrap'
  created_at  TEXT NOT NULL
) STRICT; -- sqlite: STRICT
