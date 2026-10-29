---
title: OIDC relying party and server-side web sessions; the operator is recomputed on every request
status: accepted
date: 2026-10-13
---

# OIDC relying party and server-side web sessions

## Context

People sign in through the company's identity provider; IdPs differ (group names or object ids, no
groups claim, delimited strings), and the instance is one Node process behind the company's TLS
terminator. Web sessions must be short, revocable and bound to the instance's origin, and a
bootstrap token must not outlive the first real operator.

## Decision

The gateway is a plain generic OIDC relying party (`openid-client`) for every IdP, with server-side
session rows behind the `SessionStore` port and an opaque `HttpOnly; Secure; SameSite=Lax` cookie,
8 hours absolute. Operator status is the admin rule recomputed from current memberships on every
request, never a stored flag; the first sign-in matching it revokes the bootstrap token.

## Consequences

- Sessions survive a restart and are revoked by deleting a row; a session record holds claims for
  display, never authority.
- Every mutation checks `Origin` against `public_url`; there are no CSRF tokens.
- IdP group memberships are replaced at every sign-in; local groups are never written by a claim.
- No IdP token is stored; RP-initiated logout and several IdPs at once are out of scope. Traps
  (callback from `public_url`, conditional `groups` scope) are in the
  [authentication handbook](../handbook/authentication.md).

## Rejected alternatives

### Auth.js / NextAuth

Framework-bound, hides group handling behind provider adapters, and its session model duplicates
the store.

### A signed stateless cookie

Revocation needs a denylist anyway and the cookie would carry claims; one indexed read is cheap.

### Revoking the bootstrap token on any sign-in, or only by hand

The first lets a non-operator lock the instance; the second leaves a live super-credential.
