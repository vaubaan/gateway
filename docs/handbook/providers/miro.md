---
title: Miro provider plugin
status: current
date: 2026-10-16
last_synced: 2026-10-24
tracks:
  - plugins/miro/src/
  - plugins/miro/scripts/
  - plugins/miro/tests/unit/
---

# Miro provider plugin

`@vaubaan/plugin-miro` 0.4.0, tool prefix `miro__`. A **rewrap of Miro's
official MCP server** (`https://mcp.miro.com/`), connected by **OAuth with a
client the gateway registers itself** — no Miro app to create, nothing to
paste. Decisions: ADR
[miro-rewraps-the-official-mcp-server](../../decisions/miro-rewraps-the-official-mcp-server.md)
(this plugin), ADR
[oauth-client-registered-by-the-gateway](../../decisions/oauth-client-registered-by-the-gateway.md)
(the host capability), ADR
[miro-board-ref-tilde-spelling](../../decisions/miro-board-ref-tilde-spelling.md)
(the board ref). Facts about Miro come from Miro's documentation
(developers.miro.com, read through Context7 and directly), from Miro's
`miroapp/miro-ai` repository, from unauthenticated probes of
`mcp.miro.com` on 2026-10-21, and from the product owner's run of the
capture script against a real Miro account on 2026-10-23 (see "Sources").
A fact still not checked is marked **⚠ unverified**; the model fails closed
when such a fact turns out worse than assumed.

**What is verified, and what is not.** On 2026-10-23 the capture script ran
against a real Miro account: the OAuth flow works (dynamic registration,
PKCE, an access token of 3599 s, a refresh token), and Miro's `tools/list`
(51 tools) is now `src/upstream-tools.json`, verbatim — tool names, argument
names, required arguments and the locator `miro_url` are Miro's. On
2026-10-24 the product owner's Dalae instance ran `miro__board_create`
through the gateway: Miro answered one text block whose text is JSON,
`{"miro_url":"https://miro.com/app/board/uXjVEVgYKSE=/","name":"Vaubaan test board (delete me)"}`
(**verified live**; it is the fixture of `created.test.ts`). The same run
showed that `board_search_boards` did not return the new board at 2 s nor at
10 s, and the mission's `list_boards` still did not list it two minutes later
(§6.2). The other tool calls, and discovery's reading of
`board_search_boards`, are still tested against mocks only.

## 0. Why the MCP server, and not the REST API

Version 0.1.0 (2026-10-16) called Miro's REST API v2 with the access token of
a Miro app the person created and pasted. On 2026-10-20, in an Enterprise
organisation that allows approved apps only, that token came back with
`"scopes": []` and the connection failed. Every REST token belongs to such
an app; Miro's MCP server needs none: its authorization server accepts
dynamic client registration, so the gateway registers itself as any MCP
client does, and the person only consents. The REST way is removed (one way
per service). On the Enterprise plan an administrator enables Miro's MCP
server for the organisation once; Fiabilis has.

## Decisions

Taken on 2026-10-21 by the coding agent on the product owner's request
("decide the details yourself, record them in an ADR"), recorded in ADR
miro-rewraps-the-official-mcp-server:

1. **OAuth through Miro's MCP authorization server, client registered by the
   gateway**, scopes `boards:read boards:write` only (§6.1).
2. **The gateway owns the locator.** Tools take `board` (a mission board, as
   a ref or a board URL) and `item_id`; the executor writes Miro's
   `miro_url` itself (§2, §5.1).
3. **`list_boards` is local**: answered from the mission's boards, never
   from Miro's `board_search_boards`, which names every board of the team.
4. **Upstream tools left out** with their reason (§5.5): `board_search_boards`
   (discovery only), every tool that hands out an upload URL (a presigned
   upload URL is a credential handed to the agent), the space, section and
   blog-post tools, the board moves and restore, the organisation-wide reads.
5. **An update of the canvas may delete**: `canvas_update_from_svg` touches
   `item-delete` and `frame-delete` on every call (§5.2).
6. **Catalog 2 keeps every id of catalog 1** and adds `read-format-guide` and
   `board-create`.
7. **The tool list is captured** (2026-10-23), with three safeguards against
   the next change at Miro (§6.5).

