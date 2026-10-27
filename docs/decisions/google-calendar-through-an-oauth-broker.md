---
title: Google Calendar is Google's official MCP server, reached with a token from an OAuth broker the instance is enrolled with; other calendars are a generic CalDAV plugin
status: accepted
date: 2026-10-24
author: Renaud Pelissier (product owner), drafted with Claude
amends:
  - gmail-over-imap-with-an-app-password
  - plugin-contract-and-credential-spec
extends:
  - rewrap-official-mcps
  - miro-rewraps-the-official-mcp-server
---

# Google Calendar is Google's official MCP server, reached with a token from an OAuth broker the instance is enrolled with; other calendars are a generic CalDAV plugin

> Decided by the product owner on 2026-10-24, the same day as
> [gmail-over-imap-with-an-app-password](gmail-over-imap-with-an-app-password.md).
> Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §0 "Connection", §5, §7.2.
> Handbooks to write when it lands: `providers/caldav.md`,
> `providers/google-calendar.md`; [connections](../handbook/connections.md).

## Context

The product owner asked for calendars after mail: a plugin on the open
calendar standard, and Google Calendar. The open standard is **CalDAV**
(RFC 4791), events in iCalendar (RFC 5545); iCloud, Fastmail, Nextcloud, Zimbra
or SOGo accept a username and an app password over it.

Google does not. Its CalDAV server, its Calendar REST API and its Calendar MCP
server authenticate OAuth 2.0 only; Basic authentication, app passwords
included, gets `401` (Google, "CalDAV API Developer's Guide"). The app-password
way chosen for Gmail has no Calendar equivalent. Neither has the per-instance
OAuth client: Google accepts no wildcard redirect URI and no dynamic client
registration — its MCP servers expose no `/register` either — which is exactly
the `redirect_uri_mismatch` that made Gmail leave OAuth, and ADR
[gmail-over-imap-with-an-app-password](gmail-over-imap-with-an-app-password.md)
D3 removed the administrator-declared OAuth client from the gateway.

Google publishes an **official remote MCP server for Calendar**,
`https://calendarmcp.googleapis.com/mcp/v1` (Developer Preview), with nine
tools: `list_calendars`, `list_events`, `search_events`, `get_event`,
`suggest_time`, `create_event`, `update_event`, `delete_event`,
`respond_to_event`. It authenticates a Google access token issued to an OAuth
client whose project enables the service. It is the server Claude reaches with
Anthropic's own verified client; a person's Claude connection cannot be reused
elsewhere. The gateway already rewraps official MCP servers where they carry
the service better than its REST API (ADRs [rewrap-official-mcps](rewrap-official-mcps.md),
[miro-rewraps-the-official-mcp-server](miro-rewraps-the-official-mcp-server.md)).

What makes Calendar different from Gmail is Google's classification of its
scopes. Calendar scopes are **sensitive**, not **restricted**: one OAuth client
that serves many instances needs Google's app verification (verified domain,
privacy policy, demo, scope justification), free and done once, but **not** the
yearly third-party security assessment (CASA) that Gmail's restricted scopes
require. One verified client, with one fixed redirect URI, is affordable —
provided its secret and its refresh tokens live with whoever registered it,
never in the instances (no shared secret ships inside an instance).

## Decision

### D1 — An OAuth broker is a service the instance is enrolled with

An **OAuth broker** is a service outside the gateway that owns an OAuth client
at a provider (its id, its secret, its one redirect URI) and runs the
authorization-code flow on behalf of the instances enrolled with it. The
gateway is a **client of a broker**, never a broker, and knows nothing of who
operates it. An instance is enrolled by configuration: `oauth_brokers.<name>.url`
and a broker key (`oauth_brokers.<name>.key`, secret, file or environment like
every secret of the configuration). Without a broker configured, a plugin that
needs one is listed as not configured, with the reason.

### D2 — The contract between the gateway and a broker

HTTPS, JSON, the broker key as a Bearer on every call. Four calls, and the
browser's way back between the first two:

