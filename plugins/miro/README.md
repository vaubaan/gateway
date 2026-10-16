# `@vaubaan/plugin-miro`

Miro boards for Vaubaan Gateway: sticky notes, shapes, texts, cards, frames,
connectors and tags, one resource per board. Miro REST API v2.

The model and the reasons behind it are in the handbook
[`docs/handbook/providers/miro.md`](../../docs/handbook/providers/miro.md);
the board ref spelling in the ADR
[`miro-board-ref-tilde-spelling`](../../docs/decisions/miro-board-ref-tilde-spelling.md).

## Files

| File                    | What is in it                                                           |
| ----------------------- | ----------------------------------------------------------------------- |
| `src/identity.ts`       | `PROVIDER_ID`, the tool names (`TOOL`), the credential field.           |
| `src/identifiers.ts`    | The grammars: board ref and Miro board id, item-like ids, cursor.       |
| `src/data-model.ts`     | The `board` plane.                                                      |
| `src/risk-catalog.yaml` | Six risks, the fallback, three presets.                                 |
| `src/tools.ts`          | The 30 tools and their schemas; `src/tool-titles.ts` their titles.      |
| `src/bodies.ts`         | The bodies sent to Miro, closed per item type.                          |
| `src/call.ts`           | `readMiroCall`: the one reader of a call, for `classify` and `execute`. |
| `src/classify.ts`       | The slices of a call.                                                   |
| `src/execute.ts`        | The requests, the type check before an update or a deletion, discovery. |
| `src/credential.ts`     | The `api-key` spec, its guide and `verify`.                             |
| `src/index.ts`          | `definePlugin`, the default export.                                     |

## Data model

One plane, `board`. No environment: a Miro board has none.

```
board[<board ref>]            the resource
  ├─ item[<item id>]          sticky note, shape, text, card (read: any item type)
  │    ├─ delete              verb leaf
  │    ├─ tag-link[<tag id>]  a tag attached to the item
  │    └─ bulk-create         verb leaf on the collection: the bulk call
  ├─ frame[<item id>]
  │    └─ delete              verb leaf
  ├─ connector[<id>]
  │    └─ delete              verb leaf
  └─ tag[<tag id>]
```

## Credential and resources

Kind `api-key`, one secret field `access_token`: the access token of a Miro
app with the scopes `boards:read` and `boards:write` only, created with
**"Expire user authorization token" unchecked** (an expiring token stops
after one hour, and its refresh needs the app's client secret). Pattern
`^[A-Za-z0-9._~+/=-]{20,512}$`; `verify` reads the token context
(`GET /v1/oauth-token`), names the account after the team, and refuses a
token without both scopes. `boards:write` also lets the token delete boards
and manage members: no tool of the plugin does either.

`discoverResources` reads the team from the token context, then
`GET /v2/boards?team_id=…`, 50 a page, **at most 500 boards**
(`MAX_DISCOVERED_BOARDS`). One resource per board: `ref` is the board id
with its trailing `=` written `~` (`uXjVOD6LSME=` → `uXjVOD6LSME~`),
`displayName` its name, `metadata` the team id and the view link. A board
id outside Miro's grammar is left out, with a warning.

## Tools

Thirty tools named `miro__<verb>_<noun>`. Each but `list_boards` takes
`board`, the ref of one of the mission's boards (it may be omitted when the
mission holds one board). A board given in Miro's spelling is refused with
the ref to use when the mission holds that board.

| Tool(s)                                                            | Slice                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------ |
| `list_boards`                                                      | `miro.board[<ref>,<ref>…].R`, every mission board, one slice |
| `get_board`                                                        | `miro.board[<ref>].R`                                        |
| `list_items`, `get_item`                                           | `miro.board[<ref>].item[*\|<id>].R`                          |
| `list_connectors`, `get_connector`                                 | `miro.board[<ref>].connector[*\|<id>].R`                     |
| `list_tags`                                                        | `miro.board[<ref>].tag[*].R`                                 |
| `list_item_tags`                                                   | `miro.board[<ref>].item[<id>].tag-link[*].R`                 |
| `create_sticky_note`, `create_shape`, `create_text`, `create_card` | `miro.board[<ref>].item.W`                                   |
| `update_…` of those four                                           | `miro.board[<ref>].item[<id>].W`                             |
| `delete_…` of those four                                           | `miro.board[<ref>].item[<id>].delete.W`                      |
| `create_frame`                                                     | `miro.board[<ref>].frame.W`                                  |
| `update_frame`                                                     | `miro.board[<ref>].frame[<id>].W`                            |
| `delete_frame`                                                     | `miro.board[<ref>].frame[<id>].delete.W`                     |
| `create_connector`                                                 | `miro.board[<ref>].connector.W`                              |
| `update_connector`                                                 | `miro.board[<ref>].connector[<id>].W`                        |
| `delete_connector`                                                 | `miro.board[<ref>].connector[<id>].delete.W`                 |
| `create_tag`                                                       | `miro.board[<ref>].tag.W`                                    |
| `attach_tag`, `remove_tag`                                         | `miro.board[<ref>].item[<id>].tag-link[<tag>].W`             |
| `create_items` (1 to 20 items)                                     | `miro.board[<ref>].item.bulk-create.W`                       |

Undeclared arguments are refused, in `classify` and in `execute`. The
objects sent to Miro (`data`, `style`, `position`, `geometry`) are closed
per item type and flat; a card takes no `assigneeId`. Before an update or a
deletion, `execute` reads the item and declines when its type is not the
tool's. Item, frame, connector and tag ids are digits only
(`^[0-9]{1,24}$`), the cursor a query value only.

## Catalog

`src/risk-catalog.yaml`, version 1: six named risks and the fallback. No
risk is env-scoped.

| Risk                       | Action | Notes                                                          |
| -------------------------- | ------ | -------------------------------------------------------------- |
| `miro.read-boards`         | R      | Board details, with people's names (`pii`).                    |
| `miro.read-board-content`  | R      | Items, connectors, tags.                                       |
| `miro.content-write`       | W      | Every write under a board, deletions and bulk calls included.  |
| `miro.bulk-create`         | W      | `create_items`: up to 20 items for one call.                   |
| `miro.item-delete`         | W      | Deleting a sticky note, shape, text, card or connector.        |
| `miro.frame-delete`        | W      | Deleting a frame; priced as if its items went with it.         |
| `miro.uncategorized-write` | W      | Fallback (`fallback: true`); touched by no tool, in no preset. |

Every risk carries `calls_per_minute_max`, so that one mission at every
ceiling stays under Miro's 100,000 credits a minute per user and app,
counted at each risk's worst-case call: one `list_boards` is one unit of
`read-boards` and pays up to 50 upstream reads (one per mission board), so
`read-boards` is held to 10 calls a minute.

## Presets

| Preset        | Scope                                                                |
| ------------- | -------------------------------------------------------------------- |
| `read-only`   | The two reads.                                                       |
| `scribe`      | The reads, `content-write`, `bulk-create`. Never deletes.            |
| `facilitator` | Everything; `item-delete` and `frame-delete` ask first (`approval`). |

## Tests

`npx vitest run plugins/miro` — the SDK kit (`assertPluginWellFormed`,
`assertPresetsValid`, `assertNoWildcard`, `assertCatalogCoverage`,
`assertIdentifiersRefused`), the classifier branch by branch, the risks of
every tool and the preset gates, the identifiers on both sides, `execute`,
discovery and `verify` against `mockFetch`. No test calls Miro.
