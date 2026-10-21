---
title: Miro provider plugin
status: current
date: 2026-10-16
last_synced: 2026-10-21
tracks:
  - plugins/miro/src/
  - plugins/miro/scripts/
  - plugins/miro/tests/unit/
---

# Miro provider plugin

`@vaubaan/plugin-miro` 0.2.0, tool prefix `miro__`. A **rewrap of Miro's
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
`miroapp/miro-ai` repository, and from unauthenticated probes of
`mcp.miro.com` on 2026-10-21 (see "Sources"). A fact nobody could check
without a Miro account is marked **⚠ unverified**; the model fails closed
when such a fact turns out worse than assumed.

**What is not verified, in one paragraph.** No Miro account was available:
the OAuth flow, the consent page, the token lifetime, `tools/list` and every
tool call ran against mocks only. The **tool names** are Miro's (documented);
the **argument names** in `src/upstream-tools.json` — the board locator
`miro_url` included — are a model of the documentation, not a capture. The
first person with a Miro account runs the capture (§6.5); the first discovery
of every connection already logs any difference.

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
4. **Three upstream tools left out**: `board_search_boards` (discovery only),
   `image_get_upload_url` (a presigned upload URL is a credential handed to
   the agent), `user_who_am_i` (no task needs the person's profile).
5. **An update of the canvas may delete**: `canvas_update_from_svg` touches
   `item-delete` and `frame-delete` on every call (§5.2).
6. **Catalog 2 keeps every id of catalog 1** and adds `read-format-guide` and
   `board-create`.
7. **The tool list is modelled until captured**, with three safeguards
   (§6.5).

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
  └─ comment[<comment id>]    a comment thread on the board or one of its items
format-guide                  the SVG and typed-format specifications of the canvas tools
```

`connector`, `tag` and `tag-link` have no tool any more; they stay because
the catalog's patterns name them, and a risk is never narrowed silently.
`frame` is `one, unbounded` since an update emits `frame[*].delete`.

## 2. Tool → slice mapping

`B` = the board ref the `board` argument resolved to (a board of the
mission, §5.1); `I` = `item_id` when given, else `*`; `K` = `comment_id`.
Every tool's other arguments are Miro's own, forwarded as declared
(`src/upstream-tools.json`).

| Tool                                     | Locator                     | Slice(s)                                                             |
| ---------------------------------------- | --------------------------- | -------------------------------------------------------------------- |
| `miro__list_boards`                      | — (the mission's boards)    | `miro.board[B1,B2,…].R`, answered by the gateway                     |
| `miro__board_create`                     | none                        | `miro.board.W`                                                       |
| `miro__canvas_search`                    | `board`, `item_id?`         | `miro.board[B].item[I].R`                                            |
| `miro__canvas_read_as_svg`               | `board`, `item_id?`         | `miro.board[B].item[I].R`                                            |
| `miro__canvas_create_from_svg`           | `board`, `item_id?` (frame) | `miro.board[B].item.W`, `miro.board[B].item.bulk-create.W`           |
| `miro__canvas_update_from_svg`           | `board`, `item_id?`         | `miro.board[B].item[I].W`, `…item[*].delete.W`, `…frame[*].delete.W` |
| `miro__canvas_get_canvas_composer_skill` | none                        | `miro.format-guide.R`                                                |
| `miro__canvas_load_format_skill`         | none                        | `miro.format-guide.R`                                                |
| `miro__comment_list_comments`            | `board`, `item_id?`         | `miro.board[B].comment[*].R`                                         |
| `miro__comment_create`                   | `board`, `item_id?`         | `miro.board[B].comment.W`                                            |
| `miro__comment_reply`                    | `board`                     | `miro.board[B].comment[K].W`                                         |
| `miro__comment_resolve`                  | `board`                     | `miro.board[B].comment[K].W`                                         |
| `miro__image_get_data`                   | `board`, **`item_id`**      | `miro.board[B].item[I].R`                                            |
| `miro__image_get_url`                    | `board`, **`item_id`**      | `miro.board[B].item[I].R`                                            |
| `miro__image_create`                     | `board`, `item_id?` (frame) | `miro.board[B].item.W`                                               |
| `miro__prototype_read`                   | `board`, `item_id?`         | `miro.board[B].item[I].R`                                            |
| `miro__prototype_create`                 | `board`, `item_id?` (frame) | `miro.board[B].item.W`, `miro.board[B].item.bulk-create.W`           |
| `miro__table_create`                     | `board`, `item_id?` (frame) | `miro.board[B].item.W`                                               |
| `miro__table_list_rows`                  | `board`, **`item_id`**      | `miro.board[B].item[I].R`                                            |
| `miro__table_sync_rows`                  | `board`, **`item_id`**      | `miro.board[B].item[I].W`                                            |
| `miro__table_get_latest_update_history`  | `board`, **`item_id`**      | `miro.board[B].item[I].R`                                            |
| `miro__table_update_view`                | `board`, **`item_id`**      | `miro.board[B].item[I].W`                                            |

Creating into a frame emits no frame slice: `item_id` names where the new
items go, not an item that changes. The table tools are marked "deprecating
soon" by Miro; they stay while Miro serves them.

### Undeclared arguments

The surface is closed (ADR plugin-arguments-closed-surface-and-typed-refusals):
`readMiroCall` refuses any argument the gateway's schema does not declare —
`miro_url` above all, which the gateway writes itself — in `classify` and
again in `execute`. Miro's own arguments are checked for presence when
required and for their JSON type; their values are Miro's to read.

## 3. Catalog and presets

`src/risk-catalog.yaml`, catalog 2 (2026-10-21). Eight named risks and the
fallback; no env-scoped risk.

| Risk                  | Matches                                              | Vector (rev / blast / data / visibility / persistence) | Ceiling / min |
| --------------------- | ---------------------------------------------------- | ------------------------------------------------------ | ------------- |
| `read-boards`         | `board[*].R`                                         | reversible / single / metadata / internal / stateless  | 10            |
| `read-board-content`  | `board[**].{item,connector,tag,comment}[**].R`       | reversible / single / pii / internal / stateless       | 120           |
| `read-format-guide`   | `format-guide.R`                                     | reversible / single / metadata / internal / stateless  | 30            |
| `content-write`       | `board[**].{item,frame,connector,tag,comment}[**].W` | reversible / single / data / team / session            | 60            |
| `bulk-create`         | `board[**].item.bulk-create.W`                       | costly / bulk / data / team / session                  | 10            |
| `item-delete`         | `board[**].{item,connector}[**].delete.W`            | costly / single / data / team / session                | 20            |
| `frame-delete`        | `board[**].frame[**].delete.W`                       | irreversible / bulk / data / team / session            | 20            |
| `board-create`        | `board.W`                                            | costly / single / data / team / session                | 5             |
| `uncategorized-write` | `**.W` (fallback, in no preset)                      | costly / bulk / data / team / session                  | —             |

Writes are layered: `content-write`'s recursive patterns match the deletion
and bulk leaves too, so a mission needs `content-write` for any change and
the specific risk on top. `read-board-content` is `pii`: comments and items
carry who wrote them.

| Preset        | Risks                                                    | Gates                                                     |
| ------------- | -------------------------------------------------------- | --------------------------------------------------------- |
| `read-only`   | `read-boards`, `read-board-content`, `read-format-guide` | all `auto`                                                |
| `scribe`      | + `content-write`, `bulk-create`                         | all `auto`; never deletes, so it cannot update the canvas |
| `facilitator` | + `item-delete`, `frame-delete`, `board-create`          | deletions and new boards `approval`; the rest `auto`      |

In `facilitator`, every `canvas_update_from_svg` asks first (one request
covers the call: ADR one-approval-request-covers-the-call).

### Rate limits

Miro applies "standard API rate limits" to its MCP server per user and
publishes a separate page of daily limits for MCP usage (⚠ the figures were
not read). The per-minute ceilings above are conservative; adjust them once
the limits are known.

## 4. Coverage

`assertCatalogCoverage` over `SAMPLES` (`tests/unit/fixtures.ts`): every one
of the 22 tools classifies to slices the catalog covers, the eight named
risks are touched, the fallback never (`plugin.test.ts`).

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

`LEFT_OUT_UPSTREAM_TOOLS` (`src/identity.ts`), refused as unknown tools:
`board_search_boards` (every board of the team, beyond the mission's — used
by discovery only), `image_get_upload_url` (a presigned upload URL handed to
the agent is a credential, spec §2.4; `image_create` takes an image URL
instead), `user_who_am_i` (the connecting person's profile).

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

`discoverMiroResources`: one `tools/call` of `board_search_boards` with no
argument. The answer's shape is ⚠ undocumented, so `boardsIn` reads it
leniently and strictly at once: JSON text (or `structuredContent`) is walked
for objects whose `id` passes the board grammar (not all digits: user and
team ids are numeric) and whose `viewLink` / `url` / `link` / `boardUrl` /
`miro_url` is that board's URL, or whose `type` is `board`; a text that is
not JSON gives the board URLs it contains. One resource per board: `ref` the
id with `=` as `~`, `displayName` the name (else the id), `metadata.url`. At
most 500 boards (`MAX_DISCOVERED_BOARDS`, a warning past it).

A `403` at that call — what Miro is ⚠ assumed to answer when the
organisation has not enabled its MCP server — is a `CredentialRefusal` with
`MCP_SERVER_REFUSED`, which the account page shows in full. A `401` is a
rejected credential. A successful discovery then runs `tools/list` and logs
the differences with the model (`toolDrift`, names only), never failing.

`board_create` is a resource-creating tool: the host discovers again after it
succeeds.

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

| File                                | What is in it                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| `src/identity.ts`                   | ids, Miro's URLs and OAuth endpoints, upstream names, locators, tools left out, `TOOL` |
| `src/identifiers.ts`                | the grammars, `boardOf`, `boardUrlOf`                                                  |
| `src/upstream-tools.json`           | Miro's `tools/list` (modelled until captured)                                          |
| `src/tools.ts`                      | the gateway's declarations built from it; the refusals of an unmodelled tool / locator |
| `src/call.ts`                       | `readMiroCall`: the one reader of a call                                               |
| `src/classify.ts`                   | the slices                                                                             |
| `src/mcp.ts`                        | the JSON-RPC client                                                                    |
| `src/execute.ts`                    | execution, discovery, `boardsIn`, `toolDrift`                                          |
| `src/credential.ts`                 | the `oauth2` spec                                                                      |
| `src/risk-catalog.yaml`             | catalog 2                                                                              |
| `scripts/capture-upstream-tools.ts` | the capture of `tools/list` (§6.5)                                                     |

### 6.5 The tool list: modelled, then captured

`src/upstream-tools.json` holds `{ source, captured_at, tools }`. Today
`captured_at` is `null`: the names are Miro's documented tools, the argument
names a model. Three safeguards:

1. **The capture**, with a Miro account:
   `npm run capture-upstream-tools --workspace @vaubaan/plugin-miro`. It
   registers a throw-away client at Miro with a loopback redirect
   (⚠ that Miro accepts `http://127.0.0.1:<port>` is assumed, as for every
   desktop MCP client), prints the authorization address, receives the code,
   exchanges it with PKCE, runs `tools/list`, writes the file verbatim and
   prints the differences with the previous model. The token never leaves
   the process. Then run the tests, align `LOCATOR` / `call.ts` /
   `classify.ts` where they differ, bump the version.
