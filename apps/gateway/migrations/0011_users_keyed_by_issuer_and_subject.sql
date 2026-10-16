-- Migration 0011 — a user is (issuer, subject), not the subject alone (spec §0 "User";
-- ADR users-keyed-by-issuer-and-subject).
--
-- OpenID Connect makes a subject unique *within its issuer*. `users.subject` was UNIQUE
-- on its own: after the operator points the instance at another identity provider, a
-- person whom the new provider happens to give a subject already stored here (a
-- sequential id, an employee number, an email used as subject) would have signed in as
-- the old account — its connections, its shares, its missions.
--
--   users.issuer         the `iss` of the ID token the account signed in with, exactly as
--                        issued. NULL only for an account created before this migration,
--                        until the first sign-in after it (see below).
--   users.subject        the `sub` claim, as before — no longer unique on its own.
--   users.identity_key   the old `subject` column, renamed: it carries the UNIQUE
--                        constraint of 0001, which cannot be dropped without rebuilding a
--                        table nine others reference. It now holds `<issuer> <subject>`:
--                        an issuer is a URL and contains no space, so the first space
--                        splits the two and the constraint is exactly
--                        UNIQUE (issuer, subject). An account whose issuer is not known
--                        yet holds `unbound <subject>`, which no issuer-qualified key can
--                        equal (`unbound` is not a URL), so no sign-in can match it by
--                        accident.
--
-- Accounts that exist already. The store never recorded which issuer vouched for them,
-- and this file cannot read the configuration. They are bound, all at once, to the
-- issuer of the first sign-in that follows the migration (`UsersRepo.bindUnboundTo`):
-- that is the provider the instance was using. Consequence for the operator: upgrade,
-- let somebody sign in, and only then change the identity provider — changing it in the
-- same restart as the upgrade would bind the existing accounts to the new provider.
--
-- Portable SQL: `RENAME COLUMN`, `ADD COLUMN`, one `UPDATE`, one index (SQLite ≥ 3.25
-- and Postgres alike).

ALTER TABLE users RENAME COLUMN subject TO identity_key;
ALTER TABLE users ADD COLUMN issuer TEXT;
ALTER TABLE users ADD COLUMN subject TEXT NOT NULL DEFAULT '';

UPDATE users SET subject = identity_key, identity_key = 'unbound ' || identity_key;

-- "Which accounts are still unbound" at sign-in, and the per-issuer listing.
CREATE INDEX users_issuer ON users (issuer);
