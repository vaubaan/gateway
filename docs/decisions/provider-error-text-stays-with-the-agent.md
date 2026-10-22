---
title: A provider's error text goes to the calling agent only; the gateway keeps the status in its own words
status: accepted
date: 2026-10-13
amended: 2026-10-21
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

## Amendment of 2026-10-21 — a refusal the plugin wrote is shown; the callback's description is not

The Miro plugin refused a token without its scopes with a sentence of its
own ("the token lacks the scope(s) boards:read, boards:write; give the app
…"), thrown as an `UpstreamAuthError`: the connect page showed "the provider
rejected the credential (HTTP 403)", and the person had no way to know what
to fix (product owner, 2026-10-20). The rule hid text the plugin wrote, not
only text the provider sent.

1. **`CredentialRefusal`** (`@vaubaan/shared`, re-exported by the plugin
   SDK) is an `UpstreamAuthError` whose message the **plugin** authored. It
   is the one exception `providerFailureReason` keeps as it is (one line, at
   most 300 characters): on the connect page (`ConnectError.detail`), in the
   discovery state, the audit and the logs. Everything that reads a rejected
   credential (refresh, "needs reconnecting") reads it the same way, since it
   is an `UpstreamAuthError`.
2. **The plugin's rule**: the message is a sentence the plugin wrote, with
   at most values the person typed or identifiers the plugin checked (a
   scope name, an organisation slug). Never text the provider sent, never a
   part of the credential. Anything quoted from the provider stays in a plain
   `UpstreamAuthError`, which the gateway reduces to its status as before.
   Plugins that throw it today: Fly (a token of another organisation, image
   prefixes, a token Fly does not describe), Notion (a personal token where
   an internal connection's is needed), Miro (Miro refusing its MCP server to
   an account: ADR miro-rewraps-the-official-mcp-server).
3. **Two leaks of the OAuth callback closed on the way.** A denial at the
   provider kept `error_description` in the detail, and a refused code
   exchange kept the token endpoint's message (`error_description`
   included): both are provider text. The denial now shows the protocol
   code alone (`<service>: access_denied`), the failed exchange
   `providerFailureReason` ("the token endpoint answered HTTP 400
   (invalid_grant)"). A refused dynamic client registration (ADR
   oauth-client-registered-by-the-gateway) follows the same rule: status and
   protocol code.

Rejected: a flag on `UpstreamAuthError` ("this message is safe"). A class
is what a reviewer greps for and what a test can assert; a flag is set by
habit.

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
