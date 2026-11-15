---
title: Google Calendar plugin
tracks:
  - plugins/google-calendar/src/
  - plugins/google-calendar/package.json
last_reviewed: 2026-11-02
---

# Google Calendar plugin — handbook

`@vaubaan/plugin-google-calendar`: its own nine tools on Google's Calendar REST API v3
(`https://www.googleapis.com/calendar/v3`), called with an access token from the OAuth broker the
instance is enrolled with
([google-calendar-through-an-oauth-broker](../../decisions/google-calendar-through-an-oauth-broker.md),
[oauth-broker-stateless-in-an-attested-enclave](../../decisions/oauth-broker-stateless-in-an-attested-enclave.md),
[broker contract](../oauth-broker-contract.md)). One resource per calendar; no environment. Rules
common to every plugin: [services README](README.md).

## Start here

- [`src/call.ts`](../../../plugins/google-calendar/src/call.ts) — `readCalendarCall`, shared by
  classify and execute: calendar, event id, attendee zones, argument rules, `sendUpdates` default.
- [`src/execute.ts`](../../../plugins/google-calendar/src/execute.ts) — one REST request per tool
  (two for `update_event` with guests and `respond_to_event`), discovery.
- [`src/tools.ts`](../../../plugins/google-calendar/src/tools.ts) — the tool schemas, ours.

## Invariants

- **Who is invited decides the risk**: each attendee must parse as exactly one address (Gmail's
  rules); each zone present emits its marker, so a colleague and a customer need both
  `invite-internal` and `invite-external`. Rooms (`…@resource.calendar.google.com`) are internal; a
  calendar without `internal_domains` treats everyone as external.
- **An update or delete emails the current guests** unless `sendUpdates: none`; the gateway
  sends `all` when the agent says nothing (`externalOnly` still emails outsiders). The guests are
  unknown before the call, so without `none` it adds `notify-guests`. A response defaults to `none`.
- One risk per write slice, not layered: deleting does not need `event-change`.
- `list_calendars` is answered by the gateway from the mission's calendars; Google's calendarList
  (every calendar of the account) serves discovery only.
- A calendar ref is its id with `@` written `~`; calendars whose id holds a `#` (holidays,
  birthdays, contacts) are not discovered. The path carries the id, percent-encoded, after
  `pathSegment` refused `/ ? # %`.

## Traps

- `respond_to_event` reads the event with `maxAttendees=1` (Google then returns only this
  account's entry), then patches `attendeesOmitted: true` with the `self` entry alone: Google's way
  to change only the participant's answer. Not a guest (an event it organises) → refused.
- `update_event` with `addedAttendees` / `removedAttendeeEmails` reads the event and patches the
  merged list (a patch replaces the whole array); a shortened list (`attendeesOmitted`) is refused.
  A patch of times clears the other form (`date: null` / `dateTime: null`).
- `suggest_time` is computed here ([`free-slots.ts`](../../../plugins/google-calendar/src/free-slots.ts))
  from `POST /freeBusy` for the account (its `account_email`, else `primary`) and up to 49 people
  (`calendarExpansionMax` is 50). A person whose free/busy Google cannot tell (`errors[]`) is
  listed in `availabilityUnknown`, not counted busy. No working-hours preference: narrow the window.
- `search_events` honours `calendarId` (the MCP searched the primary one only); `q` is text match.
- Google's 403 also means a rate limit or `forbiddenForNonOrganizer`: discovery maps those reasons
  to `UpstreamHttpError`, any other 403 to the refusal below (execute never expires on a 403).

## Outside the repo

- No Google Cloud project per instance: the broker serving `google` ([configuration](../configuration.md))
  holds the client, whose project must have the **Calendar API** enabled.
- No Google Workspace Developer Preview membership and no "Use this client for an AI-powered
  agent" flag on the client: both were for the hosted MCP server (0.3.0), no longer prerequisites.
- Two scopes, never the full `calendar` scope: `calendar.calendarlist.readonly` and
  `calendar.events` (which covers events and freeBusy). The broker's allowlist holds these two only
  (broker 0.2.2).
- Discovery seeds `internal_domains` with the account's domain unless it is a consumer one.
- Service facts read through Context7 (`/websites/developers_google_workspace_calendar_api`,
  2026-11-02): reference pages `calendarList/list`, `events/list`, `events/get`, `events/insert`,
  `events/patch`, `events/delete`, `freebusy/query`, the `events` resource (attendees, `self`,
  `responseStatus`, `attendeesOmitted`), guide `errors`.

## Debug

- "Google refused the Calendar API to this account" at discovery → the Calendar API is off in the
  broker's Google Cloud project, or a Workspace admin blocks the app.
- "Google did not grant every access asked for (missing: …)" at discovery → with granular consent
  the person unticked a box; Google still issued the token. Reconnect and tick every box. Checked
  against the scopes the broker reports at redeem; an empty list is "not reported", never refused.
