---
title: A provider's error text goes to the calling agent only; the gateway keeps the status in its own words
status: accepted
date: 2026-10-13
extends:
  - decision-stages-fail-closed-and-audited
  - connect-driver-and-resource-curation
  - upstream-credential-cache-and-rejected-credentials
---

# A provider's error text goes to the calling agent only; the gateway keeps the status in its own words

## Context

The plugins quote the provider's error body in their error messages
(`Cloudflare API GET /zones 403: <first 500 characters>`), and throw
`UpstreamAuthError` / `UpstreamHttpError` carrying the status. The execution
pipeline already separates the two readers of a failed call: the audit gets a
summary built from the status and the error class, the agent gets the text
(ADR decision-stages-fail-closed-and-audited).

Security review 2026-10-15 (secrets-and-infra M3): outside the pipeline the
text went everywhere. The connect flows put it in `ConnectError.detail`, shown on
the Accounts page; a failed discovery logged it (`resource discovery failed`),
**persisted** it in the connection's `discovery.error` and in the append-only
audit; a rejected refresh logged it; unexpected failures were logged with their
message; Next.js printed the errors of route handlers itself, outside the
redactor. A provider whose 401 body echoes the presented credential — several
echo the offending header or a URL with `?apikey=` — would put the token in the
platform's log stream, in the store and in an audit entry that cannot be
cleaned. The redactor only knows the configured secrets, not per-connection
credentials.

## Decision

1. **One function, `providerFailureReason(err)`** (`connections/failure-reason.ts`),
   is what the gateway keeps of a provider failure: the HTTP status of an
   `UpstreamAuthError` / `UpstreamHttpError` / `OAuth2TokenError` (with the
   OAuth `error` code only when it is a protocol token, `[a-z_]+`), "could not
   be reached" / "did not answer in time" for transport failures, the code of a
   `ConnectError`, otherwise "the provider call failed (<class name>)". Never a
   message.
2. It replaces the provider text in `ConnectError.detail` (verify and
   discovery at connect time), in `discovery.error` (stored and audited), in
   the `credential refresh rejected` and `resource discovery failed` log lines
   (field `failure`), and in the `ProviderUnreachableError` built by a failed
   refresh.
3. **Unexpected failures are logged as `error_class` and `stack_frames`**
   (`logging/error-fields.ts`, `errorFields`), never their message: the
   connections handlers, the company-app code exchange, the temporary-ref
   sweeper. The helper is the one the execution door already used for a
   failing decision stage, moved to the logging module.
4. **Next.js's own printing is guarded.** After a successful boot,
   `instrumentation.ts` installs `guardConsole` (`logging/console-guard.ts`):
   `console.error` and `console.warn` print through the redactor of the
   configuration, and an `Error` argument is printed as its class, its digest
   and its stack frames, with `[message withheld]` instead of the message. The
   gateway's own logger writes to the streams directly and is unaffected.
5. **The agent keeps the text.** A tool call that fails still returns the
   provider's message to the calling agent, which sent the arguments and holds
   the mission; it is stored nowhere (unchanged).

## Consequences

- A person who pastes a key the provider refuses reads "the provider rejected
  the credential (HTTP 401)" instead of the provider's sentence (Resend's
  "this API key is restricted to only send emails" is no longer shown). The
  provider's own pages, or an agent call, give the precise reason.
- Operators debugging an unexpected error get the class and where it was
  thrown, not what it said; reproducing it locally gives the rest.
- Errors that Next.js prints from other libraries lose their message too.
  That is the price of not knowing which message carries what.
- Plugins are unchanged; a future plugin that quotes a body is covered by the
  same sinks.

## Rejected alternatives

- **A per-call redactor built from the credential values in flight** (the
  review's other suggestion). Catches an echoed token verbatim, but not an
  encoded, truncated or partially quoted one, and still stores provider-chosen
  text in an append-only audit. Not keeping the text is simpler and complete.
- **Bounded excerpts** (first N characters). The credential is often in the
  first characters of an echo.
- **Change every plugin to stop quoting bodies.** The agent loses the reason a
  call failed, which is what lets it correct itself; and every future plugin
  would have to remember. The gateway's sinks are the narrower place.
- **Disable Next.js's error logging** (`quiet`). Not exposed for the
  standalone server, and the stack frames are worth keeping.
