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
