---
title: The sign-in surface is rate-limited, and a guessed bootstrap token is revoked
status: accepted
date: 2026-10-13
extends:
  - oidc-relying-party-and-web-session
  - sign-in-providers-admission-and-admin-rule
  - client-address-from-a-trusted-edge-header
---

# The sign-in surface is rate-limited, and a guessed bootstrap token is revoked

## Context

Every anonymous surface of the instance was throttled except the human
sign-in (security review 2026-10-15, auth M1): `GET /auth/login/<id>` writes a
pending `web_sessions` row per request (10-minute life) with no limit, the
callbacks are unthrottled, and `POST /api/auth/bootstrap` can be tried as fast
as the process answers — the origin check protects browsers, not scripts. A
flood fills the single SQLite writer with pending rows; a typed bootstrap token
can be guessed.

## Decision

1. The authentication module receives the instance's `RateLimiter` port and the
   client-address resolver (`http/client-ip.ts`). Limits (`AUTH_LIMITS`):
   - sign-in start: 20 per minute **per client address**, only when the address
     is known (an unknown address would be one window for all, which the next
     one already is), and 1 000 per 10 minutes **instance-wide**. Ten minutes is
     the life of a pending row, so the live pending rows are bounded;
   - callbacks: 30 per minute per known address, 2 000 per minute instance-wide;
   - bootstrap: 10 attempts per 10 minutes instance-wide.
     A refused attempt redirects with the closed code `too-many-attempts` and
     writes nothing.
2. Every wrong bootstrap token is counted durably (`instance_config`
   `bootstrap.misses`); at 50 the token is revoked (`bootstrap.revoked_at`), as
   the first operator sign-in would revoke it. The token is a one-time install
   secret: one being guessed has lost its value.
3. The limiter is the in-memory sliding window of the instance (`// single-process
only` behind the `RateLimiter` port, like every surface limit); a hosted
   deployment replaces it with a shared one.

## Consequences

- With no known client address, one outsider can hold every sign-in at
  `too-many-attempts` for up to ten minutes. The store stays bounded and the
  execution door is unaffected; trusted-edge mode or `trusted_proxies` restores
  per-address limits. Recorded under A2 in the threat model.
- An outsider can end the bootstrap path of an instance whose only way in is the
  token, by sending 50 wrong ones. The deploy guides set the sign-in provider in
  the configuration, which needs no token; an operator who relied on the token
  sets a provider in the configuration and restarts.
- Nothing else in the sign-in flow changes; the pending login stays a server-side
  row.

## Rejected alternatives

- **A stateless pending login** (the state, nonce and PKCE verifier sealed in
  the cookie with the master key, no row at all). It removes the write
  amplification entirely and remains a good next step; it changes the relying
  party's storage contract and its single-use guarantee (today the row is
  deleted on use), which is more than a hardening pass should move. The
  instance-wide window bounds the rows meanwhile.
- **Count pending rows in the store and refuse above a ceiling.** Rows are keyed
  by the digest of `login:<id>`, so they cannot be counted apart from sessions
  without a schema change; the instance-wide window gives the same bound.
- **Lock the bootstrap endpoint for a while instead of revoking.** A token that
  is being guessed should stop being a way in; a timed lock only slows the
  guess.