Added on 2026-10-23 (0.3.0, catalog 3, amendment of the same ADR): the
tools aligned on the captured schemas; **Miro's telemetry fields
`invocation_source` and `is_repository` are never offered nor sent**;
six tools added on one board of the mission — its space, its details, who
can open it, sharing it, changing a role on it, a narrated walkthrough —
each with a risk of its own (`board-share`: an exfiltration path, in
`facilitator` only, behind an approval).

Kept from 0.1.0 (product owner, 2026-10-16): **no environment** (no entity
`envScopable`, no env-scoped risk; deletions are held by the gate of the
`facilitator` preset) and **the board ref spelled with `~`** (ADR
miro-board-ref-tilde-spelling).

## 1. Data model

Two planes. `board`: the **board** is the resource. `guide`: Miro's format
guides, nothing of the customer's.

```
board[<board ref>]            the resource
  ├─ item[<item id>]          anything drawn: sticky note, shape, text, document, table,
  │    │                      diagram, image, prototype screen, line
  │    ├─ delete              verb leaf: deleting items
  │    ├─ tag-link[<tag id>]  (catalog 1; no tool since 0.2.0)
  │    └─ bulk-create         verb leaf on the collection: many items in one call
  ├─ frame[<item id>]         a frame, which groups items
  │    └─ delete              verb leaf: deleting frames
  ├─ connector[<id>]          (catalog 1; lines are drawn as items since 0.2.0)
  │    └─ delete
  ├─ tag[<tag id>]            (catalog 1; no tool since 0.2.0)
  ├─ comment[<comment id>]    a comment thread on the board or one of its items
  ├─ metadata                 the board's title, description, icon, and its space (0.3.0)
  ├─ access                   who can open the board, each with a role (0.3.0)
  └─ boardcast                a narrated walkthrough recorded on the board (0.3.0)
format-guide                  the SVG and typed-format specifications of the canvas tools
```

`connector`, `tag` and `tag-link` have no tool any more; they stay because
the catalog's patterns name them, and a risk is never narrowed silently.
`frame` is `one, unbounded` since an update emits `frame[*].delete`.

## 2. Tool → slice mapping

`B` = the board ref the `board` argument resolved to (a board of the
mission, §5.1); `I` = `item_id` when given, else `*`; `K` = `comment_id`.
Every tool's other arguments are Miro's own, forwarded as declared
(`src/upstream-tools.json`), except Miro's telemetry fields and the
withheld arguments (§2, "Arguments the gateway does not offer").

