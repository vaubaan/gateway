---
title: Outlook plugin
tracks:
  - plugins/outlook/src/
  - plugins/outlook/tests/unit/
  - plugins/outlook/package.json
last_reviewed: 2026-11-05
---

# Outlook plugin — handbook

`@vaubaan/plugin-outlook`: mail and calendar of one Microsoft 365 or Outlook.com account, its own 23
tools on Microsoft Graph v1.0 (`https://graph.microsoft.com/v1.0`), called with an access token from
the OAuth broker's `microsoft` provider
([outlook-through-the-oauth-broker-microsoft-provider](../../decisions/outlook-through-the-oauth-broker-microsoft-provider.md),
[broker contract](../oauth-broker-contract.md)). One resource per account, the account's
mailbox; no environment. Mail is Gmail's zoning model, the calendar Google Calendar's. Rules
common to every plugin: [services README](README.md).

## Start here

- [`src/call.ts`](../../../plugins/outlook/src/call.ts) — `readOutlookCall`, shared by classify and
  execute: mailbox, identifiers, addresses, zones, argument rules.
- [`src/classify.ts`](../../../plugins/outlook/src/classify.ts) — the slice table in its header.
- [`src/mail.ts`](../../../plugins/outlook/src/mail.ts), [`src/calendar.ts`](../../../plugins/outlook/src/calendar.ts)
  — the requests; [`src/graph.ts`](../../../plugins/outlook/src/graph.ts) — the one request helper.

## 1. Data model

| Plane      | Root                      | Below                                                                                                   |
| ---------- | ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `mail`     | `mailbox[<ref>]`          | `folder`, `message` → `attachment`, `draft`; markers `from-zone`, `to-zone`, `send-zone`, `bulk-marker` |
| `calendar` | `calendar[default\|<id>]` | `event` → `delete`, `response`, `notify`; marker `guests`                                               |
| `calendar` | `free-busy`               | —                                                                                                       |

Every mail slice names the mission resource. Calendars are not resources: one account usually has
one, shared calendars are reached by id; the calendar slice binds the calendar, and the mission's
single mailbox binds the account. No sensitive-label marker in this version (Outlook categories
could play that part later).

## 2. Tool → slice mapping

`m` the mailbox ref, `c` `default` or a calendar id; `z` a zone.

| Tool                                 | Slices                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `describe_zones`                     | `mailbox[m].R`                                                                              |
| `list_folders`                       | `mailbox[m].folder[*].R`                                                                    |
| `search_messages`                    | `mailbox[m].message[*].R` + `from-zone[z].R` (+ `bulk-marker.R`) (+ `draft[*].R` in Drafts) |
| `get_message`                        | `mailbox[m].message[id].R` + `from-zone[unknown].R`                                         |
| `list_attachments`, `get_attachment` | `mailbox[m].message[id].attachment[*\|a].R` + `from-zone[unknown].R`                        |
| `list_drafts`                        | `mailbox[m].draft[*].R`                                                                     |
| `create_draft`, `create_reply_draft` | `mailbox[m].draft.W` + `to-zone[z].W`                                                       |
| `send_message`, `send_draft`         | `mailbox[m].send-zone[z].W`                                                                 |
| `move_message`, `update_message`     | `mailbox[m].message[id].W`                                                                  |
| `create_folder`                      | `mailbox[m].folder.W`                                                                       |
| `list_calendars`                     | `calendar[*].R`                                                                             |
| `list_events`, `search_events`       | `calendar[c].event[*].R`                                                                    |
| `get_event`                          | `calendar[c].event[e].R`                                                                    |
| `suggest_time`                       | `free-busy.R`                                                                               |
| `create_event`                       | `calendar[c].event.W` (+ `guests[z].W`)                                                     |
| `update_event`                       | `calendar[c].event[e].W` + `event[e].notify.W` (+ `guests[z].W`)                            |
| `delete_event`                       | `calendar[c].event[e].delete.W` + `event[e].notify.W`                                       |
| `respond_to_event`                   | `calendar[c].event[e].response.W`                                                           |

## 3. Catalog and macro-actions

27 named risks + `outlook.uncategorized-write`; no risk env-scoped. Six macro-actions: `read` (every
mail read, `calendar-list`, `event-read`, `free-busy-read`), `draft` (`draft-write` + three draft
zones), `send` (four send zones), `tidy` (`message-organize`, `folder-create`), `schedule`
(`event-create`/`change`/`delete`/`respond`), `invite` (`invite-internal`, `invite-external`,
`notify-guests`). Vectors and base budgets are Gmail's and Google Calendar's; at Trusting,
`send-to-zone-external`, `invite-external` and `notify-guests` ask first (irreversible, public).

## 4. Coverage

Every tool reaches a named risk; none reaches the fallback (`plugin.test.ts`: `fallbackHits` and
`risksUntouched` empty, all 27 touched).

