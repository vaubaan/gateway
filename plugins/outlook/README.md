# `@vaubaan/plugin-outlook`

Mail and calendar of a **Microsoft 365 or Outlook.com account** for Vaubaan Gateway, through
**Microsoft Graph v1.0** (`https://graph.microsoft.com/v1.0`), with tools of its own. The access
token comes from the **OAuth broker** the instance is enrolled with: the broker owns the Entra app
registration and keeps no token; the instance keeps the refresh token and the current access token.
Mail and calendar data never go through the broker.

Handbook: [`docs/handbook/providers/outlook.md`](../../docs/handbook/providers/outlook.md).
ADR: [`outlook-through-the-oauth-broker-microsoft-provider`](../../docs/decisions/outlook-through-the-oauth-broker-microsoft-provider.md).
Broker contract: [`docs/handbook/oauth-broker-contract.md`](../../docs/handbook/oauth-broker-contract.md).

## Files

| File                    | What                                                                        |
| ----------------------- | --------------------------------------------------------------------------- |
| `src/index.ts`          | `definePlugin`, the default export                                          |
| `src/identity.ts`       | ids, the Graph base URL, the scopes, `Prefer` values, well-known folders    |
| `src/identifiers.ts`    | Graph id, folder, path segment, mailbox ref, times, time zone, free text    |
| `src/address.ts`        | the strict address parser (Gmail's rules)                                   |
| `src/q-parser.ts`       | the closed grammar of `search_messages`                                     |
| `src/zones.ts`          | sender, recipient and attendee zones from the mailbox metadata              |
| `src/data-model.ts`     | the `mail` and `calendar` planes                                            |
| `src/risk-catalog.yaml` | 27 risks + fallback, six macro-actions                                      |
| `src/credential.ts`     | the brokered `oauth2` spec, the granted-permission check                    |
| `src/tools.ts`          | the 23 tool declarations                                                    |
| `src/call.ts`           | the one reader of a call, for classify and execute                          |
| `src/classify.ts`       | slices                                                                      |
| `src/graph.ts`          | the one request helper (`httpJson`, Bearer, `Prefer: IdType="ImmutableId"`) |
| `src/mail.ts`           | the mail tools                                                              |
| `src/calendar.ts`       | the calendar tools                                                          |
| `src/free-slots.ts`     | the free slots of `suggest_time`                                            |
| `src/execute.ts`        | dispatch and discovery                                                      |

## Data model

Two planes of one account. `mail` is rooted at `mailbox[<ref>]` (the resource): `folder`,
`message` → `attachment`, `draft`, and the synthetic markers `from-zone`, `to-zone`, `send-zone`,
`bulk-marker`. `calendar` is rooted at `calendar[default|<id>]`: `event` with the verb leaves
`delete`, `response`, `notify`, the `guests` marker; and `free-busy`. Calendars are not resources.

## Credential and resources

`oauth2` with `broker: { provider: 'microsoft' }`, scopes `openid`, `email`, `profile`,
`offline_access`, `User.Read`, `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`. An
administrator enrolls the instance with a broker that serves `microsoft`
(`oauth_brokers.<name>`, handbook configuration); without one, the plugin is listed as not
configured. Discovery (`GET /me`, not paginated) yields **one resource per connection**, the
account's mailbox: ref `alice~contoso.com` (the address with `@` written `~`), metadata
`account_email`, `internal_domains` (seeded with the account's domain unless it is a consumer one),
`allowlist_domains`, `allowlist_addresses` — the lists the owner edits and the zones are read from.

## Tools

Mail: `outlook__describe_zones` (answered by the gateway), `list_folders`, `search_messages`,
`get_message`, `list_attachments`, `get_attachment`, `list_drafts`, `create_draft`,
`create_reply_draft`, `send_message`, `send_draft`, `move_message`, `update_message`,
`create_folder`. Calendar: `list_calendars`, `list_events`, `search_events`, `get_event`,
`suggest_time`, `create_event`, `update_event`, `delete_event`, `respond_to_event`. Every tool
takes `mailbox` (the single one when omitted); the calendar tools take `calendar` (`default` when
omitted). Lists return the first page only (`top`); `@odata.nextLink` is not followed.

## Catalog

| Risk                                    | What it prices                                                    |
| --------------------------------------- | ----------------------------------------------------------------- |
| `outlook.read-mailbox`                  | folders, message and attachment lists, the zoning                 |
| `outlook.read-from-zone-automated`      | mail from no-reply senders of known domains                       |
| `outlook.read-from-zone-internal`       | mail from colleagues                                              |
| `outlook.read-from-zone-known-external` | mail from allowlisted contacts                                    |
| `outlook.read-from-zone-unknown`        | mail from anyone else, and every read by id                       |
| `outlook.read-drafts`                   | drafts (and a search of Drafts)                                   |
| `outlook.bulk-read`                     | a search not bounded by exactly one sender                        |
| `outlook.draft-write`                   | a draft or a reply draft                                          |
| `outlook.draft-to-zone-self`            | … to the mailbox itself, or to nobody yet                         |
| `outlook.draft-to-zone-internal`        | … to colleagues                                                   |
| `outlook.draft-to-zone-allowlist`       | … to allowlisted contacts (anyone else is refused)                |
| `outlook.send-to-zone-self`             | a send to the mailbox itself                                      |
| `outlook.send-to-zone-internal`         | a send to colleagues                                              |
| `outlook.send-to-zone-allowlist`        | a send to allowlisted contacts                                    |
| `outlook.send-to-zone-external`         | a send to anyone                                                  |
| `outlook.message-organize`              | move (never to Deleted Items, Junk, Outbox), read, flag, category |
| `outlook.folder-create`                 | a new mail folder                                                 |
| `outlook.calendar-list`                 | the calendars of the account                                      |
| `outlook.event-read`                    | events                                                            |
| `outlook.free-busy-read`                | people's free/busy                                                |
| `outlook.event-create`                  | a new event                                                       |
| `outlook.event-change`                  | a change of an event                                              |
| `outlook.event-delete`                  | a deletion                                                        |
| `outlook.event-respond`                 | an answer to an invitation                                        |
| `outlook.invite-internal`               | inviting colleagues                                               |
| `outlook.invite-external`               | inviting anyone else                                              |
| `outlook.notify-guests`                 | Exchange mailing the attendees of every change and deletion       |
| `outlook.uncategorized-write`           | fallback, in no macro-action                                      |

## Macro-actions

A creator ticks macro-actions at a trust level (Careful / Trusting / Autonomous, risk model §4.6);
the trust level sets each risk's gate from its vector and multiplies the base budget. The mission
stores the explicit list. The narratives below are written to move into the YAML (`narrative`)
once the loader accepts the key.

- **`read` — Read mail and agenda.** Every mail read is priced by who sent it: a colleague, an
  allowlisted contact, a notification, or anyone, which is also the price of reading a message by
  its id. A search that does not name exactly one sender is a bulk read. Calendars, events and
  free/busy come with it, because an agenda is read for the same work.
- **`draft` — Draft.** Drafts and reply drafts, priced by their worst recipient: oneself,
  colleagues or allowlisted contacts. A draft to anyone else is refused outright, so nothing can
  be staged for an unknown address. Nothing leaves while it is a draft.
- **`send` — Send.** A message or a stored draft leaves the mailbox, under the owner's name, and
  nothing calls it back. The permission follows the worst recipient, up to anyone at all; a stored
  draft is sent only when it holds exactly the recipients the call declared.
- **`tidy` — Tidy.** Moving messages between folders, marking them read, flagging them, setting
  their categories, and creating folders. Nothing is deleted: a move to Deleted Items, Junk Email
  or the Outbox is refused.
- **`schedule` — Schedule.** Creating, changing and deleting events, and answering invitations.
  Who is invited, and the mail Exchange sends attendees about a change, are the next macro-action.
- **`invite` — Invite.** Inviting colleagues or people outside the company, who receive the
  event by mail. Graph cannot keep Exchange from mailing the attendees of a change or a
  cancellation, so every update and deletion of an event needs `notify-guests` from here too.

## Tests

`npx vitest run plugins/outlook`: the SDK kit (`plugin.test.ts`), the classifier branch by branch
(`classify.test.ts`), the grammars and hostile identifiers on both sides (`identifiers.test.ts`),
the search grammar (`q-parser.test.ts`), the granted permissions (`credential.test.ts`), the mail
and calendar executors and discovery against `mockFetch` (`execute-mail.test.ts`,
`execute-calendar.test.ts`), the free slots (`free-slots.test.ts`). No test calls Microsoft.
