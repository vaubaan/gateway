---
title: Miro is reached through Miro's official MCP server, connected by OAuth; the REST app-token way is removed
status: accepted
date: 2026-10-21
author: drafted by the coding agent on the product owner's request of 2026-10-21 ("decide the details yourself, record them in an ADR")
extends:
  - rewrap-official-mcps
  - railway-rewrap-remote-mcp
  - one-place-to-authorize-services-token-first
  - oauth-client-registered-by-the-gateway
---

# Miro is reached through Miro's official MCP server, connected by OAuth; the REST app-token way is removed

## Context

`@vaubaan/plugin-miro` 0.1.0 (2026-10-16) called Miro's REST API v2 with the
access token of a **Miro app** the person created and installed on a team,
pasted by hand — the token-first way of ADR
[one-place-to-authorize-services-token-first](one-place-to-authorize-services-token-first.md).

On 2026-10-20 the product owner tried it at Fiabilis, a Miro Enterprise
organisation that allows **approved apps only**. The app's token came back
with `"scopes": []`, the plugin's check refused it, and the connect page
showed a bare "HTTP 403" (the plugin's own sentence — "the token lacks the
scope(s) boards:read, boards:write" — was hidden by the gateway, see the
amendment of ADR
[provider-error-text-stays-with-the-agent](provider-error-text-stays-with-the-agent.md)).
His verdict: "c'est inutilisable ton plugin miro. je ne veux pas avoir à
créer une app. je veux utiliser directement le serveur MCP de Miro ou son
API".

Miro's REST API has no other way in: every token belongs to an app someone
creates. Miro's **official MCP server** does not need one:

- `https://mcp.miro.com/` (Streamable HTTP) answers `401` with
  `WWW-Authenticate: Bearer resource_metadata=…`; its protected-resource
  metadata (RFC 9728) names itself as the authorization server; that
  server's metadata (RFC 8414) offers `/authorize`, `/token`, **`/register`
  (RFC 7591)**, PKCE S256, the authorization-code and refresh-token grants,
  `client_secret_post` / `client_secret_basic`, and the scopes
  `boards:read boards:write openid email` (all read unauthenticated on
  2026-10-21; a test registration answered `201` with a client id and a
  secret).
- Miro documents it as "OAuth 2.1 with dynamic client registration",
  short-lived access tokens with refresh, a **team chosen on the consent
  page** (one connection reaches one team), and, on the Enterprise plan, an
  administrator switch that enables the MCP server for the organisation —
  which Fiabilis already turned on: its people use Miro's MCP server from
  Claude.
- Its tools (developers.miro.com "Miro MCP Server Tools" and the changelog
  "Legacy MCP board tools have been removed", read 2026-10-21): boards
  (`board_search_boards`, `board_create`), the canvas
  (`canvas_search`, `canvas_read_as_svg`, `canvas_create_from_svg`,
  `canvas_update_from_svg`, two format guides), comments, images,
  prototypes, tables (deprecating soon), `user_who_am_i`. Tools are
  addressed by a **board URL**, an item by the `moveToWidget` parameter of
  that URL. Their argument schemas are not published: `tools/list` needs a
  signed-in account, and none was available to this work.

## Decision

### D1. One way: Miro's MCP server, by OAuth, with a client the gateway registers

The plugin's credential is `oauth2` against Miro's MCP authorization server,
with `clientRegistration` (ADR
[oauth-client-registered-by-the-gateway](oauth-client-registered-by-the-gateway.md)):
`boards:read boards:write` only, PKCE, the MCP server as the resource
indicator (`resource=https://mcp.miro.com/`), `client_secret_post`,
refreshable. Nothing to create, nothing to paste, no administrator step.
Miro publishes no revocation endpoint: the person removes "Vaubaan Gateway
(<host>)" from the apps of their Miro profile (`manualRevocation`).

**The REST way and its app token are removed**, not kept beside: one way per
service, the token-first ADR's rule. Here the simplest way a person has is
OAuth, because the token way does not work in the organisations that most
need governance. Gmail and Miro are the two `oauth2` services shipped.

### D2. Rewrap Miro's tools; the gateway owns the locator

Every offered tool is Miro's, renamed `miro__<name>`, forwarded as one
JSON-RPC `tools/call` (precedents: Vercel, Railway, Context7). One change to
Miro's schema: **the locator**. Miro's tools take the board as a URL
(`miro_url`); the gateway's take **`board`** — a board of the mission, as
its ref (`uXjVOD6LSME~`, ADR
[miro-board-ref-tilde-spelling](miro-board-ref-tilde-spelling.md)) or its
URL (`https://miro.com/app/board/uXjVOD6LSME=/`, https, host `miro.com`
exactly, path of a board, nothing else) — and, where a tool acts on an item,
**`item_id`** (numeric). The executor writes `miro_url` itself from the
classified board and item (`…/board/<id>/?moveToWidget=<item>`); an agent
that sends `miro_url` is refused (undeclared argument). What is classified
is what is sent.

`list_boards` is answered by the gateway from the mission's boards (ref,
name, URL from discovery), without calling Miro: Miro's
`board_search_boards` lists every board the person can open in the team,
beyond the mission's.