| Tool                                     | Locator                      | Slice(s)                                                             |
| ---------------------------------------- | ---------------------------- | -------------------------------------------------------------------- |
| `miro__list_boards`                      | — (the mission's boards)     | `miro.board[B1,B2,…].R`, answered by the gateway                     |
| `miro__board_create`                     | none                         | `miro.board.W`                                                       |
| `miro__canvas_search`                    | `board`, `item_id?`          | `miro.board[B].item[I].R`                                            |
| `miro__canvas_read_as_svg`               | `board`, `item_id?`          | `miro.board[B].item[I].R`                                            |
| `miro__canvas_create_from_svg`           | `board`, `item_id?` (frame)  | `miro.board[B].item.W`, `miro.board[B].item.bulk-create.W`           |
| `miro__canvas_update_from_svg`           | `board`, `item_id?`          | `miro.board[B].item[I].W`, `…item[*].delete.W`, `…frame[*].delete.W` |
| `miro__canvas_get_canvas_composer_skill` | none                         | `miro.format-guide.R`                                                |
| `miro__canvas_load_format_skill`         | none                         | `miro.format-guide.R`                                                |
| `miro__comment_list_comments`            | `board`, `item_id?`          | `miro.board[B].comment[*].R`                                         |
| `miro__comment_create`                   | `board`, `item_id?`          | `miro.board[B].comment.W`                                            |
| `miro__comment_reply`                    | `board`                      | `miro.board[B].comment[K].W`                                         |
| `miro__comment_resolve`                  | `board`                      | `miro.board[B].comment[K].W`                                         |
| `miro__image_get_data`                   | `board`, **`item_id`**       | `miro.board[B].item[I].R`                                            |
| `miro__image_get_url`                    | `board`, **`item_id`**       | `miro.board[B].item[I].R`                                            |
| `miro__image_create`                     | `board`, `item_id?` (frame)  | `miro.board[B].item.W`                                               |
| `miro__prototype_read`                   | `board`, `item_id?`          | `miro.board[B].item[I].R`                                            |
| `miro__prototype_create`                 | `board`, `item_id?` (frame)  | `miro.board[B].item.W`, `miro.board[B].item.bulk-create.W`           |
| `miro__table_create`                     | `board`, `item_id?` (frame)  | `miro.board[B].item.W`                                               |
| `miro__table_list_rows`                  | `board`, **`item_id`**       | `miro.board[B].item[I].R`                                            |
| `miro__table_sync_rows`                  | `board`, **`item_id`**       | `miro.board[B].item[I].W`                                            |
| `miro__table_get_latest_update_history`  | `board`, **`item_id`**       | `miro.board[B].item[I].R`                                            |
| `miro__table_update_view`                | `board`, **`item_id`**       | `miro.board[B].item[I].W`                                            |
| `miro__board_get_space`                  | `board`                      | `miro.board[B].metadata.R`                                           |
| `miro__board_update_metadata`            | `board`                      | `miro.board[B].metadata.W`                                           |
| `miro__content_item_list_roles`          | `board` → `content_item_url` | `miro.board[B].access.R`                                             |
| `miro__board_share`                      | `board`                      | `miro.board[B].access.W`                                             |
| `miro__board_role_update`                | `board`                      | `miro.board[B].access.W`                                             |
| `miro__create_boardcast`                 | `board`                      | `miro.board[B].boardcast.W`                                          |

Creating into a frame emits no frame slice: `item_id` names where the new
items go, not an item that changes. Ids of items inside the classified board
(`widget_ids` of `canvas_read_as_svg`, `target_id` of `canvas_search`,
`screen_id` of `prototype_read`, `row_id` of a table) are Miro's arguments,
resolved by Miro inside the board of `miro_url`; the slice names the board
and, when given, `item_id`. `content_item_list_roles` takes its board as
`content_item_url`: the gateway writes that argument the same way
(`locatorArgumentOf`).

### Arguments the gateway does not offer

- **Miro's telemetry of the agent's host.** Every Miro tool declares
  `invocation_source` ("you must populate this field": `skill` when a Miro
  AI skill asked for the call, `ui` from Miro's MCP UI, unset otherwise) and
  `is_repository` ("true when the folder you are operating in is a
  source-control repository"). Neither is required; both describe the
  agent's environment, not the task. They are not in the gateway's schemas,
  an agent that sends one is refused, and the executor never sends them:
  Miro applies its defaults (`TELEMETRY_ARGUMENTS`).
- **Withheld arguments** (`WITHHELD_ARGUMENTS`): `board_create`'s
  `parent_space_url` (a space, outside the resource model);
  `image_create`'s `image_token` and `prototype_create`'s `html_tokens` /
  `image_tokens` (they come from the upload-URL tools, which are left out).
  `prototype_create` therefore **requires `html_contents`**
  (`REQUIRED_BY_THE_GATEWAY`): Miro wants exactly one of the tokens and the
  inline HTML, and calls the inline HTML a fallback; images in it must be
  http(s) URLs, which Miro fetches itself.
- **`miro_url` of a tool with no board.** `canvas_get_canvas_composer_skill`
  declares an optional `miro_url` (no description); the gateway classifies
  the guide as Miro's documentation, with no board, and sends none.
- `table_create` without `miro_url` would create a new board: the gateway
  always writes it, so a table is always created on the board named.

Miro's descriptions speak of `miro_url` and `moveToWidget`: the gateway
appends a sentence to each board tool's description ("name the board with
board … the gateway writes miro_url itself"), and to the tools above what
differs through it (`BOARD_NOTE`, `DESCRIPTION_NOTES`). A `null` passes
where Miro's schema says `nullable`.

The table tools are marked "deprecating soon" by Miro; they stay while Miro
serves them.

### Undeclared arguments

The surface is closed (ADR plugin-arguments-closed-surface-and-typed-refusals):
`readMiroCall` refuses any argument the gateway's schema does not declare —
`miro_url` above all, which the gateway writes itself — in `classify` and
again in `execute`. Miro's own arguments are checked for presence when
required and for their JSON type; their values are Miro's to read.

## 3. Catalog and presets

`src/risk-catalog.yaml`, catalog 3 (2026-10-23). Thirteen named risks and
the fallback; no env-scoped risk. Catalog 3 keeps every id of catalog 2 and
adds the last five rows before the fallback.

| Risk                  | Matches                                              | Vector (rev / blast / data / visibility / persistence)  | Ceiling / min |
| --------------------- | ---------------------------------------------------- | ------------------------------------------------------- | ------------- |
| `read-boards`         | `board[*].R`                                         | reversible / single / metadata / internal / stateless   | 10            |
| `read-board-content`  | `board[**].{item,connector,tag,comment}[**].R`       | reversible / single / pii / internal / stateless        | 120           |
| `read-format-guide`   | `format-guide.R`                                     | reversible / single / metadata / internal / stateless   | 30            |
| `content-write`       | `board[**].{item,frame,connector,tag,comment}[**].W` | reversible / single / data / team / session             | 60            |
| `bulk-create`         | `board[**].item.bulk-create.W`                       | costly / bulk / data / team / session                   | 10            |
| `item-delete`         | `board[**].{item,connector}[**].delete.W`            | costly / single / data / team / session                 | 20            |
| `frame-delete`        | `board[**].frame[**].delete.W`                       | irreversible / bulk / data / team / session             | 20            |
| `board-create`        | `board.W`                                            | costly / single / data / team / session                 | 5             |
| `read-board-details`  | `board[*].metadata.R`                                | reversible / single / metadata / internal / stateless   | 30            |
| `read-board-access`   | `board[*].access.R`                                  | reversible / single / pii / internal / stateless        | 30            |
| `board-details-write` | `board[*].metadata.W`                                | reversible / single / metadata / team / session         | 10            |
| `board-share`         | `board[*].access.W`                                  | irreversible / single / pii / public / posture          | 5             |
| `boardcast-create`    | `board[*].boardcast.W`                               | costly / single / data / team / session (cost moderate) | 5             |
| `uncategorized-write` | `**.W` (fallback, in no preset)                      | costly / bulk / data / team / session                   | —             |

Writes are layered: `content-write`'s recursive patterns match the deletion
and bulk leaves too, so a mission needs `content-write` for any change and
the specific risk on top. `read-board-content` is `pii`: comments and items
carry who wrote them. The board's own details, its access and its
walkthroughs are **not** under `content-write` (its patterns name the
board's content only): each has its own risk.

`board-share` covers `board_share` and `board_role_update`: whoever is named
(a person by email or user id, or a group), with a role up to `owner`, reads
everything on the board from then on, may change it, share it further or
take it over, and may be outside the company where Miro's sharing settings
allow it. Access can be taken back at Miro; what was read cannot — the
vector says `irreversible`, `public`, `posture`. `read-board-access` is
`pii`: the list carries colleagues' emails. `boardcast-create`'s `cost` is
`moderate` because its voice is generated by Miro (⚠ whether it draws on
the plan's AI credits is not documented).

| Preset        | Risks                                                                                                                          | Gates                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `read-only`   | `read-boards`, `read-board-content`, `read-format-guide`, `read-board-details`                                                 | all `auto`                                                   |
| `scribe`      | + `content-write`, `bulk-create`                                                                                               | all `auto`; never deletes, so it cannot update the canvas    |
| `facilitator` | + `item-delete`, `frame-delete`, `board-create`, `read-board-access`, `board-details-write`, `boardcast-create`, `board-share` | deletions, new boards and shares `approval`; the rest `auto` |

In `facilitator`, every `canvas_update_from_svg` and every share asks first
(one request covers the call: ADR one-approval-request-covers-the-call).
`read-only` and `scribe` never see who can open a board, never rename it and
never share it.

### Rate limits

Miro applies "standard API rate limits" to its MCP server per user and
publishes a separate page of daily limits for MCP usage (⚠ the figures were
not read). The per-minute ceilings above are conservative; adjust them once
the limits are known.

## 4. Coverage

`assertCatalogCoverage` over `SAMPLES` (`tests/unit/fixtures.ts`, written
with the captured argument names): every one of the 28 tools classifies to
slices the catalog covers, the thirteen named risks are touched, the
fallback never (`plugin.test.ts`).

## 5. Edge cases

### 5.1 The locator is the gateway's

A Miro tool is told where it acts by a board URL; an item by the
`moveToWidget` parameter of that URL (Miro's documentation: "URLs that
include `moveToWidget` or `focusWidget` parameters scope the operation to a
specific item"). A URL carries more than a board, so the agent's URL is never
forwarded:

- `board` accepts a ref (`uXjVOD6LSME~`, `BOARD_REF`) or a board URL read
  strictly (`boardIdOfUrl`): `https:`, host `miro.com` exactly, no user, no
  port, path `/app/board/<id>/` and nothing after it; the query and the
  fragment are ignored. The board must be one of the mission's.
- `item_id` is numeric (`MIRO_ITEM_ID`, a JSON number is refused: it loses
  digits past 2^53); `comment_id` passes `MIRO_COMMENT_ID` (⚠ its shape is
  undocumented: letters, digits, `_`, `-`).
- The executor writes `miro_url = https://miro.com/app/board/<id>/` and, with
  an item, `?moveToWidget=<item_id>` (`boardUrlOf`), from the classified
  values.

### 5.2 An update of the canvas may delete

`canvas_update_from_svg` "applies an SVG document as a diff": what the new
document no longer holds is deleted — frames and what they hold included —
and a document body is replaced whole. Which items is not known before Miro
applies it, so every call touches `item-delete` and `frame-delete` with
`[*]`. `scribe`, which never deletes, therefore cannot update what is drawn;
it creates with `canvas_create_from_svg`.

### 5.3 Many items at once

`canvas_create_from_svg` and `prototype_create` create as many items as the
document holds. A mission's limits count calls, so they touch `bulk-create`
besides `content-write`.

### 5.4 Reads carry people's words

Items and comments are written by people and can carry instructions aimed at
the agent; `read-board-content` says so. `image_get_data` returns the image
itself (base64), passed through as an MCP image block.

### 5.5 Tools left out

`LEFT_OUT_UPSTREAM_TOOLS` (`src/identity.ts`), refused as unknown tools —
24 of Miro's 51:

- `board_search_boards` — every board of the team, beyond the mission's;
  used by discovery only.
- `image_get_upload_url`, `canvas_get_html_upload_url`,
  `prototype_get_upload_url` — a presigned upload URL handed to the agent is
  a credential (spec §2.4). `image_create` takes an image URL instead,
  `prototype_create` inline HTML.
- `user_who_am_i` (the connecting person's profile),
  `user_search_organization_users` (names and emails of the whole
  organisation), `get_brand_context` (the organisation's brand theme): reads
  no resource of the mission bounds.
- `board_create_format` — creates a content item in a space, not on a board.
- `board_move` (into another space or folder), `board_move_to_team` (the
  board leaves the team the account reaches), `board_restore` (boards in the
  trash, by URL: not resources of the mission).
- `space_create`, `space_update_metadata`, `space_list`,
  `space_list_boards`, `space_list_children`, `space_share`,
  `space_role_update`, `section_create`, `section_delete`,
  `section_update_metadata`, `blog_post_create`, `blog_post_list`,
  `blog_post_update` — spaces, their sections and blog posts are outside the
  resource model (one resource is one board).

### 5.6 One connection is one team

Miro's consent page asks the person to choose one team; the token reaches
that team's boards. A second team is a second connection.

## 6. Credential, discovery, execution, tests

### 6.1 Credential (`oauth2`, client registered by the gateway)

`src/credential.ts`:

```ts
{
  kind: 'oauth2',
  authorizationUrl: 'https://mcp.miro.com/authorize',
  tokenUrl: 'https://mcp.miro.com/token',
  clientRegistration: { registrationUrl: 'https://mcp.miro.com/register' },
  scopes: ['boards:read', 'boards:write'],
  pkce: true,
  resourceIndicator: 'https://mcp.miro.com/',
  clientAuthMethod: 'client_secret_post',
  refreshable: true,
}
```

Read from `https://mcp.miro.com/.well-known/oauth-protected-resource` and
`/.well-known/oauth-authorization-server` on 2026-10-21: the MCP server is
its own authorization server; grants `authorization_code`, `refresh_token`
(and a JWT bearer grant, unused); PKCE `S256`; token endpoint auth
`client_secret_post` or `client_secret_basic` — no public client; scopes
`boards:read boards:write openid email` (the plugin asks for the first two).
A test registration answered `201` with a client id and a secret, no expiry.
No revocation endpoint is published: `manualRevocation` tells the person to
remove "Vaubaan Gateway" from the apps of their Miro profile (⚠ the exact
place in Miro's settings is not verified). Access tokens are short-lived and
refreshed (Miro's enterprise guide); their lifetime is ⚠ unverified — the
host refreshes from `expires_in`, 60 s ahead.

The connect page reads "You sign in at Miro and allow this gateway; there is
nothing to create or paste"; the host registers the client the first time
(handbook [connections](../connections.md), "A client the gateway registers
itself").

An account connected with 0.1.0 (`api-key`) runs nothing after the upgrade
("connected a way Miro no longer offers") until its owner reconnects it.

### 6.2 Discovery

`discoverMiroResources`: `board_search_boards` without a query, page by page
— `limit: 50` (Miro's maximum; its default is 20), `offset` 0, 50, … — while
the answer says `has_more: true` and the page added a board, up to the
ceiling. The captured `outputSchema` describes the answer as
`{ data: [{ name, miro_url, description, team_name, owner, … }], total,
has_more }`: a board summary has **no id**, only its URL. `boardsIn` reads
it leniently and strictly at once: JSON text (or `structuredContent`) is
walked for objects that either have an `id` passing the board grammar (not
all digits: user and team ids are numeric) with that board's `viewLink` /
`url` / `link` / `boardUrl` / `miro_url` (or `type: board`), or have no `id`
and the link of exactly one board — not an item's link (`moveToWidget`,
`focusWidget`); a text that is not JSON gives the board URLs it contains,
with or without the trailing slash. One resource per board: `ref` the id
with `=` as `~`, `displayName` the name (else the id), `metadata.url`. At
most 500 boards (`MAX_DISCOVERED_BOARDS`, a warning past it). Version 0.2.0
called it once with no argument and read boards by `id` only: against the
captured shape it would have found at most 20 boards, and none from a JSON
answer (⚠ the live answer itself is still to be seen).

A `403` at that call — what Miro is ⚠ assumed to answer when the
organisation has not enabled its MCP server — is a `CredentialRefusal` with
`MCP_SERVER_REFUSED`, which the account page shows in full. A `401` is a
rejected credential. A successful discovery then runs `tools/list` and logs
the differences with the model (`toolDrift`, names only), never failing.

`board_create` is a resource-creating tool (`resourceCreatingTools`). After
it succeeds, before the answer leaves, `createdMiroResources`
(`src/created.ts`, the plugin's `createdResources`) reads the new board from
the answer — the JSON objects of the text blocks and of `structuredContent`,
whose `miro_url` (or `viewLink` / `url` / `boardUrl` / `link`) is a board URL
read through `boardIdOfUrl` and `boardRefOf`, not an item's link — and
describes it as `boardsIn` does: `ref` the id with `=` as `~`, `displayName`
the name (else the id), `metadata.url`. An answer that names no board, or two
different boards, gives `[]`. The host records the board on the connection and
adds it to the mission that created it, so every call on it works from the
next call on (ADR
[created-resources-join-the-mission](../../decisions/created-resources-join-the-mission.md)),
then discovers again; since Miro's search lists a new board late (observed
2026-10-24: more than two minutes), the row is not marked stale for 15
minutes after it was first seen. A board created in Miro itself is not read
this way: `resolveBoard` refuses it ("board 'X' is not a board of this
mission. A board this mission creates through the gateway is reached right
after its creation; one created elsewhere must be added to the mission by its
creator.") until the mission's creator adds it, or, for a mission on the whole
account, until a discovery lists it.

### 6.3 Execution

`executeMiro`: `readMiroCall` (the classifier's reader) first — a refusal is
an `isError` result and nothing is sent. `list_boards` is answered from
`ctx.resources`. Every other tool is one JSON-RPC `tools/call` to
`https://mcp.miro.com/` (`src/mcp.ts`) with `Authorization: Bearer
<access token>`, `Accept: application/json, text/event-stream`,
`MCP-Protocol-Version: 2025-06-18`; the answer's frame is read from a JSON
body or SSE `data:` lines. Miro's tool result passes through (`isError`,
images, `structuredContent` included; an unknown block becomes its JSON).

Whether the server needs an `initialize` first is ⚠ undocumented: a request
answered `400`/`404` without a session initializes once
(`initialize`, `notifications/initialized`) and is sent again with the
`Mcp-Session-Id` returned.

Failures: `401`/`403` → `UpstreamAuthError` (the host refreshes and retries,
then "needs reconnecting"); another status → `UpstreamHttpError`; a JSON-RPC
error frame → an `Error` with Miro's message, for the agent only.

### Identifiers

| Identifier   | Grammar                               | Where it goes                           |
| ------------ | ------------------------------------- | --------------------------------------- |
| board ref    | `^[A-Za-z0-9_-]{1,62}~{0,2}$`         | slices; `miro_url` path after `~` → `=` |
| board URL    | https, `miro.com`, `/app/board/<id>/` | read into the ref; never forwarded      |
| `item_id`    | `^[0-9]{1,24}$`                       | slices; `moveToWidget` of `miro_url`    |
| `comment_id` | `^[A-Za-z0-9_-]{1,64}$`               | slices; forwarded as Miro's argument    |

Every request goes to one constant URL; no identifier reaches a URL path.

### 6.4 Code map

| File                                | What is in it                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/identity.ts`                   | ids, Miro's URLs and OAuth endpoints, upstream names, locators, tools and arguments left out, `TOOL` |
| `src/identifiers.ts`                | the grammars, `boardOf`, `boardUrlOf`                                                                |
| `src/upstream-tools.json`           | Miro's `tools/list`, captured 2026-10-23                                                             |
| `src/tools.ts`                      | the gateway's declarations built from it; the refusals of an unmodelled tool / locator               |
| `src/call.ts`                       | `readMiroCall`: the one reader of a call                                                             |
| `src/classify.ts`                   | the slices                                                                                           |
| `src/mcp.ts`                        | the JSON-RPC client                                                                                  |
| `src/execute.ts`                    | execution, discovery, `boardsIn`, `toolDrift`                                                        |
| `src/created.ts`                    | `createdMiroResources`: the board `board_create` made, read from Miro's answer (§6.2)                |
| `src/credential.ts`                 | the `oauth2` spec                                                                                    |
| `src/risk-catalog.yaml`             | catalog 3                                                                                            |
| `scripts/capture-upstream-tools.ts` | the capture of `tools/list` (§6.5)                                                                   |

### 6.5 The tool list: captured

`src/upstream-tools.json` holds `{ source, captured_at, tools }`: Miro's
`tools/list`, captured verbatim on 2026-10-23 (51 tools; `title`,
`annotations`, `outputSchema` and `_meta` are kept, the gateway reads
`name`, `description` and `inputSchema`). Version 0.2.0 shipped a model of
Miro's documentation (`captured_at: null`); against the capture its names of
`canvas_search` (`query` → `patterns`), `canvas_load_format_skill`
(`format` → `format_name`), `prototype_create` (`screens` →
`html_contents`), `table_create` (`title` → `table_title`),
`table_list_rows` (`filter` → `filter_by`), `table_sync_rows`
(`key_column`, absent) and `table_update_view` (`view` → `layout` and
per-layout options) were wrong, and many optional arguments were missing;
0.3.0 aligns on the capture. Three safeguards for the next change at Miro:

1. **The capture**, with a Miro account:
   `npm run capture-upstream-tools --workspace @vaubaan/plugin-miro`. It
   registers a throw-away client at Miro with a loopback redirect
   (`http://127.0.0.1:<port>`, accepted on 2026-10-23), prints the
   authorization address, receives the code,
   exchanges it with PKCE, runs `tools/list`, writes the file verbatim and
   prints the differences with the previous model. The token never leaves
   the process. Then run the tests, align `LOCATOR` / `call.ts` /
   `classify.ts` where they differ, bump the version.
2. **The module refuses to load** a list with a tool neither offered
   (`LOCATOR`) nor left out, an offered board tool without its locator
   argument (`miro_url`, or `content_item_url` for
   `content_item_list_roles`), or an offered argument whose name looks like
   a locator (`…url`, `…_id`, `board…`) that is not modelled
   (`MODELLED_LOCATING_ARGUMENTS`: `image_url`, `comment_id`, `widget_ids`,
   `target_id`, `screen_id`, `row_id`, `subject_id`): it could aim the call
   at another board. Telemetry and withheld arguments are not offered, so
   not checked.
3. **Every discovery compares** the live `tools/list` with the model and
   logs `Miro's MCP tools differ from the plugin's model; capture them
again` with the tool and argument names that differ. Against the list of
   2026-10-23 it logs nothing (`plugin.test.ts`).

### 6.6 Tests

`tests/unit/` (mockFetch only, no network):

- `plugin.test.ts` — the SDK kit (well-formed, presets, no wildcard, catalog
  coverage with the thirteen risks, identifier proof), names, titles,
  version, no environment, the credential spec, the tool surface built from
  the captured list (51 tools, no drift against itself, 27 offered and 24
  left out, the telemetry fields and withheld arguments never declared,
  `prototype_create` requiring `html_contents`) and its refusals (an
  unmodelled tool, a locating argument, a missing locator, a required
  argument Miro no longer takes).
- `classify.test.ts` — every tool's slices; refusals: unknown and left-out
  tools, `miro_url` sent by the agent, the telemetry fields and withheld
  arguments, a board outside the mission (sharing included), hostile board
  URLs (another host, http, a user, a port, extra path, a dot segment), item
  and comment grammars, required and typed arguments, `null` where Miro
  declares it nullable.
- `identifiers.test.ts` — the grammars; what classify refuses execute does
  not send; the URL sent is the gateway's, whatever the agent's URL carried.
- `execute.test.ts` — what is sent (upstream name, arguments, `miro_url` or
  `content_item_url`, bearer, never a telemetry field); SSE; pass-through of Miro's result; `list_boards` without a
  request; failures by status and error frame; the session fallback;
  discovery from JSON (with ids, and Miro's captured board summaries without
  one), page after page while `has_more`, a server that ignores `offset`,
  from text, the `403` refusal in the plugin's words, the drift log.
- `created.test.ts` — `createdResources`: the board of the answer observed
  live on 2026-10-24 (same ref and metadata as `boardsIn`), `structuredContent`,
  a nameless board; nothing from a text answer, another host, http, a malformed
  id, an item link, two boards, another tool.
- `risk-catalog.test.ts` — risks per tool, the ids of catalogs 1 and 2 kept,
  the presets and their gates (`board-share` in `facilitator` only, behind
  an approval), a ceiling per risk.

The host side (registration, reuse, refresh with the registered client) is
tested in `apps/gateway/src/server/connections/oauth2-clients.test.ts`.

## Sources

- developers.miro.com: "Connecting to Miro's MCP Server" (OAuth 2.1 with
  dynamic client registration; `https://mcp.miro.com/`), "Miro MCP Server
  Tools" (the tool list, categories), changelog "Legacy MCP board tools have
  been removed" (the canvas tools replace `board_list_items`, `context_*`,
  `layout_*`, `diagram_*`, `doc_*`; `canvas_update_from_svg` replaces a
  document body whole), "Miro's MCP Server" (Enterprise controls).
- github.com/miroapp/miro-ai (commit of 2026-09-17):
  `docs/getting-started/enterprise.md` (enable the MCP server, team
  selection during OAuth, PKCE, short-lived tokens with refresh),
  `docs/mcp/tools-reference.md` (tools accept full board URLs;
  `moveToWidget` / `focusWidget` scope to an item); issue #66 (the full
  tool list on a consent screen, 2026-09-22).
- Probes of 2026-10-21 (unauthenticated): `POST https://mcp.miro.com/` →
  `401`, `WWW-Authenticate: Bearer resource_metadata=…`; the two
  `.well-known` documents quoted in §6.1; one `POST /register` → `201`.
- The capture of 2026-10-23 (the product owner's Miro account, the capture
  script): registration, PKCE, an access token of 3599 s with a refresh
  token, and `tools/list` — 51 tools, `src/upstream-tools.json`.
