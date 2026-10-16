---
title: Trusted-edge mode reads the client address from one header the edge overwrites, only when the operator declares it
status: accepted
date: 2026-10-13
extends:
  - railway-deployment-and-privilege-dropping-entrypoint
  - security-headers-set-by-the-application
---

# Trusted-edge mode reads the client address from one header the edge overwrites, only when the operator declares it

## Context

The gateway believes a client address only from `X-Forwarded-For` written by
a proxy listed in `trusted_proxies`. Railway publishes no address range for
its edge and documents `X-Real-IP` (the client's address) instead, so the
deploy guide says to leave `trusted_proxies` unset. Every address-keyed
limit — the request page, the OAuth token and registration endpoints, and now
the sign-in start, callbacks and bootstrap endpoint — is then one window
shared by everybody, and one outsider holds them at 429 for all (threat model
A2; security review 2026-10-15, auth M2, external M2/M3).

A single-value header written by the edge is trustworthy exactly when the
edge **overwrites** whatever the client sent. That is a fact about the edge,
which only the operator can establish — not something the gateway can detect.

## Decision

1. A configuration key `client_ip_header` (`VAUBAAN_CLIENT_IP_HEADER`), off by
   default, names that header. Accepted values are a closed list of
   single-value client-address headers: `x-real-ip`, `cf-connecting-ip`,
   `true-client-ip`, `fly-client-ip` (lower-cased on load).
   `x-forwarded-for` is not accepted: it is a list, read through
   `trusted_proxies`.
2. When it is set, `http/client-ip.ts` — still the one reading of client
   addresses — takes the address from that header alone: one IP address
   (brackets and a port are stripped), anything else (absent, a list, a
   name) reads as unknown. Every consumer gets it: the execution door's audit
   and token throttle, the management gate, the request page, the OAuth
   endpoints, the sign-in limits.
3. It **excludes** `trusted_proxies`: the loader refuses both (exit 78). Two
   ways of believing an address at once would make the effective rule
   depend on which header a request carries.
4. At boot the gateway logs, once, that the mode is on and what it rests on,
   with the check to make (send a forged value, confirm the instance records
   the real address).

## Consequences

- On Railway, with `VAUBAAN_CLIENT_IP_HEADER=x-real-ip`, limits become per
  client and the audit records `client_ip` — **if** Railway's edge overwrites
  `X-Real-IP`. That must be verified live before enabling it (deploy guide
  §2): from outside, send `X-Real-IP: 192.0.2.1` and confirm the Activity
  entry (or a 429 window) shows the real address, not `192.0.2.1`.
- Set behind an edge that passes the header through, any client chooses the
  address it is limited and audited under: the per-address limits become
  per-attacker-choice, i.e. bypassable. The documentation says this in the
  key's own comment and in the deploy guide.
- Nothing changes for an instance that does not set the key.

## Rejected alternatives

- **Believe `X-Real-IP` by default on Railway** (detect `RAILWAY_*`
  variables). The gateway cannot know the edge's behaviour; a default that
  is only safe under an unverified assumption is the wrong default.
- **A free-form header name.** A typo, or a header the edge appends to,
  would silently make addresses client-chosen; a closed list of headers
  that are single-valued by definition limits the mistake.
- **Allow it together with `trusted_proxies` and pick one per request.**
  Two rules of belief at once is how a forged header slips through.
