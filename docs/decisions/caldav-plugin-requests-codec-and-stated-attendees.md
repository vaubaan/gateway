---
title: The CalDAV plugin sends its own requests through ctx.fetch, writes iCalendar with a codec of its own, and prices a change or a deletion by the people it states
status: proposed
date: 2026-10-27
author: drafted by Claude (coding agent), for the product owner's review
extends:
  - google-calendar-through-an-oauth-broker
---

# The CalDAV plugin sends its own requests through ctx.fetch, writes iCalendar with a codec of its own, and prices a change or a deletion by the people it states

> Implements D5 of
> [google-calendar-through-an-oauth-broker](google-calendar-through-an-oauth-broker.md).
> Handbook: [providers/caldav](../handbook/providers/caldav.md). Spec:
> [vaubaan-gateway](../spec/vaubaan-gateway.md) §5,
> [gateway-risk-model](../spec/gateway-risk-model.md) §7.

## Context

D5 fixed what `@vaubaan/plugin-caldav` is (an `api-key` credential of three
fields, discovery by `PROPFIND`, six tools, a catalog modelled before code)
and left how it is built. Four choices came up that a later maintainer will
ask about:

- **Libraries.** A WebDAV/CalDAV client (`tsdav`) and an iCalendar library
  (`ical.js`, `ts-ics`, `node-ical`) exist. The gateway's contract wants every
  request through the host's `ctx.fetch` (the test kit's `mockFetch` and the
  identifier proof `assertIdentifiersRefused` see only those), the CI audit
  gate fails on advisories, and the repository prefers permissive licences
  and few dependencies.
- **Where the app password may go.** The person types a server URL; the
  server's answers (redirects, principal, calendar home) name further URLs,
  sometimes on another host (iCloud's home is on `p<nn>-caldav.icloud.com`).
- **Who a write notifies.** A scheduling server (RFC 6638) mails the
  attendees of an event the account organizes when it is created, changed or
  deleted, and the organizer of an invitation when its copy is deleted. The
  classifier is pure: for a change or a deletion it cannot read who the event
  already concerns.
- **Calendar refs.** A ref must be a slice identifier; a calendar's address
  may hold `@` (Fastmail puts the account address in the path) or a space.

## Decision

### D1 — Requests through `ctx.fetch`, XML read with `@xmldom/xmldom`, iCalendar by a codec of the plugin

The plugin builds its WebDAV requests itself (`plugins/caldav/src/dav.ts`):
fixed XML bodies, `redirect: 'manual'`, bounded answers. It depends on
**`@xmldom/xmldom`** (MIT, no dependency) to read multistatus answers with
their namespaces resolved; a document type is refused, so no entity is ever
expanded. iCalendar is read and written by a codec of the syntax only
(`ical.ts`: unfolding, content lines, components, escaping, folding), which
keeps every component and property it does not know, so a changed event is
written back with its alarms, `X-` properties and attendees' answers intact.

### D2 — The credential goes to the server's host, or a sibling of it, and nowhere else

A request is built only for the scheme and port of the typed URL, on its
host or on a sibling host under the same parent domain; a parent of two
labels or fewer, an IP literal or a loopback host admits the host alone.
`https` only, `http` for a loopback host. Checked before every request, in
discovery and in execution (a resource's `href` included), so no answer can
send the `Authorization` header elsewhere. A Google URL is refused at the
credential: Google refuses Basic authentication.

### D3 — A change or a deletion states who it concerns; the executor holds it to the server's copy

`create_event` is priced by its `attendees`. `update_event` is priced by
`attendees` (the list after the change) and `removed_attendees`;
`delete_event` by `attendees` (the organizer and attendees `get_event`
listed). The classifier prices the statement as the worst zone of the people
— the account itself `none`, then `internal`, `allowlist`, `external` — and
emits `attendee-zone[<zone>].W`. The executor reads the event before writing
and declines when the people it already concerns (every `ORGANIZER` and
`ATTENDEE` of every `VEVENT`) reach a worse zone than the one priced, when
its etag is not the one the agent read, or, for a change, when somebody else
organizes it. Every write is conditional (`If-None-Match: *`, `If-Match`).

### D4 — A calendar's ref is the last segment of its address, or a digest

The last path segment, decoded, when it is a ref
(`[A-Za-z0-9_~-][A-Za-z0-9_.~-]{0,127}`); otherwise, and when two calendars
share it, `cal-` and 16 hexadecimal digits of the SHA-256 of the path. The
address itself is the resource's `href`, accepted by the executor only when
its ref is the resource's and D2 admits it.

### D5 — Wall-clock times are written with an IANA `TZID` and no `VTIMEZONE`

A time with a `timezone` is written `TZID=<IANA name>` without a
`VTIMEZONE` component (time zones by reference, RFC 7809), an instant in UTC,
a date as `VALUE=DATE`. The plugin never converts a zone.

## Consequences

### Positive

- Every request is visible to the host and the test kit; the identifier
  proof runs on real request paths.
- One small, maintained, permissive dependency; `npm audit` clean.
- A changed event keeps what other clients wrote in it.
- No answer of any server can make the plugin send the app password to a host
  the person did not name.
- What a mission accepts for a write is who the server will mail, checked
  against the server's copy rather than trusted from the agent.

### Negative / constraints

- The plugin maintains its WebDAV requests and its iCalendar syntax codec
  (about 300 lines, unit- and property-tested) instead of a library's.
- Changing only the title of a meeting with outside guests needs the guests
  repeated in `attendees` and the external permission: the guests receive an
  update.
- A recurring series with occurrences changed one by one cannot have its
  time or attendees changed here.
- A server that does not resolve IANA `TZID`s without a `VTIMEZONE` may show
  wall-clock times as floating.
- A sibling host under the same parent domain is trusted with the password:
  a server whose parent domain is shared with strangers would extend that
  trust to them (a two-label parent is refused for this reason).

## Rejected alternatives

### `tsdav` as the CalDAV client

It calls the global `fetch` (the host's injected `fetch`, `mockFetch` and the
identifier proof would not see its requests), follows redirects and builds
URLs itself (D2 would have to wrap it), and depends on `xml-js`, unmaintained
since 2019.

### `ical.js`, `ts-ics` or `node-ical` for iCalendar

`ical.js` is MPL-2.0, not a permissive licence. `ts-ics` (MIT) converts to
typed objects and back, dropping what it does not model when a changed event
is written. `node-ical` reads only and adds two dependencies.

### Pricing a change or a deletion at the worst zone always

Sound, but every change of a private event would need the external
permission; no preset could offer an agenda without invitations.

### Fetching the event inside the classifier

The classifier is pure (spec §7): no network, no credential.

### Converting every time to UTC

Simpler, but a weekly meeting would move by an hour at each change of
daylight saving time.
