---
title: CalDAV Calendar plugin
tracks:
  - plugins/caldav/src/
  - plugins/caldav/package.json
last_reviewed: 2026-10-31
---

# CalDAV Calendar plugin — handbook

`@vaubaan/plugin-caldav`: any CalDAV server (iCloud, Fastmail, Nextcloud…) with a username and an
app password over Basic auth. Not Google: its CalDAV refuses Basic auth, so a Google URL is refused
before anything is sent (that is `google-calendar`). Rules common to every plugin:
[services README](README.md).

## Start here

- [`src/classify.ts`](../../../plugins/caldav/src/classify.ts) — grammars, attendee zoning, shared
  with execute.
- [`src/dav.ts`](../../../plugins/caldav/src/dav.ts) — every request over `ctx.fetch`, the host
  check (`isAllowedTarget`, `isHomeHost`, `pinnedTo`), multistatus.
- [`src/event.ts`](../../../plugins/caldav/src/event.ts) — event views and writes, the checks
  before a write.
- [`src/ical.ts`](../../../plugins/caldav/src/ical.ts) — the iCalendar codec, syntax only.

## Invariants

- **The credential goes only to the host the person typed, and to one pinned home host.** The
  principal and its redirects stay on the typed host; the calendar home the principal announces may
  be a sibling under the same parent domain (`isHomeHost`; iCloud homes live on
  `p<nn>-caldav.icloud.com`), and from then on the discovery is pinned to that host
  (`pinnedTo`): a calendar listed on any other host is skipped. A call is pinned to the host of its
  stored calendar, checked by the same rule. A parent of two labels or fewer, an IP literal or a
  loopback admits the host alone. Checked before every request, redirects included (manual, at
  most five); `https` → `http` is refused. The residue: on a multi-tenant suffix
  (`*.duckdns.org`), the typed server's own principal can still name a stranger's host as its home,
  once, at discovery.
- **Who a write notifies is what is priced**: a server with scheduling mails the attendees. Zones as
  Gmail's (account `none`, `internal`, `allowlist`, anybody else or a non-`mailto:` address
  `external`); the call's zone is the worst of its people. Zone lists are discovered empty: until
  the owner fills them, everyone else is `external`.
- **A change or deletion states the people it concerns** (`attendees`, `removed_attendees`), since
  the pure classifier cannot read the event. The executor reads it first and declines when its
  current people (every `ORGANIZER` and `ATTENDEE` of every `VEVENT`) reach a worse zone, when the
  etag differs from the agent's, or when someone else organizes it (`update_event` only; deleting
  an invitation declines it and is priced by the organizer's zone).
- Every write is conditional: create `If-None-Match: *`, update and delete `If-Match`; a race is the
  server's `412`, thrown.
- Reads return JSON fields, never raw iCalendar; the executor never writes a control character, so a
  field cannot open a new property. Descriptions are untrusted (invitations arrive unasked).

## Traps

- No `tsdav`: it calls the global `fetch` (outside `ctx.fetch`, the test mocks and the identifier
  proof), follows redirects itself (no host check). No `ical.js` (MPL-2.0); `ts-ics` drops
  unmodelled properties on write-back. The one extra dependency is `@xmldom/xmldom`: multistatus
  needs real namespace resolution (any prefix is legal), never a text match.
- The codec never expands a recurrence or converts a time zone: the server filters the range.
- A series with per-occurrence changes (`RECURRENCE-ID`) cannot be retimed or have its attendees
  changed; `delete_event` deletes the whole series.
- Times are written `TZID=<IANA name>` with no `VTIMEZONE` (RFC 7809): iCloud, Fastmail and
  Nextcloud resolve it; another server may show floating times.
- An event with attendees needs an organizer (first `calendar-user-address-set`, else the username
  if it is an e-mail); neither → declined.

## Outside the repo

- App password: iCloud (account.apple.com, Sign-In and Security, App-Specific Passwords; 2FA on;
  `https://caldav.icloud.com`); Fastmail (Privacy & Security, app passwords, "Calendars (CalDAV)";
  `https://caldav.fastmail.com`); Nextcloud (Security, Devices & sessions;
  `https://<cloud>/remote.php/dav`). Menu paths to recheck at the first real account.
- No CalDAV endpoint deletes an app password: revocation is by hand only.

## Debug

- "no CalDAV account answers at …" → no `/.well-known/caldav`: type the documented URL.
- "the server sends the account to a host outside …" → redirect, principal or home on another site,
  or a drop to `http`: type the final URL.
- A calendar is missing → a task list, or shared read-only outside the home; "Refresh" reruns
  discovery.
- `HTTP 403` on a write → read-only or subscribed calendar.
- "the event concerns people the call does not name" → repeat the attendees (and, for a delete, the
  organizer) `get_event` returned.