| Risk                                            | Tools                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `read-mailbox`                                  | describe_zones, list_folders, search, get/list attachments, get_message        |
| `read-from-zone-*`                              | search_messages (zone of its one sender), get_message, attachments (`unknown`) |
| `read-drafts`                                   | list_drafts, search_messages in Drafts                                         |
| `bulk-read`                                     | search_messages without exactly one from:                                      |
| `draft-write`, `draft-to-zone-*`                | create_draft, create_reply_draft                                               |
| `send-to-zone-*`                                | send_message, send_draft                                                       |
| `message-organize`                              | move_message, update_message                                                   |
| `folder-create`                                 | create_folder                                                                  |
| `calendar-list`, `event-read`, `free-busy-read` | list_calendars; list/search/get_event; suggest_time                            |
| `event-create`/`change`/`delete`/`respond`      | create_event; update_event; delete_event; respond_to_event                     |
| `invite-internal`, `invite-external`            | create_event, update_event (by attendee zone)                                  |
| `notify-guests`                                 | update_event, delete_event (always)                                            |

## 5. Edge cases

- **`get_message` is a read from an unknown sender**, always, as Gmail's `get_thread`: the sender is
  known only after the fetch. Attachments too (names and contents are anyone's text).
- **A search is bounded only by exactly one `from:<address>`**; then every message returned is that
  sender's: Graph filters it (`$filter`), or, after a full-text `$search`, the executor drops the
  others (`holdsQuery`, also applied after `$filter` as a second lock). Anything else is
  `from-zone[unknown]` + `bulk-marker`. The grammar is closed: OR, negation, quotes, parentheses,
  wildcards, KQL operators (`AND`, `OR`, `NOT`, `NEAR`) and unknown operators are refused, so the
  `$search` value is a list of plain words inside one pair of quotes.
- **`$search` and `$filter` are never combined**: Graph documents no such combination on messages
  and says unsupported combinations "might fail silently". A `$filter` always starts with
  `receivedDateTime ge …` (1900-01-01 without `after:`) so `$orderby=receivedDateTime desc` holds
  (`InefficientFilter` otherwise).
- **A reply draft's recipients are replaced by the declared ones**: `createReply`/`createReplyAll`
  prefill recipients unknown before the call, so a PATCH sets `toRecipients`/`ccRecipients` to the
  declared lists and `bccRecipients` to empty. If the PATCH fails, the new draft is deleted and
  the failure thrown: no draft is left with recipients the call was not priced on.
- **`send_draft` is compared with the stored draft**: priced on the declared recipients, it reads
  the draft (`isDraft`, the three recipient lists) and refuses, unsent, any difference.
- **Writes return no content**: Graph answers a PATCH, a move and a reply draft with the whole
  message, body (and the quoted original) included; the executor returns ids and recipients only,
  so a write never reads mail its permission did not price.
- **`notify` on every update and deletion**: Graph has no `sendUpdates` switch; Exchange mails the
  attendees of a meeting the account organises. The attendees are unknown before the call, so the
  classifier always adds `event[e].notify.W`.
- **A move to Deleted Items is refused**: `deleteditems`, `recoverableitemsdeletions`,
  `junkemail` and `outbox` by name in the classifier; a folder id is checked in the executor
  against their ids and walked up its parents (10 levels, deeper refused). No delete tool exists.
- **Immutable ids**: every request sends `Prefer: IdType="ImmutableId"` (a message id otherwise
  changes when it moves); message and event reads add `outlook.body-content-type="text"`.
- **Consumer domains are not internal**: discovery seeds `internal_domains` with the account's
  domain unless it is `outlook.com`, `hotmail.*`, `live.*`, `msn.com` or a common free-mail domain
  (a personal Microsoft account may use a Gmail address).
- **403 is not 401**: a 401 is a rejected token (the host refreshes through the broker and
  retries); Graph's 403 (`ErrorAccessDenied`, a tenant policy, a mailbox not licensed) is reported
  as an upstream failure and never expires the account (upstream stage). 429 carries
  `Retry-After`.
- **No revocation at Microsoft**: the broker's `/revoke` for `microsoft` calls nothing (Microsoft
  has no endpoint for one refresh token; `revokeSignInSessions` would sign the person out
  everywhere). The gateway erases its copy; `manualRevocation` tells the person where to remove
  the app.
- **An address the slice grammar cannot carry** (`alice+ops@…`) makes the mailbox segment `[*]`;
  an id holding `+` or `=` makes its segment `[*]`: classified on every instance, the value sent
  unchanged.

## 6. Credential, discovery, execution, tests

- `oauth2`, `broker: { provider: 'microsoft' }`, eight scopes; `offline_access` is what makes
  Microsoft issue a refresh token. `missingScopes` compares the four Graph permissions only,
  case-insensitively, the `https://graph.microsoft.com/` prefix tolerated; an empty list is "not
  reported".
