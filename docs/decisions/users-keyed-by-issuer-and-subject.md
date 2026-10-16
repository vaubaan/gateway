---
title: A user is (issuer, subject); a sign-in whose groups could not be read is refused
status: accepted
date: 2026-10-13
extends:
  - oidc-relying-party-and-web-session
  - sign-in-hardening-host-cookies-group-overage
---

# A user is (issuer, subject); a sign-in whose groups could not be read is refused

> Decided in the final cycle-end pass, on two paths the Phase 3 review left
> open. Handbooks: [authentication](../handbook/authentication.md),
> [store](../handbook/store.md).

## Context

Two things in the sign-in could give a person an authority that was not theirs.

**The subject alone named a user.** `users.subject` was unique and the sign-in
looked a user up by it. OpenID Connect only promises that a subject is unique
_within one issuer_. An operator who points the instance at another identity
provider — a migration, a second tenant, a mistake in `gateway.yaml` — could
have a different person arrive with a subject an existing account already
carries (sequential ids and email-shaped subjects make that ordinary), and
that person would have received the account: its connections, its missions,
its place in the groups.

**A failed userinfo call read as "no group".** When the ID token carries no
groups claim, the relying party asks the userinfo endpoint. If that call
failed, the sign-in went on with an empty list, and the group sync — which
replaces the IdP-sourced memberships with the claimed list — removed every
membership of the user. The connections of a group whose last member just
"left" become ownerless, and the missions grounded on them read orphaned: a
network error at the identity provider took authority away from a user who
had lost none, and gave an operator ownerless connections to reassign.

## Decision

### D1. The identity of a user is the pair (issuer, subject)

Migration `0011_users_keyed_by_issuer_and_subject.sql`:

- the unique column `subject` is renamed `identity_key`; its value is
  `<issuer> <subject>` (one space: neither part can contain one in a way that
  collides, an issuer is a URL);
- `issuer` and `subject` are added as plain columns, with an index on `issuer`.

`UsersRepo.getByIdentity(issuer, subject)` replaces `getBySubject`, and
`upsertFromIdp` requires the issuer. `IdentityClaims.issuer` is the validated
`iss` of the ID token — never the configured issuer URL, which may differ from
it by a trailing slash.

The migration is forward-only and renames a column instead of rebuilding the
table: SQLite, PostgreSQL and MySQL all accept it, and no row is copied.

### D2. Accounts from before the migration are bound at the first sign-in

Rows that predate the migration have no issuer; their key is `unbound <subject>`.
The first sign-in the relying party validates after the upgrade binds **all** of
them to the issuer of that ID token (`UsersRepo.bindUnboundTo`), logs the count
at `warn`, and only then looks the user up.

The migration cannot do this itself: it has no access to the configuration, and
the configured URL is not guaranteed to equal `iss`. The accounts belong to the
identity provider the instance was using; the first validated sign-in is the
first moment the store learns its exact name.

### D3. Groups that could not be read refuse the sign-in

`mapClaims` throws `LoginError('groups-unavailable')` when the groups claim is
absent from the ID token **and** the userinfo call failed. The sign-in stops
before anything is written: no row refreshed, no membership replaced, no
bootstrap revocation.

The rule is evidence-based, not a setting. An identity provider that sends no
groups at all answers userinfo successfully, without the claim: that is "no
group", and the sign-in goes on as before. Only "we asked and could not hear the
answer" is refused. The login page says what happened and that trying again is
the remedy.

## Consequences

- Changing the identity provider of an instance no longer hands existing
  accounts to whoever carries the same subject there: those people get new
  accounts, and the old ones keep their data, unreachable until an operator
  deals with them. There is no "move an account to another issuer" tool; it is
  a store operation for now.
- One caveat, accepted: an operator who upgrades, lets one person sign in, and
  **then** changes the identity provider has bound the old accounts to the
  first issuer — which is the correct one. An operator who changes the identity
  provider _in the same step_ as the upgrade binds the old accounts to the new
  issuer on the first sign-in. The upgrade note says to sign in once before
  changing the identity provider.
- A userinfo outage at the identity provider stops sign-ins for the
  deployments whose ID token carries no groups claim. Sessions already open are
  not affected. That is the price of not removing authority on a network error.
- Every caller and every fixture that creates a user names an issuer.

## Rejected alternatives

- **A composite unique index on two new columns, dropping the old one.** SQLite
  cannot drop a `UNIQUE` column constraint without rebuilding the table, and
  the migrations are kept portable and copy-free. A single derived key keeps
  one unique constraint that every engine understands.
- **Binding legacy rows to the configured issuer inside the migration.** The
  migration runner does not read the configuration, and the configured URL is
  what the operator typed, not what the provider signs.
- **A configuration key "groups are required".** One more setting to get wrong,
  and the dangerous default is the permissive one. The evidence — claim absent
  and userinfo failed — is available on every sign-in and needs no setting.
- **Keeping the previous memberships when userinfo fails.** It lets a user who
  was removed from a group keep it for as long as userinfo is down, and makes
  the sign-in succeed on stale authority without saying so.