| Call                                                       | Does                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /flows` `{provider, scopes, return_url, challenge}`  | Starts a flow. `return_url` is `<public_url>/connections/callback/<plugin>` and must be one the broker has on record for this instance; `challenge` is the S256 of a verifier the gateway keeps in its pending flow. Answers `{authorize_url}`: the provider's page, with the **broker's** redirect URI. |
| browser → provider → broker → `return_url?grant=…&state=…` | The broker receives the code, exchanges it with its secret, keeps the refresh token, and sends the browser back with a one-time `grant` (single use, minutes-long). The gateway checks `state` as for any flow (bound to the session, single use, minted for this plugin).                               |
| `POST /grants/redeem` `{grant, verifier}`                  | Answers `{grant_id, access_token, expires_at, account, scopes}`. A grant redeemed twice, late, by another instance or with the wrong verifier is refused.                                                                                                                                                |
| `POST /grants/<grant_id>/token`                            | A fresh access token for the same grant: the gateway's refresh.                                                                                                                                                                                                                                          |
| `DELETE /grants/<grant_id>`                                | Revokes at the provider and forgets the grant: what revoking the connection does (ADR [provider-side-revocation-on-connection-revoke](provider-side-revocation-on-connection-revoke.md)).                                                                                                                |

The gateway stores the `grant_id` and the current access token, encrypted as
any credential; it never holds the provider's refresh token or the client
secret. Provider data does not transit the broker: the plugin calls the
provider — here, Google's MCP server — with the access token.

### D3 — The SDK's `oauth2` spec names a broker as its client source

An `oauth2` spec declares exactly one source for its client: `clientRegistration`
(the gateway registers itself, Miro) **or** `broker: { provider }` (the client is
the broker's, Google). This amends D3 of [gmail-over-imap-with-an-app-password](gmail-over-imap-with-an-app-password.md),
which made `clientRegistration` mandatory: the administrator-declared client
stays removed. The host runs the brokered flow; the plugin receives an access
token as for any `oauth2` credential and never sees a grant id or a broker key.

### D4 — `google-calendar` rewraps Google's Calendar MCP server

`@vaubaan/plugin-google-calendar` ("Google Calendar") relays the tools of
`https://calendarmcp.googleapis.com/mcp/v1`, the access token of a brokered
`oauth2` credential as its Bearer, the way the Miro plugin relays Miro's
server. The scopes asked are the narrowest that cover the tools it exposes —
`calendar.calendarlist.readonly`, `calendar.events.readonly`,
`calendar.events.freebusy`, and `calendar.events` for the writing tools — never
the full `calendar` scope. The plugin keeps what makes it a Vaubaan plugin: its
own tool names (`google-calendar__*`), its data model (a calendar is a
resource, discovered with `list_calendars`), its classifier and its own risk
catalog (`google-calendar.*`), modelled before code with the provider-modeler
from the published tool schemas. Upstream tools the classifier does not know are
not listed and refused; a tool Google changes is caught by a schema check
against `tools/list`, as for Miro.

### D5 — `caldav` is the generic plugin for every other calendar server

`@vaubaan/plugin-caldav` ("CalDAV Calendar"): SDK kind `api-key`, fields server
URL, username, app password; discovery by `PROPFIND` (principal, calendar home,
calendars); tools for listing calendars, listing and reading events in a time
range (`REPORT calendar-query`), creating, updating and deleting an event
(`PUT` / `DELETE` with `If-Match`). It needs no broker. It does not reach Google,
which refuses Basic authentication. Its risk catalog is modelled before code.

The two plugins share no transport: one speaks CalDAV, the other relays an MCP
server. They may share the classifier's vocabulary of a calendar (time ranges,
attendees inside or outside the company, events created versus changed) so that
a mission reads the same on both; that is settled when their catalogs are
modelled.

## Consequences

### Positive

- Google Calendar connects in one click for the person, with no Google Cloud
  project and no redirect URI per instance; a public URL change breaks nothing.
- The Google tools are Google's, maintained by Google; the gateway writes a
  classifier and a relay, not a calendar client. `suggest_time` and
  `respond_to_event` come with them, which CalDAV does not offer at Google.