2. **The module refuses to load** a list with a tool neither offered
   (`LOCATOR`) nor left out, an offered board tool without `miro_url`, or an
   argument whose name looks like a locator (`…url`, `…_id`, `board…`) that
   is not modelled (`MODELLED_LOCATING_ARGUMENTS`: `image_url`,
   `comment_id`): it could aim the call at another board.
3. **Every discovery compares** the live `tools/list` with the model and
   logs `Miro's MCP tools differ from the plugin's model; capture them
again` with the tool and argument names that differ.

Until the capture, a modelled argument that is not Miro's makes the call
fail at Miro (or a real argument be refused by the gateway as undeclared).

### 6.6 Tests

`tests/unit/` (mockFetch only, no network):

- `plugin.test.ts` — the SDK kit (well-formed, presets, no wildcard, catalog
  coverage with the eight risks, identifier proof), names, titles, version,
  no environment, the credential spec, the tool surface built from the
  upstream list and its refusals (an unmodelled tool, a locating argument, a
  missing locator).
- `classify.test.ts` — every tool's slices; refusals: unknown and left-out
  tools, `miro_url` sent by the agent, a board outside the mission, hostile
  board URLs (another host, http, a user, a port, extra path, a dot
  segment), item and comment grammars, required and typed arguments.
- `identifiers.test.ts` — the grammars; what classify refuses execute does
  not send; the URL sent is the gateway's, whatever the agent's URL carried.
- `execute.test.ts` — what is sent (upstream name, arguments, `miro_url`,
  bearer); SSE; pass-through of Miro's result; `list_boards` without a
  request; failures by status and error frame; the session fallback;
  discovery from JSON and from text, the `403` refusal in the plugin's
  words, the drift log.
- `risk-catalog.test.ts` — risks per tool, the ids of catalog 1 kept, the
  presets and their gates, a ceiling per risk.

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
