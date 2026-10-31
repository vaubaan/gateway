---
title: Local accounts are a sign-in provider living in the instance — invitation only, argon2id passwords, a required second factor, links sent by the instance's own mail
status: accepted
date: 2026-10-19
---

# Local accounts are a sign-in provider living in the instance — invitation only, argon2id passwords, a required second factor, links sent by the instance's own mail

## Context

Every human sign-in was delegated to the company's directory (OpenID Connect) or GitHub, so a team
without a directory, or whose tenant the operator may not touch, had to register an OAuth app at a
third party first: a wall for exactly the teams a self-hosted instance is for. A session on the
instance reaches every connection's credentials.

## Decision

A sign-in provider of kind `local` (at most one) keeps accounts in the store: issuer
`urn:vaubaan:local:<id>`, subject the account id, created only for an invited or designated address
through a single-use 15-minute link. Passwords are argon2id (64 MiB, 2 passes, hashed by the native
`argon2` binding on the thread pool, never on the event loop), every sign-in requires a
TOTP code or a recovery code, and invitation and reset links are sent through the instance's own
`mail.*` settings, never a provider plugin. Hashes, TOTP secrets and recovery codes are sealed blobs
like every stored secret.

## Consequences

- The store holds a secret per person: a restore under another master key opens no account.
- Invitations and resets need an SMTP relay; without one the administrator copies the link from
  People. Sign-in itself needs no mail.
- Identities never merge by email across providers; a person is (issuer, subject).
- Lockout, link and refusal rules: spec §6 and handbook
  [authentication](../handbook/authentication.md).

## Rejected alternatives

### Magic-link sign-in

Makes the mailbox the whole credential and mail a dependency of every sign-in.

### Passkeys instead of TOTP

Instances are reached from several machines and recovery needs codes anyway; can be added later as
a second kind of factor.

### An optional second factor

A password alone is below the bar for a session that reaches every connection's credentials.

### Sending mail through a provider plugin

The gateway's own mail must not depend on a connection somebody may revoke.

## History

- 2026-10-31: passwords are hashed by the native `argon2` binding instead of libsodium's
  synchronous WebAssembly build, which held the event loop for every anonymous password post
  (security audit M2). Same limits and string format: the stored hashes verify unchanged.