- Narrow scopes: reading the calendar list and events, free/busy, and events
  for the writes — not the full calendar scope CalDAV would have needed.
- No client secret and no refresh token ever sit in an instance: a leaked
  instance store yields short-lived access tokens and grant ids its broker can
  revoke.
- One broker contract serves every future provider in the same situation (no
  key a person can make, no dynamic registration), sensitive scopes first —
  Google Drive's official MCP server among them, for its non-restricted scopes.
- Every CalDAV server is reachable with the generic plugin, by an app
  password, without a broker.

### Negative / constraints

- **Google Calendar needs a broker.** A self-hosted instance enrolled with none
  cannot connect Google Calendar; the generic plugin does not reach Google.
- **Developer Preview.** Google's MCP server may change its tools, their
  arguments or its terms; the plugin follows, and the schema check fails loudly
  rather than relaying an unknown shape.
- **The broker is a dependency at refresh time**: a broker down means Google
  Calendar calls fail once the current access token expires (an hour), and the
  connection shows the broker's failure, not an expiry.
- **The broker sees who connects what** (account, provider, scopes, the
  instance), even though calendar data does not transit it.
- **The broker's Google project must enable the Calendar MCP service** and
  keep its verification valid; a lapsed verification shows Google's
  unverified-app screen to everyone.
- **Two calendar plugins with different shapes**, not one generic plugin under
  a Google overlay as first asked: the Google side is a relay, the generic side
  a CalDAV client.
- A new SDK client source, a new configuration section and a new callback
  parameter (`grant`) to maintain beside the registered-client flow.

## Rejected alternatives

### `google-calendar` as an overlay of the CalDAV plugin

The first shape asked for: the same CalDAV transport pointed at
`apidata.googleusercontent.com/caldav/v2/`, Bearer instead of Basic. It shares
code with the generic plugin, but needs the full `calendar` scope, lacks
`free-busy-query` and `MKCALENDAR` at Google, and makes the gateway maintain a
calendar client against Google's quirks where Google maintains tools of its
own. Dropped once Google's MCP server was weighed, at the product owner's
request.

### Google's Calendar REST API

Narrow scopes too, and stable (not a preview), but every tool to write and
maintain by the gateway, where the MCP server gives them. May be revisited if
the MCP server leaves preview badly or is withdrawn.

### One Google OAuth client per instance

The way Gmail left: no wildcard redirect, no dynamic registration, a client to
register by hand at the exact public URL and to fix whenever it changes.

### Basic authentication with an app password over CalDAV

Refused by Google: `401` on anything but OAuth 2.0.

### A Google Apps Script web app in the person's own account

The person deploys a script that holds their Calendar authority and gives the
gateway its URL and a shared secret: no OAuth flow at the gateway, read and
write. Rejected: a script with full calendar authority behind a public URL,
Workspace administrators commonly forbid "anyone" deployments, Apps Script
quotas, and a template the person must audit and redeploy on every change.

### A service account the calendar is shared with

Least privilege (only the calendars explicitly shared), no delegation, works
for personal accounts. Rejected: a Google Cloud project, a service account and a
JSON key per company, key creation forbidden by default in recent
organizations, and no invitations to attendees without domain-wide
delegation.

### The secret address in iCal format (read-only)

A pasted secret URL, no OAuth: read-only, cannot create an event, and often
disabled by Workspace administrators. Too little for an agent that schedules.

### Gmail through the same broker and Google's Gmail MCP server

Gmail's scopes are restricted: a broker's client would need the yearly CASA
assessment, and Google's Limited Use rules on restricted data handed to
instances the broker does not operate are not settled. Gmail stays on IMAP
(ADR [gmail-over-imap-with-an-app-password](gmail-over-imap-with-an-app-password.md)).

## Amendment of 2026-10-27 — D1 to D4 implemented

What the implementation settled where the decision left it open, and where it
reads the decision's words precisely. Handbooks:
[oauth-broker-contract](../handbook/oauth-broker-contract.md) (the contract,
for whoever builds a broker), [connections](../handbook/connections.md),
[configuration](../handbook/configuration.md) "OAuth brokers",
[providers/google-calendar](../handbook/providers/google-calendar.md).

