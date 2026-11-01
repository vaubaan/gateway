# `@vaubaan/plugin-caldav`

**CalDAV Calendar** — the Vaubaan Gateway plugin for calendars on any CalDAV
server: iCloud, Fastmail, Nextcloud and the other servers that speak the
standard (RFC 4791). Connected with a server URL, a username and an **app
password**. Lists calendars and events, reads, creates, changes and deletes
events, under risks zoned by who the attendees are.

**Not for Google Calendar**: Google refuses app passwords over CalDAV. Use the
`google-calendar` plugin.

Handbook (the model and its reasons):
[`docs/handbook/providers/caldav.md`](../../docs/handbook/providers/caldav.md).
ADR: [google-calendar-through-an-oauth-broker](../../docs/decisions/google-calendar-through-an-oauth-broker.md) D5.

## Data model

One plane, `calendar`: an `account` (the principal), its **calendars** (one
resource each, labelled by the owner), their **events** (one `.ics` file
each). Two synthetic markers: `attendee-zone[internal|allowlist|external]` on
a write that concerns people other than the account, and `wide-range` on a
read over more than 31 days.

## Credential and resources

| Field        | Example                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------- |
| Server URL   | `https://caldav.icloud.com`, `https://caldav.fastmail.com`, `https://<cloud>/remote.php/dav` |
| Username     | the account's sign-in name, often its e-mail address                                         |
| App password | made for this gateway at the provider; stored encrypted                                      |

Each calendar that stores events is a resource. Its zoning lists —
`internal_domains`, `allowlist_domains`, `allowlist_addresses` — are filled
by the owner on the account's page; until then, everybody but the account is
`external`.

## Tools

| Tool                     | Does                                                           |
| ------------------------ | -------------------------------------------------------------- |
| `caldav__list_calendars` | the calendars of the mission                                   |
| `caldav__list_events`    | events overlapping a time range (at most 366 days, 200 events) |
| `caldav__get_event`      | one event, with its etag                                       |
| `caldav__create_event`   | a new event; attendees are invited by the server               |
| `caldav__update_event`   | change an event the account organizes (`If-Match`)             |
| `caldav__delete_event`   | delete an event or a whole series (`If-Match`)                 |

Events go in and out as JSON fields; the plugin builds the iCalendar itself.

## Catalog

- `caldav.read-calendars` — list the calendars
- `caldav.read-events` — read events over up to 31 days, or one event
- `caldav.read-wide-range` — read over more than 31 days
- `caldav.event-create` — create events
- `caldav.event-change` — change events
- `caldav.event-delete` — delete events
- `caldav.attendees-internal` — notify colleagues (internal domains)
- `caldav.attendees-allowlisted` — notify allowlisted contacts
- `caldav.attendees-external` — notify anybody else
- `caldav.uncategorized-write` — the fallback, reached by no tool

## Macro-actions

| Macro-action | What it covers                               | Risks                                                               |
| ------------ | -------------------------------------------- | ------------------------------------------------------------------- |
| `read`       | Calendars and events, over a wide range too. | `read-calendars`, `read-events`, `read-wide-range`                  |
| `schedule`   | Create, change and delete events.            | `event-create`, `event-change`, `event-delete`                      |
| `invite`     | Invite, update or cancel attendees.          | `attendees-internal`, `attendees-allowlisted`, `attendees-external` |

A creator ticks macro-actions at a trust level (Careful / Trusting / Autonomous,
risk model §4.6); the trust level sets each risk's gate from its vector and
multiplies the base budget. The mission stores the explicit list. Deleting an event and
reaching allowlisted or outside attendees are irreversible: left out at
Careful, they ask first at the other trust levels.

## Tests

```bash
npx vitest run plugins/caldav
```

An in-memory CalDAV server (`tests/unit/fake-caldav.ts`) stands in for the
provider, in memory and once behind a loopback HTTP socket
(`protocol.test.ts`). No test calls a real server.
