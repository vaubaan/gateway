---
title: Miro is reached through Miro's official MCP server, connected by OAuth; the REST app-token way is removed
status: accepted
date: 2026-10-21
amended: 2026-10-23
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

## Amendment of 2026-10-23 — the tool list captured; six tools added, Miro's telemetry never sent

### Context

On 2026-10-23 the product owner ran
`npm run capture-upstream-tools --workspace @vaubaan/plugin-miro` against a
real Miro account. The sign-in works as D1 assumed (dynamic registration,
PKCE, the loopback redirect accepted, an access token of 3599 s, a refresh
token). `tools/list` answered **51 tools**; the model of D4 had 24. The
locator `miro_url` is confirmed. Against the capture the model was wrong on
`canvas_search` (`query` → `patterns`, `target_id`, `cursor`, and
`result_mode` required), `canvas_load_format_skill` (`format` →
`format_name`, `notation`, `renderer`), `prototype_create` (`screens` →
`html_tokens` / `html_contents`, `image_tokens`, `device_type`,
`orientation`, `x`, `y`), `table_create` (`title` → `table_title`, `x`,
`y`), `table_list_rows` (`filter` → `filter_by`, `next_cursor`, `limit`),
`table_sync_rows` (no `key_column`), `table_update_view` (`view` → `layout`
and options per layout), and missed optional arguments on most tools. Every
tool also declares two arguments that describe the agent, not the task:
`invocation_source` ("you must populate this field": `skill` when a Miro AI
skill asked for the call, `ui` from Miro's MCP UI, unset otherwise) and
`is_repository` ("set to true when the folder you are operating in is a
source-control repository"); neither is required. 27 tools were not
modelled at all.

The capture also gave `board_search_boards`'s `outputSchema`: a page
(`limit` 1–50, default 20; `offset`) of `{ name, miro_url, … }` — no `id` —
with `has_more`. Discovery as shipped in 0.2.0 called it once with no
argument and recognised boards by their `id`: it would have found at most
20 boards, and none in a JSON answer.

### Decision

**A1. The capture is the model.** `upstream-tools.json` is Miro's answer,
verbatim (`captured_at: 2026-10-23`); every wrapped tool takes Miro's
argument names and required arguments, and the new optional ones (limits,
offsets, coordinates, `widget_ids` and the scope fields, `resolved`,
`from_date` / `to_date`, `step`, `icon_emoji`…). The live list produces no
drift against it. Ids that name an item of the classified board
(`widget_ids`, `target_id`, `screen_id`, `row_id`) and the person a share
names (`subject_id`) join `MODELLED_LOCATING_ARGUMENTS`: Miro resolves them
inside the board of `miro_url`, which the gateway writes.

**A2. Miro's telemetry of the agent is neither offered nor sent.**
`invocation_source` and `is_repository` are not in the gateway's schemas;
an agent that sends one is refused as undeclared, and the executor never
sends them — Miro applies its own defaults (no value, `false`). They tell
Miro about the agent's host (whether it works in a source repository, what
triggered it), which is no part of the task the mission allows, and an
agent cannot know `ui` or `skill` through the gateway anyway. Forwarding the
agent's value was rejected: it is data about the customer's environment
leaving for a third party with no task need. Sending a neutral value
ourselves was rejected too: neither field is required, so the default is
what Miro gets without one.

**A3. Arguments withheld.** `board_create`'s `parent_space_url` (a space of
the team, outside the resource model: the board goes where Miro puts a new
board); `image_create`'s `image_token` and `prototype_create`'s
`html_tokens` / `image_tokens` (they come from the upload-URL tools, left
out). `prototype_create` therefore requires `html_contents`, which Miro's
schema allows alone ("Provide exactly one input"); Miro calls it a
last-resort fallback, and its images must be http(s) URLs, which Miro
fetches. `canvas_get_canvas_composer_skill`'s optional `miro_url` is not
sent: the guide stays Miro's documentation, with no board. Where the
gateway differs, a sentence is appended to Miro's description of the tool.

**A4. Six tools added, each acting on one board of the mission, each with a
risk of its own** — never under `content-write`, whose patterns name the
board's content:

