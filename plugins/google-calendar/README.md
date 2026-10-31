# `@vaubaan/plugin-google-calendar`

Google Calendar for Vaubaan Gateway, through **Google's official Calendar MCP
server** (`https://calendarmcp.googleapis.com/mcp/v1`). The access token comes
from the **OAuth broker** the instance is enrolled with: the broker owns the
Google OAuth client and keeps no token; the instance keeps the refresh token
and the current access token, and verifies the broker's attestation before
it sends it anything. Calendar data never goes through the broker.

Handbook: [`docs/handbook/providers/google-calendar.md`](../../docs/handbook/providers/google-calendar.md).
ADRs: [`google-calendar-through-an-oauth-broker`](../../docs/decisions/google-calendar-through-an-oauth-broker.md),
[`oauth-broker-stateless-in-an-attested-enclave`](../../docs/decisions/oauth-broker-stateless-in-an-attested-enclave.md).
Broker contract: [`docs/handbook/oauth-broker-contract.md`](../../docs/handbook/oauth-broker-contract.md).

## Files

| File                       | What                                                                      |
| -------------------------- | ------------------------------------------------------------------------- |
| `src/index.ts`             | `definePlugin`, the default export                                        |
| `src/identity.ts`          | ids, Google's tool and argument names, the MCP URL, the scopes            |
| `src/identifiers.ts`       | calendar id ↔ ref (`@` ↔ `~`), event id, strict address parsing           |
| `src/data-model.ts`        | the `calendar` plane                                                      |
| `src/risk-catalog.yaml`    | 10 risks + fallback, macro-actions `read`, `schedule`, `invite`           |
| `src/credential.ts`        | the brokered `oauth2` spec                                                |
| `src/tools.ts`             | the gateway's declarations, built from `upstream-tools.json`              |
| `src/upstream-tools.json`  | Google's nine tools, modelled from the reference (source and date inside) |
| `src/call.ts`              | the one reader of a call, for classify and execute                        |
| `src/classify.ts`          | slices                                                                    |
| `src/execute.ts`, `mcp.ts` | the JSON-RPC client, execution, discovery, the schema check               |

## Credential and resources

`oauth2` with `broker: { provider: 'google' }`. An administrator enrolls the
instance with a broker (`oauth_brokers.<name>.url` and `.key`, handbook
configuration); without one, the plugin is listed as not configured. One
resource per calendar of the account (ref `alice~acme.example`), with
`internal_domains`, the list that decides who is a colleague.

## Tools

`google_calendar__list_calendars` (answered by the gateway),
`list_events`, `search_events`, `get_event`, `suggest_time`, `create_event`,
`update_event`, `delete_event`, `respond_to_event`. `calendarId` is a calendar
of the mission (ref or id), the primary one when omitted.

## Risks and macro-actions

| Macro-action | What it covers                            | Risks                                                           |
| ------------ | ----------------------------------------- | --------------------------------------------------------------- |
| `read`       | Calendars, events and free/busy.          | `calendar-list`, `event-read`, `free-busy-read`                 |
| `schedule`   | Create, change, delete and answer events. | `event-create`, `event-change`, `event-delete`, `event-respond` |
| `invite`     | Invite people and let Google email them.  | `invite-internal`, `invite-external`, `notify-guests`           |

A creator ticks macro-actions at a trust level (Prudent / Confiant / Autonome,
risk model §4.6); the trust level sets each risk's gate from its vector and
multiplies the base budget. The mission stores the explicit list. Deleting an event asks
first below Autonome; inviting outside the company and notifying guests are
irreversible and never run freely.

## Refreshing the tool list

The list is modelled, not captured (the server answers 401 without a token).
With a connected account, discovery logs any difference with `tools/list`;
replace `src/upstream-tools.json` with the captured list and set
`captured_at`, then run `npx vitest run plugins/google-calendar`.
