---
title: Notion provider plugin
tracks:
  - plugins/notion/src/
  - plugins/notion/README.md
last_reviewed: 2026-10-27
---

# Notion provider plugin — handbook

`@vaubaan/plugin-notion`: pages, blocks, databases and comments under the top-level pages and
databases shared with one internal connection. No administration, no file upload.

## Start here

- [`src/ancestry.ts`](../../../plugins/notion/src/ancestry.ts) — the walk proving a call is under its root.
- [`src/classify.ts`](../../../plugins/notion/src/classify.ts) and
  [`src/content.ts`](../../../plugins/notion/src/content.ts) — one reader (`readCall`) turns
  arguments into a typed call; JSON values checked there.
- [`src/execute.ts`](../../../plugins/notion/src/execute.ts) — walk, then requests from the typed call.
- [`src/discovery.ts`](../../../plugins/notion/src/discovery.ts) — what counts as a root.

## Invariants

- **The classifier never infers the root from an id**: every content tool takes `root` (or the
  single Notion resource), and all slices are emitted under `root[R]`. The data model is flat under
  the root because a slice cannot say "any depth below"; `execute` proves the real depth.
- **`execute` walks every id to `R` before anything leaves**, reads included (the mission is a
  confidentiality boundary): the target, a new page's parent, an entry's data source,
  `after_block_id`, relation targets, page/database mentions and `link_to_page` in written content,
  a synced copy's original. Refused on a `workspace` / `agent_id` parent, an unknown parent type, an
  ancestor `404`, a cycle, an answer whose `id` differs, or more than `MAX_ANCESTRY_DEPTH` levels.
- **Walk first, checks after**: an object outside the root is refused only as "not under the shared
  root", never by its type or parent, so nothing about another root leaks.
- Memo within one call only; pages move at any time, so every call pays its walk. Secondary walks
  share bounded budgets (`MAX_*` in `execute.ts`) and decline the call when spent.
- Search results not proven under the root are **dropped silently**, never counted: a count would
  reveal other roots' titles.
- `delete_block` never trashes a page or database: the target is refused if it is one, and its
  descendants are scanned (unless `has_children: false`) and refused on any `child_page` /
  `child_database` or an exhausted budget. Synced copies are not scanned (their children belong to
  the original).
- Undeclared arguments are refused in classify and execute, **and** requests are built field by
  field, because `properties`, `children`, `filter`, `rich_text`… are forwarded as checked JSON.
  Deliberately never sent: `erase_content`, `is_archived`, a free `parent`, comment `display_name`
  (would let the agent sign as anybody).
- Writes send `notifications: { mode: "silent" }` where the endpoint accepts it; `notifications` is
  not an argument. `update_block` and comments have no silent mode, so a mention there notifies.
- Ids go through `notionId` (`src/ids.ts`) in canonical dashed lower case, both in classify and
  execute ([ADR](../../decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md)).

## Traps

- `Notion-Version: 2026-03-11` is a constant (`api.ts`): a database is a container of data sources;
  schema and rows live on the data source, access on the database. `archived` is gone (`in_trash`),
  append takes `position`.
- A rollup over another root's database carries its aggregates in; accepted.
- Accepted: a page moved between walk and write is written in its new place.
- Synced originals: rewriting or deleting one changes copies possibly under another root; the API
  cannot list copies, so it is not refused (the `block-delete` reason warns).
- Notion's rate limit (180 req/min per connection, 600 on Business) counts requests; one tool call
  fans out to 1-~100. No retry: a `503` may follow a saved write.
- Unverified (check before 1.0): internal token expiry; trashing takes the subtree; `GET` answers on
  trashed pages; two-way relation writes.

## Outside the repo

- Only an **internal connection** token fits (one workspace, reaches what is shared with it).
  `verify` refuses OAuth and personal access tokens (they act as a person, across everything they
  can open).
- Created as Workspace Owner at `app.notion.com/developers/connections`, "No user information";
  capabilities Read / Insert / Update content, Read / Insert comments; share only the top-level
  pages the agents need.

## Debug

- A page just shared is missing → search indexing lags; it appears at the next discovery refresh.
- `403 restricted_resource` → a capability is not ticked on the connection.
