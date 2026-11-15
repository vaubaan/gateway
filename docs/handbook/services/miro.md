---
title: Miro plugin
tracks:
  - plugins/miro/src/
  - plugins/miro/scripts/
last_reviewed: 2026-11-04
---

# Miro plugin — handbook

`@vaubaan/plugin-miro`: a rewrap of Miro's official MCP server (`https://mcp.miro.com/`,
[rewrap-official-mcps](../../decisions/rewrap-official-mcps.md)), connected by OAuth with a client
the gateway registers itself
([oauth-client-registered-by-the-gateway](../../decisions/oauth-client-registered-by-the-gateway.md)).
One resource per board; no environment. Rules common to every plugin:
[services README](README.md).

## Start here

- [`src/call.ts`](../../../plugins/miro/src/call.ts) — `readMiroCall`, shared by classify and
  execute.
- [`src/identity.ts`](../../../plugins/miro/src/identity.ts) — offered and left-out tools and
  arguments, locators.
- [`src/execute.ts`](../../../plugins/miro/src/execute.ts) — execution, discovery (`boardsIn`), the
  drift log (`toolDrift`).
- [`scripts/capture-upstream-tools.ts`](../../../plugins/miro/scripts/capture-upstream-tools.ts) —
  recaptures `src/upstream-tools.json`.

## Invariants

- **The gateway owns the locator**: agents never send `miro_url` (refused as undeclared); tools
  take `board` and `item_id`, and the executor writes `miro_url` (and `?moveToWidget=`) from the
  classified board. A board URL is read strictly: `https:`, host exactly `miro.com`, path
  `/app/board/<id>/`. `content_item_list_roles`'s `content_item_url` is written the same way.
- **Board ref = Miro id with each trailing `=` written `~`** (`boardRefOf` / `miroIdOf`, one to
  one), so slices, audit and approvals name the board on multi-board missions. A `board` ref in
  Miro's `=` spelling is refused, never converted; a discovered id outside the grammar is skipped
  with a warning.
- **The module refuses to load** a tool list with an unclassified tool, a board tool without its
  locator, or an unmodelled locator-like argument (`…url`, `…_id`, `board…`).
- `canvas_update_from_svg` applies a diff: what the new document no longer holds is deleted, so
  every call touches `item-delete` and `frame-delete` on `[*]` (`scribe` cannot update the canvas).
  Many-item creators also touch `bulk-create`. Writes are layered on `content-write`.
- **`board-share` is an exfiltration path**: whoever is named reads everything from then on. It is
  in `facilitator` only, behind an approval bound to the call's arguments.
- `list_boards` answers from the mission's boards (`board_search_boards`, every board of the team,
  serves discovery only). Upload-URL tools and telemetry arguments are never offered.
- `connector`, `tag`, `tag-link` have no tool but stay: catalog patterns name them.

## Traps

- Why not REST: every REST token belongs to a Miro app, and in an approved-apps-only Enterprise org
  it came back with `"scopes": []`. The MCP server accepts dynamic client registration.
- A board summary has no id, only its `miro_url`: `boardsIn` reads board URLs and rejects item links
  and numeric ids.
- Miro's search lists a new board late (over two minutes observed): a board `board_create` made is
  read from the answer and joins the mission at once; its row is not marked stale for 15 minutes.
- Whether the server needs `initialize` is undocumented: the SDK's MCP client (`MIRO_MCP_SERVER`,
  default session mode) answers a 400/404 without a session with one, then resends with the
  `Mcp-Session-Id`. A JSON-RPC error frame, or `board_search_boards` answering `isError`, is an
  `UpstreamProtocolError` (HTTP 502 for the host), never a plain `Error`.

## Outside the repo

- On the Enterprise plan the org admin enables Miro's MCP server once; until then discovery's `403`
  is shown as a `CredentialRefusal` (`MCP_SERVER_REFUSED`) on the account page.
- The consent page makes the person pick one team: a second team is a second account.
- No revocation endpoint: remove "Vaubaan Gateway" from the Miro profile's apps.

## Procedures

- **The tool list captured**: recapture with a Miro account,
  `npm run capture-upstream-tools --workspace @vaubaan/plugin-miro` (throw-away client, loopback
  redirect, PKCE; the token never leaves the process; prints the differences). Then run the tests,
  align `LOCATOR`, `call.ts`, `classify.ts`, bump the version. Every discovery compares the live
  list and logs `Miro's MCP tools differ from the plugin's model; capture them again`.

## Debug

- A board refused although it exists → created in Miro itself: the mission's creator adds it (or,
  on a set with future resources, it joins at the next discovery: hourly, or "check now").
- `miro_url` refused → send `board` (ref or board URL) instead.