- **Which broker serves a plugin (D1).** `oauth_brokers.<name>` takes an
  optional `providers` list. A plugin's `broker.provider` is served by the
  broker that lists it, else by the **default broker** — the one without
  `providers` —, else by none (the plugin is listed as not configured, with
  the reason). At most one default broker, and one broker per provider: a
  configuration error otherwise. The simplest enrollment is one broker and
  no list. Rejected: naming the block after the provider
  (`oauth_brokers.google`), which ties one broker to one provider; a list of
  brokers tried in turn, which makes the grant's home ambiguous.
- **`POST /flows` carries `state` (D2).** The browser comes back on
  `return_url?grant=…&state=…`, and the broker can only give back a `state`
  it was given: the call carries the gateway's `state` beside the four named
  fields, and `challenge_method: "S256"`. A grant is redeemed, refreshed and
  revoked at the broker that issued it, by name (kept in the sealed
  credential beside the access token, never handed to the plugin).
- **Errors and lifetimes (D2).** The contract fixes the error codes:
  `invalid_grant` on redeem (twice, late, another instance, wrong verifier —
  one answer), `grant_not_found` / `grant_revoked` on refresh (the connection
  is then `expired`); anything else — a bad key, a broker down, slow or
  refusing — is the broker's failure and changes no connection. `DELETE
/grants/<id>` answers 204, also for a grant already gone.
- **Tool names (D4).** The SDK writes a tool prefix with `_` for `-`
  (`toolPrefixFor`): the tools are `google_calendar__*`, as Cloudflare DNS's
  are `cloudflare_dns__*`.
- **`list_calendars` (D4)** is answered by the gateway from the mission's
  calendars (Google's lists the whole account); discovery calls Google's.
  The eight other tools are relayed.
- **The catalog (D4)** zones the people a call invites inside or outside the
  company by the calendar's `internal_domains`, as Gmail zones recipients,
  and makes a change or a deletion that lets Google email the event's current
  guests a permission of its own (`notify-guests`), since who they are is not
  known before the call. Ten risks, presets `read-only` and `assistant`.
- **The tool list** is modelled from Google's reference (Context7,
  2026-10-27), not captured: the open point below stands.

## Open points

- The broker's own design (enrollment of an instance, its record of return
  URLs, its key rotation) belongs to whoever operates one; the gateway only
  fixes the four calls above. A contract test kit (a fake broker) ships with
  the gateway's tests.
- Whether Google's verification of the broker's client asks for API calls to
  go through the broker: if it does, D2 gains a proxy call and the plugin calls
  the broker instead of Google.
- The upstream argument schemas are read from `tools/list` with a signed-in
  account; the catalog is modelled from Google's published reference until one
  is available.

## References

- Google: "MCP Reference: calendarmcp.googleapis.com"
  (developers.google.com/workspace/calendar/api/v3/reference/mcp); "Configure
  the Calendar MCP server" (developers.google.com/workspace/calendar/api/guides/configure-mcp-server);
  "CalDAV API Developer's Guide" (developers.google.com/workspace/calendar/caldav/v2/guide);
  "Transition from less secure apps to OAuth"
  (knowledge.workspace.google.com/admin/sync/transition-from-less-secure-apps-to-oauth).
- RFC 4791 (CalDAV), RFC 5545 (iCalendar), RFC 7636 (PKCE).
- ADRs: [gmail-over-imap-with-an-app-password](gmail-over-imap-with-an-app-password.md),
  [miro-rewraps-the-official-mcp-server](miro-rewraps-the-official-mcp-server.md),
  [rewrap-official-mcps](rewrap-official-mcps.md),
  [oauth-client-registered-by-the-gateway](oauth-client-registered-by-the-gateway.md),
  [plugin-contract-and-credential-spec](plugin-contract-and-credential-spec.md),
  [provider-side-revocation-on-connection-revoke](provider-side-revocation-on-connection-revoke.md).
