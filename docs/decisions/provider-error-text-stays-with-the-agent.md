---
title: A provider's error text goes to the calling agent only; the gateway keeps the status in its own words
status: accepted
date: 2026-10-13
---

# A provider's error text goes to the calling agent only

## Context

Plugins quote the provider's error body in their errors, and that text reached the Accounts page,
logs, stored discovery errors and the append-only audit. A provider whose 401 echoes the presented
credential would put the token in logs and in an audit entry that cannot be cleaned; the redactor
only knows the configured secrets.

## Decision

A failed tool call returns the provider's message to the calling agent and it is stored nowhere.
Everything else keeps only `providerFailureReason(err)`: a status, a protocol code or a phrase in
the gateway's words, never a message. The one exception is `CredentialRefusal`, whose message the
plugin wrote and holds no provider text and no part of the credential.

## Consequences

- Unexpected failures are logged as class and stack frames; Next.js's console printing is routed
  through a guard that withholds messages.
- OAuth callbacks show the protocol code only, never `error_description`.
- A future plugin quoting bodies is covered by the same sinks; a plugin that needs to tell a person
  what to fix throws a `CredentialRefusal`.

## Rejected alternatives

### A per-call redactor built from the credentials in flight

Misses encoded or partial echoes, and still stores provider text in the audit.

### Bounded excerpts

The credential is often in the first characters of an echo.

### Stop every plugin from quoting bodies

The agent would lose the reason a call failed, and every future plugin would have to remember.

### A "safe message" flag on `UpstreamAuthError`

A class is what a reviewer greps and a test asserts; a flag is set by habit.

## Amendment 2026-10-31 — the connect page keeps the plugin's sentence of a rejection

Owner decision (pre-publication audit, connection UX M1): "Gmail: the provider rejected the
credential (HTTP 401)" threw away the plugin's sentence that names the fix ("the app password is
wrong or was revoked, app passwords are turned off, or IMAP is off"). While a person connects, the
`UpstreamAuthError` of `verify` or of the first discovery is now shown with its sentence:
one line, at most 300 characters, the HTTP status added, and every value of the credential being
connected masked (as typed and URL-encoded). It reaches only the connect page of that person — who
holds the credential anyway — through a notice readable once; nothing stores, logs or audits it.
Every other path (refresh, a later discovery, a discovery failure recorded on the account, logs)
keeps the status alone. The rejected "per-call redactor" stays rejected for those: a partial or
encoded echo is acceptable only in front of the person who typed the value.
