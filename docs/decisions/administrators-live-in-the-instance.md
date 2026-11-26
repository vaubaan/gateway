---
title: Administrators are designations stored in the instance; the configuration only seeds them, and the master key recovers them loudly
status: accepted
date: 2026-10-20
---

# Administrators are designations stored in the instance; the configuration only seeds them, and the master key recovers them loudly

## Context

Administrators were whoever matched the configuration's admin rule (`admin.emails`,
`admin.group`), recomputed on every request. That put the power to name administrators outside
the instance, locked a real administrator out when the rule named another address, locked a
restored instance out, and left no way back without a shell. The master key is 32 symmetric bytes,
so a proof of holding it can only be a MAC.

## Decision

A person administers the instance only through a row of `administrators`: a `user`, a pending
`email` (turned into a `user` row by the first sign-in it admits) or a provider's `group`. The
configuration's rule is applied once, while the store names nobody, and grants nothing silently
afterwards. No act may take the instance from at least one way in to none, and holding the master
key recovers access through `/admin/recover` (an HMAC proof computed in the browser), audited and
announced on every page for thirty days.

## Consequences

- A restored store carries its designations; the setup does not reopen and the new host's rule
  applies only to a store that names nobody.
- Unmaking a designation, deactivating a user, disabling or removing a provider are refused when
  they would leave no way in; removing a provider never ends the remover's session.
- The setup ends by an explicit "Finish setup"; no sign-in revokes the bootstrap token.
- Rules of the second factor, provider tests and the recovery page: handbook
  [authentication](../handbook/authentication.md).

## Rejected alternatives

### Keep the configuration's rule live beside the store

Keeps the outside lever, and the union makes "who administers" unanswerable from inside.

### Clear `bootstrap.revoked_at` on restore

Hands the new host the power to name an administrator after every restore.

### Upload the key file to recover, or a key pair derived from it

The key would cross the edge and request memory; the instance holds the key anyway, so a
signature proves nothing a MAC does not.

### Designations by email only, or a shell command for recovery

An address is a claim, a person is (issuer, subject); a shell already reaches store and key, and
the page is the path the audit covers.

## Amendment 2026-11-26 — the recovery session can also set a sign-in account's password

An instance with no mail relay, every local one, had no way back from a forgotten password: its
only administrator is already named, and a reset link leaves by mail or from a signed-in
administrator. The recovery session now does one of two things: name an administrator, or set a
new password for one sign-in account. It grants nothing the key's holder could not already take
(naming themselves, then resetting any account), and it is as loud as the naming: audited, on every
page for thirty days, notified to the administrators, every session of the account ended. The
second factor is untouched and still asked at the next sign-in. The proof stays computed in the
browser; picking the key file reads it there, it is never uploaded.
