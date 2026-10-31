---
title: A user is (issuer, subject); identities never merge by email
status: accepted
date: 2026-10-13
---

# A user is (issuer, subject); identities never merge by email

## Context

OIDC subjects are unique only within one issuer, so keying users by subject alone would hand an
existing account, its connections, missions and groups, to whoever carries the same subject at
another provider. An instance also signs people in through several providers at once, some of
which let anyone register any address. Handbook [authentication](../handbook/authentication.md).

## Decision

A user's identity is the unique `identity_key` `<issuer> <subject>`, with `issuer` taken from the
validated `iss` of the ID token, never from the configured URL. Two identities are never linked
by email: the same person through Google and GitHub is two users.

## Consequences

- Every caller and fixture that creates a user names an issuer.
- Pointing the instance at a new IdP creates new accounts; old ones keep their data, unreachable
  until an operator acts on the store.
- Legacy rows keyed `unbound <subject>` are bound to the issuer of the first validated ID token.

## Rejected alternatives

### A composite unique index on two new columns

SQLite cannot drop a `UNIQUE` column without rebuilding the table; one derived key stays portable.

### Link identities by verified email

The weakest provider would open the strongest one's account.

### Bind legacy rows to the configured issuer in the migration

The migration runner reads no configuration, and the configured URL is not what the provider
signs.

## Amendment 2026-10-31 — no binding of unbound rows any more

Owner decision before publication (gateway audit F7): the provider id `idp` stops being special
everywhere, and the binding of `unbound <subject>` rows at the first sign-in through it goes with
it. Such a row belongs to an account a build before 2.0.0-alpha.1 created and nobody has signed in
to since; binding it to the configured issuer at boot stays rejected (above). It is left as it is:
the boot names how many remain, its person signs in as somebody new, and an owner transfers what
the old account held. The stored single-provider settings (`idp.*`) become the saved provider `idp`
at boot (`auth/single-provider-upgrade.ts`), whose users keep their issuer.