- Discovery: `GET /me?$select=id,displayName,mail,userPrincipalName` → one resource, ref the
  address (`mail`, else `userPrincipalName`) lower-cased with `@` as `~`; no address → a
  `CredentialRefusal`; 403 → `PROFILE_REFUSED`.
- Execution: one reader (`readOutlookCall`), requests built field by field; bodies are sent as
  `{ contentType: 'Text' }`, recipients as `{ emailAddress: { address } }`; events are addressed
  under their calendar (`/me/calendar/events/{id}`, `/me/calendars/{c}/events/{id}`), never
  `/me/events/{id}`; times are sent and read in UTC. Lists return the first page.
- Tests: see the plugin README; `assertIdentifiersRefused` runs on every sample.

## Identifiers

| Grammar                                      | Accepts                                                    | Lands in                                                    |
| -------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------- |
| `graphId`                                    | `[A-Za-z0-9+=_-]{1,512}` (no `/`, `.`, `%`)                | a path segment, percent-encoded; a slice via `identSegment` |
| `folderRef`                                  | a well-known name (lower-cased) or a `graphId`             | a path segment; `destinationId` in a body                   |
| mailbox                                      | a ref of the mission, or one address mapped to its ref     | the slice root; never a URL (`/me` is used)                 |
| `parseAddress`                               | one bare address, ≤ 320 characters (Gmail's rules)         | JSON bodies; an OData literal (quote doubled)               |
| `instantOf`, `localDateTime`, `timeZoneName` | RFC 3339 with offset; local date-time; Windows/IANA name   | query strings (`URLSearchParams`), JSON bodies              |
| `queryWord`                                  | letters/digits first, then `. _ ' @ -`, not a KQL operator | `$search` inside quotes; client-side checks                 |

Undeclared arguments are refused in classify and in execute (one reader); requests are built
field by field.

## Tools deliberately left out

- `delete_message` and permanent deletion: no deletion of mail is offered.
- `forward`, `reply`, `replyAll`: they send content to recipients unknown before the call; draft,
  then `send_draft`.

- `sendMail` with attachments: no upload path is modelled.
- Mail rules, mailbox settings and automatic replies: posture changes with no risk modelled.
- Other users' and shared mailboxes (`/users/{id}`): one account is one account.
- Calendar sharing and permissions: a change of who can read the agenda, not modelled.
- `event: cancel` with a message: `delete_event` covers it.
- Contacts, To Do, Teams: other services, not asked for.

The first two lines are the plugin's `excludedTools` (`identity.ts`), shown on its public page:
`outlook__delete_message`, `outlook__forward_message`, `outlook__reply_message` and
`outlook__reply_all_message`; the other lines name no tool.

## Outside the repo

- The instance is enrolled with a broker whose `providers` include `microsoft`
  (`oauth_brokers.<name>`, [configuration](../configuration.md)); without one, Outlook is listed as
  not configured.
- The broker operator registers one Entra app (any organizational directory and personal accounts,
  platform Web, redirect `https://<public host>/oauth/callback/microsoft`, delegated `User.Read`,
  `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`), with publisher verification
  ([broker contract](../oauth-broker-contract.md), "Outside the repo").
- A tenant whose consent policy blocks user consent needs an administrator's consent once.
- Service facts read through Context7 (`/microsoftgraph/microsoft-graph-docs-contrib`, 2026-11-05):
  concepts `auth-v2-user`, `permissions-reference`, `outlook-immutable-id`,
  `outlook-create-send-messages`, `search-query-parameter`, `query-parameters`,
  `filter-query-parameter`, `outlook-get-free-busy-schedule`; v1.0 reference `user-get`,
  `user-list-messages`, `message-get`, `user-post-messages`, `message-createreply`,
  `message-createreplyall`, `message-send`, `user-sendmail`, `message-update`, `message-move`,
  `user-list-mailfolders`, `mailfolder` (well-known names), `user-post-mailfolders`,
  `mailfolder-post-childfolders`, `attachment-get`, `message-list-attachments`,
  `user-list-calendars`, `calendar-get`, `calendar-list-calendarview`, `event-get`,
  `user-post-events`, `event-update`, `event-delete`, `event-cancel`, `event-accept`,
  `event-tentativelyaccept`, `calendar-getschedule`, `datetimetimezone`.

## Debug

- "Microsoft did not grant every access asked for (missing: …)" at discovery → the person, or the
  tenant's policy, granted fewer permissions; reconnect, or ask an administrator to consent.
- "Microsoft refused to read this account (User.Read)" → an administrator must consent, or the
  tenant blocks the app.
- A call fails with HTTP 403 `ErrorAccessDenied` → not an expired token: a permission or a mailbox
  policy; the account stays active.
- `InefficientFilter` from Graph → the `$filter` no longer starts with `receivedDateTime`
  (`filterOf` in `mail.ts`).
- A search returns fewer messages than `top` → the full-text page was narrowed to the other terms
  (`note` in the answer); ask with a larger `top`.
