---
title: Google Calendar provider plugin
tracks:
  - plugins/google-calendar/src/
  - plugins/google-calendar/package.json
last_reviewed: 2026-10-31
---

# Google Calendar provider plugin — handbook

`@vaubaan/plugin-google-calendar`: a rewrap of Google's Calendar MCP server
(`https://calendarmcp.googleapis.com/mcp/v1`, Developer Preview), called with an access token from
the OAuth broker the instance is enrolled with
([google-calendar-through-an-oauth-broker](../../decisions/google-calendar-through-an-oauth-broker.md),
[oauth-broker-stateless-in-an-attested-enclave](../../decisions/oauth-broker-stateless-in-an-attested-enclave.md),
[broker contract](../oauth-broker-contract.md)). One resource per calendar; no environment. Rules
common to every plugin: [providers README](README.md).

## Start here

- [`src/call.ts`](../../../plugins/google-calendar/src/call.ts) — `readCalendarCall`, shared by
  classify and execute.
- [`src/classify.ts`](../../../plugins/google-calendar/src/classify.ts) — guest zoning, the
  notification marker.
- [`src/execute.ts`](../../../plugins/google-calendar/src/execute.ts) — one `tools/call` per call
  through the SDK's MCP client (`GOOGLE_CALENDAR_MCP_SERVER`); discovery and the drift check.
- [`src/upstream-tools.json`](../../../plugins/google-calendar/src/upstream-tools.json) — the
  modelled tool list.

## Invariants

- **Who is invited decides the risk**: each attendee must parse as exactly one address (Gmail's
  rules); each zone present emits its marker, so a colleague and a customer need both
  `invite-internal` and `invite-external`. Rooms (`…@resource.calendar.google.com`) are internal; a
  calendar without `internal_domains` treats everyone as external.
- **An update or delete emails the current guests** unless `notificationLevel: NONE`
  (`NOTIFICATION_LEVEL_UNSPECIFIED` means `ALL`, `EXTERNAL_ONLY` still emails outsiders). The guests
  are unknown before the call, so without `NONE` it adds `notify-guests`.
- One risk per write slice, not layered: deleting does not need `event-change`.
- `list_calendars` is answered by the gateway from the mission's calendars; Google's (every calendar
  of the account) serves discovery only.
- A calendar ref is its id with `@` written `~`; calendars whose id holds a `#` (holidays,
  birthdays, contacts) are not discovered. The executor sends the id, never the ref.
- A tool Google adds is not offered: `tools.ts` refuses to load an unmodelled tool.

## Traps

- **The tool list is modelled, not captured** (`captured_at: null`): the endpoint answers 401
  without a token. Read from Google's "MCP Reference: calendarmcp.googleapis.com" via Context7
  (2026-10-27). Discovery compares the live `tools/list` and logs the drift.
- `search_events` searches the primary calendar only, whatever `calendarId` says.
- A session is initialized only if Google answers 400 or 404 to a bare request (not observed yet;
  the SDK client's default session mode). A JSON-RPC error frame, or `list_calendars` answering
  `isError` at discovery, is an `UpstreamProtocolError` (HTTP 502 for the host), never a plain
  `Error`.
- Google's deprecated `eventTypeFilter`, `attendeeEmails`, `addedAttendeeEmails` are not offered.

## Outside the repo

- Nothing to paste and no Google Cloud project per instance: the broker serving `google`
  (`oauth_brokers`, [configuration](../configuration.md)) holds the client. Without one the plugin
  is listed as not configured, with the reason.
- The broker keeps no token: the refresh token is the instance's, sealed, presented at each
  refresh. A broker whose measurement the release does not admit fails with "no attested
  broker version admitted by this release" (or declare the broker `attestation: none`).
- Four scopes, never the full `calendar` scope: `calendar.calendarlist.readonly`,
  `calendar.events.readonly`, `calendar.events.freebusy`, `calendar.events`.
- Discovery seeds `internal_domains` with the account's domain unless it is a consumer one; the
  owner edits it on the account page.

## Procedures

- **Capture the tool list** once an account is connected: replace `src/upstream-tools.json` with a
  captured `tools/list`, set `captured_at`, run the tests, bump the version.

## Debug

- 403 at discovery, "A Google Workspace administrator may have to allow the app or the Calendar MCP
  server" → the Workspace admin allows them.
- "Google did not grant every access asked for (missing: …)" at discovery → with granular consent
  the person unticked a box; Google still issued the token. Reconnect and tick every box. Checked
  against the scopes the broker reports at redeem; an empty list is "not reported", never refused.
- "Connected, but … failed (Error)" with every scope granted → Google answered `isError` to
  `list_calendars`; its text stays with the agent (ADR provider-error-text-stays-with-the-agent),
  so read the `calendarmcp.googleapis.com` metrics of the broker's Google Cloud project.
- A call refused for an attendee → one bare address per element, no display name in the string.