| Tool                                           | Slice                  | Risk (catalog 3)      |
| ---------------------------------------------- | ---------------------- | --------------------- |
| `board_get_space`                              | `board[B].metadata.R`  | `read-board-details`  |
| `board_update_metadata`                        | `board[B].metadata.W`  | `board-details-write` |
| `content_item_list_roles` (`content_item_url`) | `board[B].access.R`    | `read-board-access`   |
| `board_share`, `board_role_update`             | `board[B].access.W`    | `board-share`         |
| `create_boardcast`                             | `board[B].boardcast.W` | `boardcast-create`    |

`content_item_list_roles` takes its board as `content_item_url` (a board
URL, a space URL or a content item id): the gateway writes that argument
from the classified board, as it writes `miro_url`.

**Sharing a board is an exfiltration path.** Whoever `board_share` names
— a person by email or user id, possibly outside the company where Miro's
sharing settings allow it, or a group — reads everything on the board from
then on, and with `editor`, `coowner` or `owner` may change it, share it
further or take it over. Access can be taken back at Miro; what was read
cannot. `board-share` is `irreversible / single / pii / public / posture`,
in `facilitator` only and **behind an approval**, absent from `read-only`
and `scribe`. One risk covers every role, `owner` included: an approval is
bound to the call's arguments (who, which role — ADR
one-approval-request-covers-the-call), and a split by role would add risks
a person must tell apart for little gain while every share already asks.
`read-board-access` is `pii` (colleagues' emails), in `facilitator` only.
`read-board-details` (the space a board is in) joins all three presets;
`board-details-write` and `boardcast-create` (a narrated walkthrough whose
voice Miro generates — ⚠ whether it draws on AI credits is not documented,
its `cost` says `moderate`) join `facilitator`, `auto`.

**A5. Left out, each with its reason in `LEFT_OUT_UPSTREAM_TOOLS`** — 24
of 51:

- `image_get_upload_url`, `canvas_get_html_upload_url`,
  `prototype_get_upload_url`: each hands the agent a presigned upload URL, a
  credential of its own (spec §2.4) — the rule of D2 for every such tool.
- `space_*`, `section_*`, `blog_post_*`, `board_create_format`: they act on
  spaces of the team, their sections and blog posts, or create a content
  item in a space. The resource is one board; a space is outside the model,
  and a mission could not bound them.
- `board_move` (into another space or folder), `board_move_to_team` (the
  board leaves the team the account reaches — its new team is outside the
  mission), `board_restore` (boards in the trash, named by URL: not
  resources of the mission). None is clearly safe on the resource model.
- `user_search_organization_users` (names and emails of the whole
  organisation), `get_brand_context` (the organisation's brand theme):
  organisation-wide reads that no resource bounds. Brand context fits no
  board risk cleanly; it may come back with a risk of its own on demand.
- `board_search_boards` (discovery only) and `user_who_am_i`, as in D2.

**A6. Discovery reads the captured shape.** `board_search_boards` is called
page by page (`limit: 50`, `offset`) while the answer says `has_more` and
the page added a board, up to 500. A board object is one with an `id` of
the board grammar and that board's link (as before), or — Miro's summary —
no `id` and the link of exactly one board, not an item's link. A text
answer's board URLs are read with or without the trailing slash.

**A7. Versions.** Plugin **0.3.0**; **catalog 3** keeps every id of catalog
2 and adds the five risks above; the presets keep their ids.

### Consequences

- Miro's real arguments reach Miro; a call no longer fails because the model
  guessed a name. The tool calls themselves are still to be run live: the
  capture proves the schemas, not Miro's answers.
- A mission holding `content-write` gains nothing: the six tools need their
  own risks. A `facilitator` mission issued before gains the five risks
  only when issued again from the preset (a mission keeps its risks).
- An agent of a `facilitator` mission can share a board of the mission with
  anyone Miro allows, once a person approves that call.
- Miro may change its list again: the safeguards of D4 stand (refusal to
  load an unmodelled tool or locating argument, the drift log, the capture).

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