Left out, with the reason in the plugin (`LEFT_OUT_UPSTREAM_TOOLS`):
`board_search_boards` (discovery only), `image_get_upload_url` (hands the
agent a presigned upload URL — a credential of its own, spec §2.4),
`user_who_am_i` (the person's own profile; no task needs it).

### D3. The risk model: catalog 2, the ids of catalog 1 kept

- `read-boards` — `list_boards`, now answered locally (metadata only).
- `read-board-content` — every read of a board, comments included.
- `read-format-guide` (new) — the two format guides of the canvas tools:
  Miro's documentation, `format-guide.R`, no board.
- `content-write` — every write under a board, comments included.
- `bulk-create` — `canvas_create_from_svg`, `prototype_create`: many items
  in one call.
- `item-delete`, `frame-delete` — **`canvas_update_from_svg` touches both
  on every call**: it applies an SVG as a diff and deletes what the new
  document no longer holds, frames included, and which items is not known
  before Miro applies it.
- `board-create` (new) — `board_create`, `board.W`, no board; a
  resource-creating tool, so the connection is discovered again after it
  (ADR discovery-runs-after-a-creating-call).
- the fallback.

Presets keep their ids. `scribe` never deletes, so it cannot update what is
drawn (an update may delete) — it adds, fills tables and comments.
`facilitator` adds freely and asks first for every update of what is drawn,
every deletion and every new board.

### D4. The tool list is modelled until it is captured

`plugins/miro/src/upstream-tools.json` is Miro's `tools` array of
`tools/list`. Today it is **modelled** from Miro's documentation
(`captured_at: null`): the tool names are Miro's; the argument names
besides the locator (`query`, `result_mode`, `svg`, `content`,
`comment_id`, `columns`, `rows`…) and the locator's own name (`miro_url`)
are this model's best reading of the documentation, **not verified**. Three
safeguards:

- `npm run capture-upstream-tools --workspace @vaubaan/plugin-miro` signs in
  at Miro (its own throw-away client, loopback redirect, PKCE), runs
  `tools/list` and writes the file verbatim — the refresh procedure, and the
  first thing to run with a Miro account;
- the module refuses to load a list with a tool neither offered nor left out,
  or with an argument whose name looks like a locator (`…url`, `…_id`,
  `board…`) the model does not know: such an argument could aim the call at
  another board than the classified one;
- every discovery compares Miro's live `tools/list` with the model and logs
  the differences, names only ("Miro's MCP tools differ from the plugin's
  model; capture them again").

### D5. Session, failures, discovery

- Whether Miro's server needs an `initialize` first is not documented: a
  request answered `400`/`404` without a session initializes once and is
  sent again with the `Mcp-Session-Id` returned.
- `401`/`403` → `UpstreamAuthError` (the host refreshes, then marks the
  account "needs reconnecting"); another status → `UpstreamHttpError`; a
  JSON-RPC error → Miro's message, to the agent only. Miro's tool result is
  passed through, `isError` included.
- Discovery calls `board_search_boards` and reads boards out of an answer
  whose shape is not documented: an object whose id passes the board grammar
  and whose link (or `type: "board"`) says it is a board, or board URLs in a
  text answer. At most 500 boards. A `403` at that first call — what Miro is
  assumed to answer when the organisation has not enabled its MCP server — is
  a `CredentialRefusal` with the plugin's sentence, shown on the account
  page.

### D6. Version and upgrade

`@vaubaan/plugin-miro` 0.2.0 (before 1.0, a minor for a breaking change).
**Miro accounts connected before the upgrade (`api-key`) run nothing** —
the host refuses an account made a way the plugin no longer offers — **and
are reconnected from Accounts**, where the button now leads to Miro's
consent page. Their missions keep their ids, risks and presets; the tools
they name changed (the 30 REST tools are gone), so an agent reads the new
tool list. The release notes say so.

## Consequences

- A person connects Miro with one click, chooses a team and consents, in an
  Enterprise organisation that allows approved apps only — provided its
  administrator enabled Miro's MCP server.
- The gateway no longer controls the exact request Miro runs (a REST call per
  item): the SVG tools act on many items at once, so the model is coarser —
  an update needs the deletion permissions, a creation the bulk permission.
- Fewer typed tools (no `delete_sticky_note`, no tags, no connectors as
  such): what the agent draws, it draws as SVG.
- **Until a capture, an argument of the model may not be Miro's**: the
  gateway would refuse a call with Miro's real argument as undeclared, or
  Miro would reject the modelled one. The discovery log says so on the first
  connection; the capture fixes it in one command and a review.
- One more provider whose tools follow an upstream list (Vercel, Railway,
  Context7 already).

## Rejected alternatives

### Keep the REST plugin beside the MCP one

Two ways for one service, which ADR token-first refused; and the REST way
is exactly what failed in an organisation.

### The REST API with the MCP server's OAuth token

Same authorization server name space (`boards:read`/`boards:write`), so the
token might be accepted by `api.miro.com`. Not documented, not testable
without an account, and the resource indicator binds the token to the MCP
server. Rejected: it would rest on an undocumented behaviour.

### Rewrap verbatim, `miro_url` forwarded as the agent wrote it

The classifier would parse the agent's URL, and the executor send it as it
is. Rejected: a URL carries more than the board (a query, `moveToWidget` of
any item, other parameters Miro may honour), so what is sent would not be
what is classified. Writing the URL from the classified ref closes it.

### Offer `board_search_boards` to agents

It names every board of the team, beyond the mission's. `list_boards`
answers from the mission instead.

### Wait for a Miro account to capture the schemas before shipping

The connection itself (the part Renaud could not use) is independent of the
schemas, and the safeguards of D4 make a wrong model visible and fixable in
one command. Shipping the connection now lets the first capture happen on
the account that needs it.

## References

- Handbook: [providers/miro](../handbook/providers/miro.md).
- Plugin: `plugins/miro/` (`README.md`).
- Miro: developers.miro.com/docs/connecting-to-miro-mcp,
  /docs/miro-mcp-tools, changelog "Legacy MCP board tools have been
  removed"; github.com/miroapp/miro-ai `docs/getting-started/enterprise.md`.
