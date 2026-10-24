# `@vaubaan/plugin-miro`

Miro boards for Vaubaan Gateway, through **Miro's official MCP server**
(`https://mcp.miro.com/`): read and draw on boards, tables, comments,
prototypes — one resource per board.

A person connects Miro from Accounts → Connect: they sign in at Miro, choose
a team and allow the gateway. There is **no Miro app to create and nothing to
paste**: the gateway registers its own OAuth client at Miro the first time
someone connects (RFC 7591). On a Miro Enterprise plan, an administrator
first enables Miro's MCP server for the organisation.

The model and the reasons behind it are in the handbook
[`docs/handbook/providers/miro.md`](../../docs/handbook/providers/miro.md);
the decisions in the ADRs
[`miro-rewraps-the-official-mcp-server`](../../docs/decisions/miro-rewraps-the-official-mcp-server.md),
[`oauth-client-registered-by-the-gateway`](../../docs/decisions/oauth-client-registered-by-the-gateway.md)
and [`miro-board-ref-tilde-spelling`](../../docs/decisions/miro-board-ref-tilde-spelling.md).

## Files

| File                                | What is in it                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| `src/identity.ts`                   | `PROVIDER_ID`, Miro's URLs and OAuth endpoints, upstream names, locators, `TOOL`  |
| `src/identifiers.ts`                | The grammars: board ref, board URL, item id, comment id; `boardUrlOf`             |
| `src/upstream-tools.json`           | Miro's `tools/list`, captured verbatim on 2026-10-23 (51 tools)                   |
| `src/tools.ts`                      | The 28 tools: Miro's, with `board` / `item_id` for `miro_url`, plus `list_boards` |
| `src/call.ts`                       | `readMiroCall`: the one reader of a call, for `classify` and `execute`            |
| `src/classify.ts`                   | The slices of a call                                                              |
| `src/mcp.ts`                        | The JSON-RPC client of Miro's MCP server                                          |
| `src/execute.ts`                    | Execution, discovery (`board_search_boards`), the drift check of the tool list    |
| `src/created.ts`                    | The board `board_create` made, read from its answer (`createdResources`)          |
| `src/credential.ts`                 | The `oauth2` spec with `clientRegistration`                                       |
| `src/data-model.ts`                 | The `board` and `guide` planes                                                    |
| `src/risk-catalog.yaml`             | Thirteen risks, the fallback, three presets (catalog 3)                           |
| `scripts/capture-upstream-tools.ts` | Captures `tools/list` into `src/upstream-tools.json` (needs a Miro account)       |

## Credential and resources

Kind `oauth2`, against the authorization server of Miro's MCP server
(`https://mcp.miro.com/authorize`, `/token`), with PKCE, the scopes
`boards:read` and `boards:write` only, and the MCP server as the audience
of the token (`resource=https://mcp.miro.com/`). The client is **registered
by the gateway itself** at `https://mcp.miro.com/register` the first time
someone connects, named "Vaubaan Gateway (<your gateway's host>)", and
reused for every connection: no administrator declares anything. Access
tokens are short-lived and refreshed by the gateway.

On Miro's consent page the person **chooses one team**: the account reaches
that team's boards; a second team is a second account. On a Miro
Enterprise plan, an administrator first enables Miro's MCP server for the
organisation (Miro's admin guide, "Miro MCP Server"); until then Miro
refuses the account and the account page says so.

Discovery lists the team's boards (`board_search_boards`, 50 per page), **at most 500**.
One resource per board: `ref` is the board id with its trailing `=` written
`~` (`uXjVOD6LSME=` → `uXjVOD6LSME~`), `displayName` its name, `metadata`
its URL. To disconnect at Miro, remove "Vaubaan Gateway" from the apps of
your Miro profile.

Accounts connected with the plugin 0.1.0 (the access token of a Miro app)
run nothing after the upgrade: reconnect them from Accounts.

## Tools

`miro__list_boards` (answered by the gateway from the mission's boards) and
27 of Miro's 51 tools, renamed `miro__<name>`: `board_create`,
`canvas_search`, `canvas_read_as_svg`, `canvas_create_from_svg`,
`canvas_update_from_svg`, `canvas_get_canvas_composer_skill`,
`canvas_load_format_skill`, `comment_list_comments`, `comment_create`,
`comment_reply`, `comment_resolve`, `image_get_data`, `image_get_url`,
`image_create`, `prototype_read`, `prototype_create`, `table_create`,
`table_list_rows`, `table_sync_rows`, `table_get_latest_update_history`,
`table_update_view`, and (0.3.0) `board_get_space`,
`board_update_metadata`, `content_item_list_roles`, `board_share`,
`board_role_update`, `create_boardcast`.

Each tool that acts on a board takes `board` — a board of the mission, as
its ref (`uXjVOD6LSME~`) or its URL (`https://miro.com/app/board/uXjVOD6LSME=/`)
— and, where it acts on an item, `item_id`. The gateway writes Miro's
`miro_url` (`content_item_url` for `content_item_list_roles`) itself; an
agent that sends it is refused. Every other argument is Miro's, except:

- `invocation_source` and `is_repository`, which Miro asks agents to fill
  with facts about their own environment: never offered, never sent;
- `board_create`'s `parent_space_url`, `image_create`'s `image_token`,
  `prototype_create`'s `html_tokens` and `image_tokens`: not offered, so
  `prototype_create` requires `html_contents`.

Left out (refused as unknown tools, the reason in `LEFT_OUT_UPSTREAM_TOOLS`):
`board_search_boards` (discovery only), the three tools that hand out an
upload URL, `user_who_am_i`, `user_search_organization_users`,
`get_brand_context`, `board_create_format`, `board_move`,
`board_move_to_team`, `board_restore`, and the space, section and blog-post
tools.

## Risks and presets

| Preset        | What it allows                                                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read-only`   | Read the boards, their content and comments, the space they are in, Miro's format guides                                                                   |
| `scribe`      | + add content, fill tables, write comments; never deletes, so never updates what is drawn                                                                  |
| `facilitator` | + see who can open a board, rename it, record a walkthrough; update what is drawn, delete, create boards and share a board — each of those four asks first |

An update of the canvas (`canvas_update_from_svg`) may delete what the new
SVG no longer holds: it needs `item-delete` and `frame-delete`. Sharing a
board or changing a role on it (`board-share`) gives whoever is named
everything on the board, possibly outside the company: it is in
`facilitator` only, behind an approval.

## Refreshing the tool list

With a Miro account:

```
npm run capture-upstream-tools --workspace @vaubaan/plugin-miro
```

Open the printed address, sign in, choose a team, allow. The script writes
`src/upstream-tools.json` verbatim and prints the differences with the
previous model; then run the plugin's tests, align the model, bump the
version. Remove the throw-away app "Vaubaan Gateway (tool list capture)"
from your Miro profile afterwards.
