---
title: Notion provider plugin
status: current
date: 2026-10-16
last_synced: 2026-10-16
tracks:
  - plugins/notion/src/
  - plugins/notion/tests/unit/
  - plugins/notion/README.md
---

# Notion provider plugin

> **Sources.** Provider facts were checked on 2026-10-16 against the
> official developer documentation at `developers.notion.com`: first with
> WebFetch (a one-off exception to the Context7 rule, authorised by the
> product owner while Context7's quota was exhausted), then in Context7, and
> for the product owner's decisions (silent notifications, block update and
> deletion, restore) in Context7 first and WebFetch where Context7's pages
> did not carry the field ("Sources" at the end says which fact came from
> where). A fact the documentation does not state is marked ⚠ and listed in
> §7.

`@vaubaan/plugin-notion` 0.1.0, tool prefix `notion__`, catalog version 1.
Scope **(PO)**: "pages + databases" — search, read a page and its blocks,
create a page, update a page's title, icon or cover, add, rewrite and delete
blocks, move a page to the trash and back; read and query a database (its
data sources), create and update an entry; read and create comments. No
administration: no user listing, no sharing, no database schema change, no
file upload.

Notion now calls an integration a **connection** ("internal connection",
"public connection"); this page uses Notion's current word.

Repository precedents this design follows:

- **A target bound to its resource at run time** — Vercel's "deployment
  binding" (`verifiedDeploymentId` in `plugins/vercel/src/execute.ts`),
  Resend's broadcast check, Cloudflare DNS's record read-back. Notion needs
  the same guard on every call, reads included (§5.1).
- **A synthetic tool that calls nothing** — Resend's `describe_zones`
  (`notion__list_roots`).
- **Discovery filtered to what a mission may see** — Cloudflare DNS's
  `list_zones` (search results filtered to the root, §5.2).

## 0. Version pinned and what it changes

The plugin sends **`Notion-Version: 2026-03-11`** on every request
(`NOTION_VERSION` in `src/api.ts`), a constant of the plugin, never
configuration. It is the latest version on 2026-10-16. It keeps the
data-source model introduced by `2025-09-03` and adds three breaking changes
of its own; the plugin is written against both sets.

What `2025-09-03` changed for databases, and how the model uses it:

| Before (`2022-06-28`)                                     | Since `2025-09-03`                                                                                                                                                         | In this model                                                                                                                                                 |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A database is one table: schema, rows, query              | A **database** contains one or more **data sources**; the schema (`properties`) and the rows belong to a data source. Access is managed at the database level              | Two entities: `database` (the container, what a person sees and shares) and `data-source` (schema + entries). A database **resource** ref is the database id. |
| `POST /v1/databases/{id}/query`                           | `POST /v1/data_sources/{id}/query`                                                                                                                                         | `notion__query_data_source` takes a `data_source_id`.                                                                                                         |
| `GET /v1/databases/{id}` returns the schema               | `GET /v1/databases/{id}` returns the container with `data_sources: [{ id, name }]`; `GET /v1/data_sources/{id}` returns the schema, its `parent` and its `database_parent` | `notion__get_database` lists the data sources; `notion__get_data_source` reads a schema.                                                                      |
| Page parent `{ type: "database_id" }`                     | Page parent `{ type: "data_source_id", data_source_id, database_id }` (the `database_id` "provided for convenience")                                                       | Creating an entry names its data source; the ancestry walk reads the `database_id` a page parent carries.                                                     |
| Search filter `{ property: "object", value: "database" }` | `value: "data_source"`; results are data source objects, one per data source                                                                                               | Discovery finds databases through their data sources (§6.2).                                                                                                  |
| Relation write names a `database_id`                      | Relation writes must name `data_source_id` only                                                                                                                            | Relation **writes** are bound like every other target (§5.4).                                                                                                 |

What `2026-03-11` changes on top:

| `2025-09-03`                                   | `2026-03-11`                                                                                                    | In this model                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `archived` accepted (deprecated since 2024-04) | `archived` gone from requests and responses; `in_trash` only                                                    | `trash_page` / `restore_page` send `in_trash`; the plugin reads `in_trash` only.         |
| Append children: flat `after` string           | `position`: `{ type: "end" }` (default), `{ type: "start" }`, or `{ type: "after_block", after_block: { id } }` | `append_blocks` takes `position` (`end` / `start` / `after_block`) and `after_block_id`. |
| Block type `transcription`                     | renamed `meeting_notes`; not creatable with the general block endpoints                                         | Refused in `children` (§2).                                                              |

## 1. Data model

`src/data-model.ts`. One plane, `content`. Notion's tree is recursive (a
page holds blocks, blocks hold blocks and sub-pages, to any depth), and a
slice cannot express "any depth below": the model is therefore **flat under
the resource** — every page, block, database and data source of a resource
is a direct child of `root` in the slice, whatever its real depth. That is
what the classifier can say purely; the real depth is proven by `execute`
(§5.1).

```
root[<root id>]                       the resource: one top-level page or database shared with the connection
├─ page[<page id>]                    any page under the root, the root page itself included
│    ├─ subpage                       verb leaf: create a page under this page
│    ├─ properties                    verb leaf: overwrite the page's title / icon / cover
│    ├─ trash                         verb leaf: move the page (and everything under it) to the trash
│    └─ restore                       verb leaf: bring the page back from the trash
├─ block[<block id>]                  any block under the root; a page id is a block id too.
│    │                                A write on the block itself (`block[B].W`) rewrites its content
│    ├─ children                      verb leaf: append blocks under this block
│    ├─ delete                        verb leaf: move the block to the trash
│    └─ comment[<discussion id>]      comments on this block or page; `comment` alone = a new discussion
├─ database[<database id>]            a database container under the root, or the root itself
├─ data-source[<data source id>]      a data source of such a database (schema)
│    └─ entry[<page id>]              an entry (row) of the data source; `entry` alone = a creation
└─ root-trash                         verb leaf: the root page itself goes to the trash
```

| Entity        | Parent        | Cardinalities      | Notes                                                               |
| ------------- | ------------- | ------------------ | ------------------------------------------------------------------- |
| `root`        | —             | `one`              | A page or a database, as discovery found it (`metadata.kind`).      |
| `page`        | `root`        | `one`, `unbounded` | Flat: depth is proven at run time.                                  |
| `subpage`     | `page`        | `one`              | Verb leaf.                                                          |
| `properties`  | `page`        | `one`              | Verb leaf.                                                          |
| `trash`       | `page`        | `one`              | Verb leaf.                                                          |
| `restore`     | `page`        | `one`              | Verb leaf.                                                          |
| `block`       | `root`        | `one`              | Flat.                                                               |
| `children`    | `block`       | `one`              | Verb leaf.                                                          |
| `delete`      | `block`       | `one`              | Verb leaf.                                                          |
| `comment`     | `block`       | `one`, `unbounded` | Identified by its discussion id when it is a reply.                 |
| `database`    | `root`        | `one`              | Flat.                                                               |
| `data-source` | `root`        | `one`, `unbounded` | Flat (its database is checked at run time).                         |
| `entry`       | `data-source` | `one`, `unbounded` | An entry is a page; reached by `entry` when the tool acts on a row. |
| `root-trash`  | `root`        | `one`              | Verb leaf (`root[R].root-trash.W`).                                 |

The leaf for trashing the root is named `root-trash`, not `trash`: the data
model validator keys entities by name within a plane, so two `trash`
entities with different parents would be ambiguous.

**Resource (PO).** One resource per **top-level** page or database shared
with the connection: a shared object whose parent is `{ type: "workspace" }`,
or whose parent the connection can neither find nor read. Sharing a parent
page grants access to all of its child pages (internal connections guide),
so everything below a root belongs to it. `ref` = the object's id in
canonical form ("Identifiers"), `displayName` = its title,
`metadata.kind` = `page` or `database`.

**Environment: none (PO, decision 1).** No entity is `envScopable`, no risk
carries `acceptable_in_envs`, the plugin declares no `envOf`. A root is
written whatever label its owner gives it; the presets put `gate: approval`
on the destructive operations instead.

## 2. Tool → slice mapping

`src/tools.ts` (declarations, `notionToolTitles`), `src/classify.ts`.
Every content tool takes `root` — the resource ref — as an explicit
argument. A `root` given must be one of the mission's Notion resources,
otherwise `denied`; absent, the mission's single Notion resource; none or
several, `denied` (`resolveRoot` in `src/ids.ts`). **The classifier never
infers the root from a page or block id**: it cannot (no network), and
guessing would let one resource's budget price a call on another.

`R` = the resolved root ref. Ids are canonical ("Identifiers").

| Tool                          | Arguments (required in **bold**)                                                         | Slice(s)                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `notion__list_roots`          | —                                                                                        | `notion.root[R].R` for each Notion resource of the mission (synthetic: no request)                    |
| `notion__search_content`      | `root`, `query`, `object` (`page` \| `data_source`), `sort`, `page_size`, `start_cursor` | `notion.root[R].page[*].R` unless `object` is `data_source`; `….data-source[*].R` unless it is `page` |
| `notion__get_page`            | `root`, **`page_id`**                                                                    | `notion.root[R].page[P].R`                                                                            |
| `notion__list_block_children` | `root`, **`block_id`**, `depth` (1–3, default 1), `page_size`, `start_cursor`            | `notion.root[R].block[B].R`                                                                           |
| `notion__get_database`        | `root`, **`database_id`**                                                                | `notion.root[R].database[D].R`                                                                        |
| `notion__get_data_source`     | `root`, **`data_source_id`**                                                             | `notion.root[R].data-source[S].R`                                                                     |
| `notion__query_data_source`   | `root`, **`data_source_id`**, `filter`, `sorts`, `page_size`, `start_cursor`             | `notion.root[R].data-source[S].entry[*].R`                                                            |
| `notion__create_page`         | `root`, **`parent_page_id`**, **`title`**, `children`, `icon`, `cover`                   | `notion.root[R].page[P].subpage.W` (P = `parent_page_id`)                                             |
| `notion__update_page`         | `root`, **`page_id`**, `title`, `icon`, `cover` (at least one)                           | `notion.root[R].page[P].properties.W`                                                                 |
| `notion__append_blocks`       | `root`, **`block_id`**, **`children`**, `position`, `after_block_id`                     | `notion.root[R].block[B].children.W`                                                                  |
| `notion__update_block`        | `root`, **`block_id`**, **`type`**, **`content`**                                        | `notion.root[R].block[B].W`                                                                           |
| `notion__delete_block`        | `root`, **`block_id`**                                                                   | `notion.root[R].block[B].delete.W`                                                                    |
| `notion__trash_page`          | `root`, **`page_id`**                                                                    | `notion.root[R].page[P].trash.W`; **and** `notion.root[R].root-trash.W` when `P` = `R`                |
| `notion__restore_page`        | `root`, **`page_id`**                                                                    | `notion.root[R].page[P].restore.W`                                                                    |
| `notion__create_entry`        | `root`, **`data_source_id`**, **`properties`**, `children`, `icon`                       | `notion.root[R].data-source[S].entry.W`                                                               |
| `notion__update_entry`        | `root`, **`data_source_id`**, **`page_id`**, **`properties`**, `icon`                    | `notion.root[R].data-source[S].entry[P].W`                                                            |
| `notion__list_comments`       | `root`, **`block_id`**, `page_size`, `start_cursor`                                      | `notion.root[R].block[B].comment[*].R`                                                                |
| `notion__create_comment`      | `root`, **`block_id`**, **`rich_text`**, `discussion_id`                                 | `notion.root[R].block[B].comment.W`, or `….comment[Q].W` when `discussion_id` = Q is given            |

Titles (`toolTitles`): "List the shared roots", "Search pages and
databases", "Read a page", "Read a page's content", "Read a database", "Read
a database's schema", "Query a database", "Create a page", "Update a page",
"Add content to a page", "Rewrite a block of a page", "Delete a block of a
page", "Move a page to the trash", "Bring a page back from the trash", "Add
a database entry", "Update a database entry", "Read comments", "Add a
comment".

One reader, `readCall(tool, args, resources)`, turns the arguments into a
typed call (`NotionCall`): the root resolved, every id canonical, every
forwarded JSON value checked by `src/content.ts`. `classify` maps that call
to its slices (`slicesOf`); `execute` builds its requests from the same
call, never from `args`.

**Refused by the classifier** (`denied`, audited, never executed; refused
again by `execute`, which applies the same reader):

- an unknown tool; `root` outside the mission, malformed, or absent with
  zero / several resources; any id outside its grammar; a Notion page URL
  given as an id (the refusal says to pass the 32 hexadecimal characters);
- `depth` outside 1–3; `page_size` outside 1–100; a malformed
  `start_cursor`; a search `object` other than `page` / `data_source`, a
  `sort` other than `{ direction, timestamp: "last_edited_time" }`;
- `update_page` with nothing to change; `position` other than `end`,
  `start`, `after_block`; `after_block_id` without `after_block` or the
  reverse;
- `update_block` / `delete_block` on the root itself (a page is changed
  with `update_page` and trashed with `trash_page`); `trash_page` of a
  database root;
- Notion's request limits, refused up front (kit step 3: "a limit the
  provider needs is refused by your classifier"): more than 100 items in
  any array, any string over 2 000 characters (text content, URLs), more
  than two levels of nesting under a `children` array, more than 1 000
  blocks in one request (request limits page; the 500 KB payload ceiling is
  left to Notion's `400`); a JSON value nested deeper than 24 levels;
- a new block (in `children`, at any level) whose `type` is missing, not in
  the allow-list of creatable types (`CREATABLE_BLOCK_TYPES`, from the
  append-block-children reference), or one of `child_page` /
  `child_database` (their own endpoints), `link_preview`, `meeting_notes`,
  `transcription`, `unsupported` (not creatable through the block
  endpoints); a block object carrying a key other than `object`, `type` and
  its type's object; a `synced_block` with `synced_from` set (a copy: §5.7);
- a file upload anywhere in a forwarded value — a `file_upload` key or
  `type: "file_upload"` (file uploads are out of scope, **PO**);
- a mention (`page`, `database`, `user`), a `link_to_page` target, a
  relation target or a person whose id is not a Notion id;
- on `update_block`, a `type` outside `UPDATABLE_BLOCK_TYPES` (text,
  heading, list, to-do, toggle, quote, callout, code, equation, media,
  bookmark, embed, table, table row), and `content.children` (a block's
  children are not updated by that endpoint);
- on `create_entry` / `update_entry`, a value for a property Notion computes
  (`formula`, `rollup`, `unique_id`, `created_time`, `created_by`,
  `last_edited_time`, `last_edited_by`, `button`, `verification`);
- an `icon` other than an emoji, a Notion icon or an `https:` external
  image; a `cover` other than an `https:` external image;
- an undeclared argument (below).

### Undeclared arguments

The plugin **refuses undeclared arguments**, in `classify` and again in
`execute` (`undeclaredArgument(tool, args)` in `src/classify.ts`, wrapping
`undeclaredArgumentDenial` with `declaredArgumentsOf(notionTools)`), **and**
builds every request field by field from the call `readCall` returned.
Both, because the values of `properties`, `children`, `filter`, `sorts`,
`rich_text` and a block's `content` are forwarded as JSON (checked by
`content.ts`, not rebuilt), so the top level is the one place an unpriced
field could slip in. Fields the endpoints accept and this model leaves out,
each refused with a sentence:

- `PATCH /v1/pages/{id}`: **`erase_content`** ("deletes all block
  children … can't be reversed through the API"), `is_archived` (Notion's
  _archive_, "separate from `in_trash`"), `template`, `is_locked`,
  **`notifications`** (the plugin sets it itself, §5.11),
  `filter_properties`;
- `POST /v1/pages`: `markdown`, `content`, `template`, `position`,
  `allow_async`, `notifications`, a free `parent` (including `database_id`
  and `workspace`);
- `PATCH /v1/blocks/{id}/children`: the removed `after`, `notifications`;
- `POST /v1/data_sources/{id}/query`: `is_archived`, `result_type` (the
  executor sends `result_type: "page"` itself), `filter_properties`;
- `POST /v1/search`: `filter.in_trash`;
- `POST /v1/comments`: `markdown`, `attachments` (file uploads),
  **`display_name`** (a `custom` name would let the agent sign a comment as
  anybody).

No `routing` argument.

## 3. Catalog and presets

`src/risk-catalog.yaml`: 14 named risks + the fallback, none env-scoped
(decision 1). Write patterns do not overlap: each write slice touches
exactly one named risk, except trashing the root page, which emits two
slices and touches `page-trash` **and** `root-trash`
(`tests/unit/risk-catalog.test.ts`).

| Risk                         | Pattern(s)                                                                                                       | Vector (rev / blast / data / cost / vis / pers)          | Calls/min max |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------- |
| `notion.read-content`        | `root[*].R`, `root[**].page[**].R`, `root[**].block[*].R`, `root[**].database[*].R`, `root[**].data-source[*].R` | reversible / single / data / free / internal / stateless | 60            |
| `notion.query-databases`     | `root[**].data-source[*].entry[*].R`                                                                             | reversible / bulk / pii / free / internal / stateless    | 30            |
| `notion.read-comments`       | `root[**].block[*].comment[*].R`                                                                                 | reversible / single / pii / free / internal / stateless  | 30            |
| `notion.page-create`         | `root[**].page[*].subpage.W`                                                                                     | reversible / single / data / free / team / posture       | 30            |
| `notion.page-update`         | `root[**].page[*].properties.W`                                                                                  | reversible / single / data / free / team / posture       | 30            |
| `notion.content-append`      | `root[**].block[*].children.W`                                                                                   | reversible / single / data / free / team / posture       | 30            |
| `notion.block-update`        | `root[**].block[*].W`                                                                                            | **costly** / single / data / free / team / posture       | 30            |
| `notion.block-delete`        | `root[**].block[*].delete.W`                                                                                     | costly / single / data / free / team / posture           | 10            |
| `notion.page-trash`          | `root[**].page[*].trash.W`                                                                                       | costly / bulk / data / free / team / posture             | 10            |
| `notion.page-restore`        | `root[**].page[*].restore.W`                                                                                     | reversible / bulk / data / free / team / posture         | 10            |
| `notion.root-trash`          | `root[*].root-trash.W`                                                                                           | costly / env / data / free / public / posture            | 2             |
| `notion.entry-create`        | `root[**].data-source[*].entry.W`                                                                                | reversible / single / data / free / team / posture       | 30            |
| `notion.entry-update`        | `root[**].data-source[*].entry[*].W`                                                                             | reversible / single / data / free / team / posture       | 30            |
| `notion.comment-create`      | `root[**].block[*].comment[**].W`                                                                                | reversible / single / data / free / team / session       | 20            |
| `notion.uncategorized-write` | `notion.**.W` (fallback)                                                                                         | costly / env / data / free / team / posture              | —             |

(Patterns abbreviated: each starts with `notion.`.) With the environment
gone, the draft's production overrides (`visibility: public` on writes,
`reversibility: costly` on overwrites) are dropped, and every write is
`visibility: team` — what a person who can see the parent sees. The two new
writes:

- **`block-update` is `costly`**: it overwrites what a person wrote, and
  the previous text survives only in Notion's page history, whose length
  depends on the plan. Its reason also says that a mention in the new text
  can notify the person it names — Notion documents no silent mode on
  update a block (§5.11).
- **`block-delete`** moves one block and the blocks nested in it to the
  trash ⚠ (nested blocks: §7); restorable in Notion (update a block with
  `in_trash: false`, which this plugin does not offer), hence `costly`, not
  `irreversible`. Never a page (§5.10).

**`page-restore` is a write with a risk of its own (decision 8).** The
vector argued: `reversibility: reversible` (the page can be trashed again);
`blast: bulk` (the page comes back with everything under it — sub-pages,
inline databases); `visibility: team` and `persistence: posture` (it
reappears, and stays, for everyone who can see where it was). The reason
it deserves its own decision rather than riding on `page-trash`: a page is
trashed because it is out of date, wrong or confidential, and bringing it
back republishes it — whoever opens the parent in between has seen it, and
a later trash does not undo that. It is the inverse of a trash, not a
harmless undo.

### Presets

| Preset      | Entries (quota, rate limit per minute, gate)                                                                                                                                                                                                                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read-only` | `read-content` 3000, 30, auto · `query-databases` 500, 10, auto · `read-comments` 500, 10, auto                                                                                                                                                                                                                                                                   |
| `reviewer`  | the three reads as `read-only` · `comment-create` 100, 5, auto                                                                                                                                                                                                                                                                                                    |
| `editor`    | `read-content` 5000, 30 · `query-databases` 1000, 10 · `read-comments` 1000, 10 · `comment-create` 200, 5 · `page-create` 200, 10 · `page-update` 300, 10 · `content-append` 500, 15 · `block-update` 300, 10 · `entry-create` 300, 10 · `entry-update` 500, 15 · `page-restore` 20, 2 — all **auto**; `page-trash` 20, 2 and `block-delete` 50, 5 — **approval** |

**In no preset, deliberately:** `notion.root-trash` (it removes a whole
resource for everyone and every mission; a mission that needs it holds it
explicitly) and the fallback (forbidden by the loader). The draft's
staging / production pairs collapse into one entry per risk, with quotas
between the two.

### Rate limits

Notion's request limits page: **180 requests a minute per connection (3 a
second on average) on most plans, 600 a minute (10 a second) on Business
and Enterprise**, plus a **separate limit shared by all connections of the
workspace**. Beyond it Notion answers `429 rate_limited` with a
`Retry-After` header; `529 service_overload` asks for the same.

The plugin plans for the lower figure, shared by every mission issued on the
connection. A tool call costs more than one request (§5.1: one per level of
the ancestry walk, plus the call itself):

| Call                                          | Requests, typical (depth 3)                     | Worst case                                           |
| --------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------- |
| `get_page`, `get_database`, `get_data_source` | 1 + 2 (the target's own `GET` is the first hop) | 1 + `MAX_ANCESTRY_DEPTH` (16)                        |
| `list_block_children`, query, comments        | 1 + 3                                           | 1 + 16, + up to 20 listings for `depth` > 1          |
| a write                                       | 1 + 3                                           | 2 + 16, + 16 per relation target or `after_block_id` |
| `search_content`                              | 1 + the filter's budget                         | 1 + `MAX_SEARCH_VERIFY_REQUESTS` (25)                |

- The preset rate limits keep one mission's realistic mix near one call a
  second: `read-only` allows 50 calls a minute in total, `reviewer` 55,
  `editor` 134 if every risk ran at its maximum at once (no realistic mix
  does). At ~4 requests a call, `read-only` at full speed reaches ~200
  requests a minute — Notion's ceiling on most plans.
- `infra_limits.calls_per_minute_max` caps what a creator can raise a risk
  to: 60 for reads, 30 for bulk queries and ordinary writes, 20 for
  comments, 10 for a trash, a restore or a block deletion, 2 for a root
  trash.
- `execute` makes **no retry** (decision 7): a `429` or a `529` is thrown
  as `UpstreamHttpError(…, status)` with `retry after <n> s` in the
  message. A retried write is also unsafe: Notion's `503` may come after a
  write that was saved.

## 4. Coverage

Every tool is covered by a named risk, none by the fallback
(`assertCatalogCoverage` in `tests/unit/plugin.test.ts`: `fallbackHits`
empty, `risksUntouched` empty, 14 risks touched).

| Tool                          | Risk(s) touched                               |
| ----------------------------- | --------------------------------------------- |
| `notion__list_roots`          | `read-content`                                |
| `notion__search_content`      | `read-content`                                |
| `notion__get_page`            | `read-content`                                |
| `notion__list_block_children` | `read-content`                                |
| `notion__get_database`        | `read-content`                                |
| `notion__get_data_source`     | `read-content`                                |
| `notion__query_data_source`   | `query-databases`                             |
| `notion__create_page`         | `page-create`                                 |
| `notion__update_page`         | `page-update`                                 |
| `notion__append_blocks`       | `content-append`                              |
| `notion__update_block`        | `block-update`                                |
| `notion__delete_block`        | `block-delete`                                |
| `notion__trash_page`          | `page-trash`; + `root-trash` on the root page |
| `notion__restore_page`        | `page-restore`                                |
| `notion__create_entry`        | `entry-create`                                |
| `notion__update_entry`        | `entry-update`                                |
| `notion__list_comments`       | `read-comments`                               |
| `notion__create_comment`      | `comment-create`                              |

## 5. Edge cases

### 5.1 Which resource a call is on — the ancestry check

**The problem.** The classifier is pure. A call names a page, block,
database or data source by id, and nothing in a Notion id says where it
lives. The connection's token reaches every page shared with it, across
every root. A mission limited to root A must not read or write a page of
root B because the agent named B's page id — and must not have that call
priced against A's budget.

**The design** (`src/ancestry.ts`, class `Ancestry`, one per call).

1. **Every tool takes `root` explicitly** (or the single root of the
   mission). The classifier checks it against the mission's resources and
   emits every slice under `root[R]`: the slice is exact about the resource
   it _claims_.
2. **`execute` proves the claim before anything else.** For the target of
   the call and every other id it acts on — the parent of a new page, the
   data source of an entry, the `after_block_id` of an append, every
   relation target, the original of a synced copy — it walks the `parent`
   chain up with `ctx.fetch` until it meets `R`. Parent shapes read (parent
   object reference): `page_id`, `block_id`, `database_id`,
   `data_source_id` (with its `database_id`), `workspace`, `agent_id`.

   | Kind met    | Request                     | Next hop read from                                                                                   |
   | ----------- | --------------------------- | ---------------------------------------------------------------------------------------------------- |
   | page        | `GET /v1/pages/{id}`        | `parent`                                                                                             |
   | block       | `GET /v1/blocks/{id}`       | `parent`                                                                                             |
   | data source | `GET /v1/data_sources/{id}` | `parent.database_id`, then `database_parent` (the database's own parent) — two levels in one request |
   | database    | `GET /v1/databases/{id}`    | `parent`                                                                                             |
   - **Proven** when an id met on the way (the target itself included)
     equals `R`, or was proven during the call. A `data_source_id` parent
     carries its `database_id`: when that is `R`, one request proves an
     entry of a database root.
   - **Refused** (`ExecutorRefusal`, before any write and before any read
     result leaves the executor) when the chain reaches `workspace` or an
     `agent_id` parent; meets a parent type it does not know or an id
     outside the grammar; meets an ancestor this token cannot read (`404
object_not_found` on an ancestor: outside every root); meets an id
     twice (a cycle); answers with an object whose `id` is not the one
     asked for; or needs more than `MAX_ANCESTRY_DEPTH` (16) levels above
     the target. Sentences: `notion: <kind> '<id>' is not under the shared
root '<R>' of this call`, or `… could not be shown to be under … within
16 levels`.
   - A `404` on the **target** itself is the provider's answer to the
     agent's call: thrown (`UpstreamHttpError`), as is any `429` / `5xx`; a
     `401` or `403` on any hop is `UpstreamAuthError` (`src/api.ts`).

3. **Reads too.** The boundary of a mission is a confidentiality boundary.
   For a read whose answer carries `parent` (`get_page`, `get_database`,
   `get_data_source`), the target's own `GET` is the first hop
   (`Ancestry.fetch`): the answer is held, the walk completes, and it is
   returned only if proven. The same first hop gives `update_page`,
   `update_entry`, `update_block`, `delete_block`, `trash_page`,
   `restore_page` and `create_comment` the facts they check (§5.4, §5.10,
   §5.8).
4. **Memo within one call, nothing across calls (decision 3).** The walk
   keeps the ids proven in and out during the call (siblings share
   ancestors). Nothing is cached between calls: a page can be moved at any
   moment, and **the SDK offers no state for it** (`credentialCache` is for
   credentials). Known limitation, not an SDK change: every call pays its
   walk.

**What it costs.** One request per level, at ~3 requests a second for the
whole connection (§3 "Rate limits"). A data source costs one request for two
levels. The `depth` argument of `list_block_children` (§5.6) pays the walk
once for a whole page body instead of once per nested block.

**What it does not cover.**

- **Time of check, time of use.** A page moved to another root between the
  walk and the write is written in its new place. The window is one
  request; no tool of this plugin moves pages. Accepted.
- **The root is the claim, not a proof of "least" root.** Roots are
  top-level by construction (discovery); if the owner later shares a parent
  of root A, missions holding A keep working (the walk still meets A).

**Alternatives rejected.** _Infer the root in the classifier from resource
metadata_ (stale as soon as a page is created or moved, unbounded);
_classify every call on `root[*]`_ (the slice would no longer name the root
whose budget prices it); _check only writes_ (a mission on "Marketing"
could read "Board").

### 5.2 Search results outside the mission

Notion's search covers every page and data source shared with the
connection, matches titles only, and its filter takes `object` and
`in_trash`, **no ancestor filter**. `execute` therefore **filters the
results to the named root** (`search` in `src/execute.ts`): each result
carries its `parent`, the walk of §5.1 runs with the memo shared across
the result set, and a result is returned only when proven. A result proven
outside, of an unknown kind, or not proven within
`MAX_SEARCH_VERIFY_REQUESTS` = 25 extra requests, is dropped; the answer
carries `results_hidden: <n>`, Notion's `next_cursor`, `has_more` and
`request_status` when present. Hidden results are never named. `page_size`
is always sent (default 20).

Search is also not exhaustive and its index lags; the tool's description
says so and points the agent to the data source query. One root per search
(decision 2).

### 5.3 Creating a page: its parent

`create_page` takes `parent_page_id`, never a free `parent` object. The
parent is walked like a target: the new page lands under `R` because its
parent does. A page at the top of the workspace is not offered (an internal
connection must name a page or data source parent, and it would belong to
no resource). Creating in a database root is `create_entry`. A page under a
page has a `title` and no other property; the executor writes it as
`properties.title`.

### 5.4 Database entries, relations, rollups and people

- **Entry or page.** An entry is a page whose parent is a data source; the
  classifier cannot tell them apart by id. Two tools with their own risks,
  and `execute` checks the claim on the target's first hop: `update_page`
  refuses a page whose parent is a data source ("an entry of a database —
  change it with `notion__update_entry`"); `update_entry` refuses a page
  whose `parent.data_source_id` is not the `data_source_id` named, and the
  walk goes through that data source to `R`.
- **Relation writes.** Every id of a `relation` value is walked to `R`; one
  outside is refused, before the write (decision 4). A relation to a
  database of another root is therefore not writable. That a write to a
  two-way relation changes the related page's value is implied by the
  synced property, not stated ⚠.
- **Rollups and formulas on read** are returned as Notion computes them
  (decision 5). Notion computes them only over pages the connection can
  read, so nothing unshared leaks; but a rollup over a database of another
  root carries that root's aggregated values into this mission. Recorded,
  accepted. An empty relation or rollup may mean "not shared": the
  description of `get_page` says so.
- **People and mentions** take user ids, read by `notionId`; the plugin
  does not list users (**PO**). Writing a person or a mention on a page or
  an entry notifies nobody (§5.11); in a comment or a rewritten block it
  does.
- **Linked data sources.** A linked view inside root A of a data source
  under root B: `query_data_source` walks the data source to its database,
  under B, and refuses.
- **Queries return pages only**: the executor sends `result_type: "page"`.

### 5.5 Trash and restore

`trash_page` sends `in_trash: true`, `restore_page` `in_trash: false`, on
`PATCH /v1/pages/{id}` (trash page reference); the API cannot delete a page
permanently. Both need Update content. Trashing a page takes its subtree
with it ⚠, hence `blast: bulk`. The root page itself also emits
`root[R].root-trash.W` (the classifier compares the canonical `page_id`
with `R`), so it needs `root-trash`, in no preset; trashing a database root
is refused by the classifier.

**Restore.** The target's first hop is `GET /v1/pages/{id}` on a page in the
trash; that Notion answers it for a trashed page, and that the walk can
then read ancestors that are themselves in the trash, are not stated ⚠. If
it answers 404, the restore fails as a provider answer (thrown) and nothing
is sent. Restoring the root page needs only `page-restore`.

### 5.6 Reading a page's content: `depth`

`get_page` returns properties, not content; content is the block tree, read
with `GET /v1/blocks/{id}/children` (a page id is accepted as the block id),
first level only. `list_block_children` with `depth` 2 or 3 expands nested
blocks in the same call, after **one** walk for `block_id` — every block met
below is under it by construction. Nested listings ask for 100 children and
do not follow their cursor (`children_has_more: true` says so). Ceilings:
`MAX_BLOCKS_PER_CALL` = 500 and `MAX_CHILD_REQUESTS` = 20 listings; beyond
them, and for a `child_page` / `child_database` (read with its own call), a
block is not expanded and the answer lists it under `not_expanded` with the
reason.

### 5.7 Synced blocks

A synced block is an original (`synced_from: null`) or a copy
(`synced_from: { type: "block_id", block_id }`) whose children mirror the
original, which may live elsewhere. On read, a copy is expanded only when
its original is proven under `R` (`not_expanded` otherwise); listing the
children of a copy, or appending to one, first proves its original. On
write, appending a copy is refused by the classifier, and a synced block
cannot be rewritten (`update_block` allow-list).

### 5.8 Comments

`list_comments` takes `block_id`, "a Notion block or page", and returns the
unresolved comments. `create_comment` sends exactly one of `parent.page_id`,
`parent.block_id` or `discussion_id`: the executor picks `page_id` when the
walked target is a `child_page` block, `block_id` otherwise. A reply's
`discussion_id` cannot be looked up on its own: `execute` lists the comments
of `block_id` (at most `MAX_REPLY_LOOKUP_PAGES` = 5 pages of 100) and refuses
a discussion not found there — so a reply cannot land on a discussion of
another root, nor on a resolved one.

### 5.9 Content is attacker-influenced

Pages, comments and entries are written by people, inside and sometimes
outside the company. Everything the plugin returns is provider text; the
plugin reads none of it as an instruction. Said in the reason of
`read-content`.

### 5.10 Rewriting and deleting a block

- **Same check as every write (decision 11).** Both read the target with
  `GET /v1/blocks/{id}` (first hop), then walk it to `R`.
- **`update_block`** takes the block's `type` and the new object for that
  type; the executor sends `{ [type]: content }` to `PATCH /v1/blocks/{id}`.
  The classifier checks `type` against `UPDATABLE_BLOCK_TYPES` and `content`
  with the same limits and nested-id rules as new blocks, without
  `children`; the executor refuses a block whose real type is not the one
  given (`is a 'paragraph', not a 'to_do'`), so the agent cannot change a
  block's type, nor a type check be bypassed by lying about it.
- **`delete_block`** sends `DELETE /v1/blocks/{id}`, which "sets a Block
  object, including page blocks, to `in_trash: true`". A page id is a
  block id, so this endpoint would trash a page under the cheaper
  `block-delete`: the executor refuses a target of type `child_page`
  ("move it to the trash with `notion__trash_page`") or `child_database`,
  and the classifier refuses the root itself.

### 5.11 Notifications are silent

Decision 12. The field is **`notifications: { mode: "silent" }`** (values
`default` and `silent`). Read on 2026-10-16: Context7's pages for these
endpoints did not carry it; WebFetch on the references found it on
**update page** ("Set mode to `silent` to skip page update notifications,
@mention notifications, …"), **create a page** and **append block
children**. `silent` suppresses notifications to people following the page
("Notify me"), to people the content @mentions and to people a change adds
to a Person property. It does not stop database automations (including
their "Send notification to" actions), reminders, webhooks, page history or
audit logs — the reason of `entry-create` says automations still run.

| Endpoint (tool)                                                                      | Sent                                                                 |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `POST /v1/pages` (`create_page`, `create_entry`)                                     | `notifications: { mode: "silent" }`                                  |
| `PATCH /v1/pages/{id}` (`update_page`, `update_entry`, `trash_page`, `restore_page`) | `notifications: { mode: "silent" }`                                  |
| `PATCH /v1/blocks/{id}/children` (`append_blocks`)                                   | `notifications: { mode: "silent" }`                                  |
| `PATCH /v1/blocks/{id}` (`update_block`)                                             | nothing: not documented on that endpoint ⚠                           |
| `DELETE /v1/blocks/{id}` (`delete_block`)                                            | nothing: the endpoint takes no body                                  |
| `POST /v1/comments` (`create_comment`)                                               | nothing: "None of the request schemas include a notifications field" |

The agent cannot change it: `notifications` is not a declared argument of
any tool, so a call that carries it is refused (§2).

## 6. Credential, discovery, execution, tests

### 6.1 Credential (**PO**: `api-key`, token first)

`src/credential.ts`. One `api-key` spec, no alternative, no company app: an
internal connection is made per workspace by its owner (ADR
[`company-apps-kept-where-they-add-something`](../../decisions/company-apps-kept-where-they-add-something.md),
D2 "token first";
[`token-connections-beside-the-integration-app`](../../decisions/token-connections-beside-the-integration-app.md)
D1 for `label`, `guide`, `verify`). A public connection (OAuth) is out
(decision 9).

Notion has three kinds of token: an **internal connection** token, static,
tied to one workspace, reaching only what is shared with the connection; a
**public connection**'s OAuth token; and a **personal access token**, which
"acts as the user who created it", reaches whatever its creator can open,
and expires after 7 days to 1 year. Only the first matches the resource
model, so `verify` refuses the others (decision 13).

- `label`: "internal connection token".
- Field `api_token`: `secret: true`, required, `pattern` `^\S{20,512}$`
  and nothing more: tokens made since 2024-09-25 start `ntn_`, older
  `secret_` tokens "will continue to work", and Notion advises against
  validating its tokens with a regular expression. Placeholder `ntn_…`.
- `createUrl`: `https://app.notion.com/developers/connections`.
- `verify(ctx)` (`verifyNotionToken`): `GET /v1/users/me`. The answer is a
  bot user whose `bot.owner` is `{ type: "workspace", workspace: true }`
  for an internal connection and `{ type: "user", … }` for a personal
  access token: anything but a workspace-owned bot throws
  `UpstreamAuthError` ("not an internal connection token … not a personal
  access token"), and nothing is stored. `account` = `bot.workspace_name`,
  else `bot.workspace_id`; `expiresAt` = `null` (no expiry documented for an
  internal connection ⚠). A `401` throws `UpstreamAuthError`.
- `guide`: four steps (create the internal connection as a Workspace Owner;
  tick the capabilities, No user information; copy the token; share only
  the top-level pages and databases the agents need). Permissions: `Read
content` (read) → the seven read tools including `list_roots`; `Insert
content` (read-write) → `create_page`, `append_blocks`, `create_entry`;
  `Update content` (read-write) → `update_page`, `update_block`,
  `delete_block`, `trash_page`, `restore_page`, `update_entry`; `Read
comments` (read) → `list_comments`; `Insert comments` (read-write) →
  `create_comment`. `recommendedExpiryDays`: `null`.
- `manualRevocation` (on the plugin): refresh the token on the
  Configuration tab, or remove the connection from the shared pages.
  Whether refreshing invalidates the old token at once is not stated ⚠.

### 6.2 Discovery

`src/discovery.ts`. `discoverResources` pages through `POST /v1/search`
(`page_size` 100) for pages, then for data sources (`filter: { property:
"object", value: "data_source" }`), up to `MAX_SEARCH_PAGES` = 20 per kind.
Results in the trash are ignored. Notion guarantees that "any pages or
databases that are directly shared with a connection are guaranteed to be
returned" — and a root is directly shared. It keeps:

- a **page** whose parent is `workspace`, or whose parent (page, block,
  database, data source — or the database a data-source parent names) is
  not in the set found, confirmed with one `GET` on that parent: a `404`
  makes the page a root, a readable parent (a block of a shared page, which
  search does not list) means it is not;
- a **database**, from each data source's `parent.database_id`, by the same
  rule on its `database_parent` (read with `GET /v1/databases/{id}` when the
  data source does not carry it). Its title is the data source's.

At most `MAX_DISCOVERED_ROOTS` = 200. Discovery fails (rather than silently
truncating) when a search does not end within `MAX_SEARCH_PAGES` or more
than 200 roots are found; every id goes through `notionId`, every payload
through a type guard, and a payload it does not recognise fails discovery.
A provider failure while probing a parent is thrown. Search indexing is not
immediate: a page shared a moment ago may appear only at the next refresh.

### 6.3 Execution

`src/execute.ts`, `src/api.ts`.

- Base `https://api.notion.com/v1` (`NOTION_API_BASE`), headers
  `Authorization: Bearer <token>`, `Notion-Version: 2026-03-11`,
  `Content-Type: application/json` when there is a body. `ctx.fetch` only;
  the token is read with `expectCredentialKind`, and a credential without
  `api_token` throws before any request. The body of `executeNotion` runs
  under `declining`.
- `execute` applies `undeclaredArgument` and `readCall` first and builds
  each request from the call they return; then the ancestry check (§5.1)
  for every id the call acts on; then the call. Declines: `ExecutorRefusal`
  → `isError`. Failures: `401` and `403` (`restricted_resource`, a
  capability the connection lacks) → `UpstreamAuthError`; any other failed
  status → `UpstreamHttpError`, with Notion's text (500 characters at most)
  and `Retry-After` in the message.
- `list_roots` calls nothing: it returns the mission's Notion resources
  (`id`, `title`, `kind`).

| Tool                  | Requests, after the walk                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `list_roots`          | none                                                                                                                                 |
| `search_content`      | `POST /v1/search` (`query`, `sort`, `filter.object`, `page_size`, `start_cursor`), then the filter of §5.2                           |
| `get_page`            | `GET /v1/pages/{page_id}` (the first hop, returned once proven)                                                                      |
| `list_block_children` | `GET /v1/blocks/{block_id}` (first hop) then `GET /v1/blocks/{block_id}/children?page_size=&start_cursor=` (× up to 20 with `depth`) |
| `get_database`        | `GET /v1/databases/{database_id}` (the first hop)                                                                                    |
| `get_data_source`     | `GET /v1/data_sources/{data_source_id}` (the first hop)                                                                              |
| `query_data_source`   | `POST /v1/data_sources/{data_source_id}/query` (`filter`, `sorts`, `page_size`, `start_cursor`, `result_type: "page"`)               |
| `create_page`         | `POST /v1/pages` (`parent: { type: "page_id", page_id }`, `properties.title`, `children`, `icon`, `cover`, `notifications`)          |
| `update_page`         | `PATCH /v1/pages/{page_id}` (`properties.title`, `icon`, `cover`, `notifications`)                                                   |
| `append_blocks`       | `PATCH /v1/blocks/{block_id}/children` (`children`, `position` unless `end`, `notifications`)                                        |
| `update_block`        | `PATCH /v1/blocks/{block_id}` (`{ [type]: content }`)                                                                                |
| `delete_block`        | `DELETE /v1/blocks/{block_id}`                                                                                                       |
| `trash_page`          | `PATCH /v1/pages/{page_id}` (`in_trash: true`, `notifications`)                                                                      |
| `restore_page`        | `PATCH /v1/pages/{page_id}` (`in_trash: false`, `notifications`)                                                                     |
| `create_entry`        | `POST /v1/pages` (`parent: { type: "data_source_id", data_source_id }`, `properties`, `children`, `icon`, `notifications`)           |
| `update_entry`        | `PATCH /v1/pages/{page_id}` (`properties`, `icon`, `notifications`)                                                                  |
| `list_comments`       | `GET /v1/comments?block_id=&page_size=&start_cursor=`                                                                                |
| `create_comment`      | (reply: `GET /v1/comments?block_id=` ≤ 5 pages) then `POST /v1/comments` (`parent` or `discussion_id`, `rich_text`)                  |

Pagination: `page_size` is always sent (20 for search and comments, 50 for
children and queries, 100 in discovery and nested listings, since Notion
documents two different defaults); `start_cursor` is the previous
`next_cursor`, in the query string of a `GET` and the body of a `POST`.

### Identifiers

One grammar per kind, in `src/ids.ts`, read by `classify` and `execute`
alike; a value outside its grammar is refused, never repaired.

| Value                                                                                                                              | Grammar                                                                                                                                                                       | Where it lands                                                                                                   | Outside the grammar                              |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `root`, `page_id`, `parent_page_id`, `block_id`, `database_id`, `data_source_id`, `after_block_id`, `discussion_id`, resource refs | `notionId` — a UUID with dashes or 32 hex characters without ("you may omit dashes from the ID when making requests"); returns the **canonical** form, lower case with dashes | URL path segment (canonical), JSON body (`parent`, `position.after_block.id`, `discussion_id`), slice identifier | `denied` / refusal: `<arg>: malformed Notion id` |
| ids inside values (relation targets, people, mentions, `link_to_page`, `synced_from`)                                              | `notionId`                                                                                                                                                                    | JSON body; relation targets and synced originals are walked (§5.4, §5.7)                                         | `denied`                                         |
| ids Notion answers (parents during a walk, search results, discovery, child blocks, `next_cursor`)                                 | `notionId` (`cursor` for a cursor)                                                                                                                                            | the next hop's URL path; resource refs; a query string                                                           | the walk refuses; discovery fails                |
| `start_cursor`                                                                                                                     | `cursor` — `^[A-Za-z0-9-]{1,128}$` (opaque for Notion; the grammar carries no separator)                                                                                      | query string (`URLSearchParams`) or JSON body; never a path, never a slice                                       | `denied`: `start_cursor: malformed`              |
| `page_size`, `depth`                                                                                                               | integers 1–100, 1–3                                                                                                                                                           | query string / body; `depth` stays in the executor                                                               | `denied`                                         |
| `position`, `object`, `type`                                                                                                       | closed lists                                                                                                                                                                  | JSON body, built by the executor                                                                                 | `denied`                                         |
| `query`, `title`, `filter`, `sorts`, `rich_text`, `properties`, `content`, `children`, `icon`, `cover`                             | not identifiers; JSON values held to `content.ts` (limits, no upload, nested ids). `icon` / `cover` external URLs must be `https:` and ≤ 2 000 characters                     | JSON body only                                                                                                   | `denied`                                         |

A Notion page URL (`https://www.notion.so/Title-<32 hex>`) is not an id and
is refused with a hint. Canonicalising the two spellings is reading the one
grammar, not repairing a value: Notion documents both forms as the same id,
and a slice, a resource ref and an ancestry comparison must see one
spelling. The canonical id is 36 characters of hex and dashes: a single safe
path segment and a valid slice identifier.

### 6.4 Tests

`npx vitest run plugins/notion` — 110 tests, no network, no credential:

- `plugin.test.ts`: the kit — `assertPluginWellFormed`,
  `assertPresetsValid`, `assertNoWildcard`, `assertCatalogCoverage` on
  `samples.ts` (all 18 tools; `fallbackHits` and `risksUntouched` empty),
  `assertIdentifiersRefused` on the same samples with the routes of the
  standard world; the catalog path, tool names and titles, default export
  and version; the presets (`root-trash` in none, only `page-trash` and
  `block-delete` gated in `editor`).
- `classify.test.ts`: root resolution, the slice of every tool, every
  refusal of §2 (undeclared arguments, pagination, search arguments, the
  request limits, the block types, update / delete on the root, icons and
  covers, positions, property values, comments, query values).
- `ancestry.test.ts`: proven in 0, 1, 2 hops, through a block, through a
  data-source parent, a data source through `database_parent`, an entry of
  a database root in one request; refused on a workspace parent, an
  `agent_id` or unknown parent, a hidden ancestor (no write sent), a
  malformed parent id, a swapped answer, a cycle, 17 levels; a relation
  target outside, an entry/page mismatch, a discussion not found, a synced
  copy whose original is outside; target `404` thrown; `401` / `403` as
  `UpstreamAuthError`; `429` with `Retry-After`; the memo across a search
  result set.
- `execute.test.ts`: the exact request of every write (method, URL, body,
  silent notifications where documented and nowhere else), headers,
  comments' parent, query strings, `list_roots` sending nothing; declines
  that send nothing; the search budget, `depth` ceilings and synced copies.
- `discovery.test.ts`: top-level detection (workspace, unreadable parent,
  block parent, entries, trash), a database's parent read when missing,
  pagination and the ceiling, unknown payloads, a probe failure thrown;
  `verify` (internal connection accepted, personal access token refused,
  `401`), the field pattern.
- `identifiers.test.ts`: hostile values (`..`, `%2e%2e`, `%2f`, a UUID with
  `/x`, a line break, `?x=1#y`, empty, overlong) in every id position of
  `classify` and `execute`, nested ids, cursors, the canonical spelling.
- `data-model.test.ts`: referential integrity, unique names, and every
  emitted slice and catalog pattern written with the declared entities under
  their declared parents.
- `risk-catalog.test.ts`: one risk per realistic slice, no overlap between
  write patterns, the root trash touching two risks, no environment
  anywhere.

## 7. Facts still unverified

Not stated by the documentation read; each is marked ⚠ where it is used.
None changes a refusal of the classifier; each is to be checked against the
real service before the plugin leaves 0.x:

1. Whether an internal connection token expires, and whether refreshing it
   invalidates the old one at once (§6.1).
2. That trashing a page trashes its subtree, and how long the trash keeps
   it (§5.5); that `DELETE /v1/blocks/{id}` takes nested blocks with it
   (§3).
3. That `GET /v1/pages/{id}` answers for a page in the trash, and for
   ancestors in the trash, so that `restore_page` can walk it (§5.5).
4. Whether update a block accepts `notifications` (§5.11): its reference, read whole in two WebFetch passes, does not mention it;
   the plugin sends nothing there.
5. That a write to a two-way relation changes the related page's value
   (§5.4).
6. Whether Notion serves a synced copy's children when the original is not
   shared (§5.7) — the walk makes the answer irrelevant to safety.
7. The reading of "two levels of nesting" (§2): the plugin allows the
   top-level blocks plus two nested levels and leaves anything Notion
   refuses beyond that to its `400`.
8. `result_type: "page"` on the query endpoint was read in the reference
   via WebFetch (draft); not re-checked in Context7.

Pages read only in part (WebFetch reads 100 000 characters at a time): the
references of query a data source, update page, create a page and append
block children. The upgrade guide for `2025-09-03` names the
query as `PATCH`; the endpoint reference says `POST`, which the plugin
follows.

## Decisions

Taken by the product owner on 2026-10-16 (marked **(PO)**), or the proposed
default of the draft kept as written (marked _default_). Each closes the open
question of the same number in the reviewed draft.

1. **No environment (PO).** No entity is `envScopable`, no risk has
   `acceptable_in_envs`, no preset entry is env-qualified. A root is
   written whatever its owner's label. The presets put `gate: approval` on
   the destructive operations instead: moving a page to the trash, deleting
   a block; trashing a whole root stays in no preset.
2. **One root per search** (_default_). The plugin filters results to the
   call's root (§5.2).
3. **No ancestry cache between calls** (_default_). A memo within one call
   only; a cache across calls would need state the SDK does not offer — a
   known limitation, not an SDK change (§5.1).
4. **Relations across roots refused** (_default_): every relation target is
   walked to the call's root.
5. **Rollups and formulas returned as Notion computes them** (_default_),
   recorded as an aggregated leak across roots (§5.4).
6. **Comments**: the question disappears with the environment; adding a
   comment runs freely in `reviewer` and `editor` (_default_).
7. **No retry** (_default_): a `429` / `529` is thrown with `Retry-After` in
   the message.
8. **`notion__restore_page` added (PO)**, with its own risk
   `notion.page-restore` (§3, §5.5).
9. **No public connection (OAuth)** (_default_): token first.
10. **`editor` writes run freely** (_default_); only the destructive
    operations ask first (decision 1).
11. **`notion__update_block` and `notion__delete_block` added (PO)**, each
    with its own risk (`notion.block-update`, `notion.block-delete` through
    a verb leaf), the same ancestry check as every write and the same
    refused block types and limits (§5.10).
12. **Notifications silent (PO).** Every write whose endpoint accepts it
    sends `notifications: { mode: "silent" }`; the agent cannot change it
    (an undeclared argument). Where it applies: §5.11.
13. **Personal access tokens refused at `verify` (PO)**; credential
    `api-key` on an internal connection (§6.1).

Taken while implementing, within the decisions above:

- The root-trash leaf is named `root-trash` (§1).
- The `template` block type, which Notion deprecated, is left out of the
  creatable types and refused as unknown.
- A search with `object: "data_source"` emits the data-source slice only (the
  draft emitted the page slice always); both are `read-content`.
- `update_block` requires the block's real type and refuses any other
  (§5.10); `delete_block` refuses a page or a database block.
- Without the environment, the vectors keep the draft's base values;
  `block-update` is `costly`, `page-restore` argued in §3.

## Sources

**Context7**, libraries `/websites/developers_notion` and
`/websites/developers_notion_reference` (`query-docs`), 2026-10-16:

| Fact                                                                                                                 | Context7 page                                                                 |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Latest `Notion-Version` is `2026-03-11`                                                                              | `reference/versioning`, `reference/patch-page` (header enum)                  |
| Token prefix `ntn_` since 2024-09-25, `secret_` still valid, do not validate tokens with a regex                     | `page/changelog` (2024-09-11)                                                 |
| Internal token: the same token on every request, refreshable on the Configuration tab (no expiry stated)             | `guides/get-started/internal-connections`, `guides/get-started/authorization` |
| Trash and restore with `in_trash`, no permanent deletion through the API                                             | `reference/trash-page`                                                        |
| Update page body: `properties`, `icon`, `cover`, `is_locked`, `template`, `erase_content`, `in_trash`, `is_archived` | `reference/patch-page`                                                        |
| Append block children: `children` ≤ 100, supported block types, `position`                                           | `reference/patch-block-children`                                              |
| `is_archived` (archive) is separate from `in_trash` (trash)                                                          | `reference/query-a-data-source`                                               |
| Two-way relation = `dual_property` with `synced_property_id`; relation ids must belong to the target source          | `reference/property-object`, `reference/page-property-values`                 |
| Missing access leaves relations empty and formulas / rollups incomplete                                              | `reference/property-object`, `reference/page-property-values`                 |
| Synced block shapes (original `synced_from: null`, copy `synced_from.block_id`)                                      | `reference/block`                                                             |

**WebFetch** on `developers.notion.com`, 2026-10-16 — for the decisions,
where Context7's pages did not carry the field (authorised fallback):

- <https://developers.notion.com/reference/patch-page> — `notifications`
  (`default` / `silent`), what `silent` suppresses and what still happens;
  `additionalProperties: false`.
- <https://developers.notion.com/reference/post-page> — `notifications`
  accepted; the top-level body fields (`allow_async`, `markdown_version`…).
- <https://developers.notion.com/reference/patch-block-children> —
  `notifications` accepted; the three `position` shapes.
- <https://developers.notion.com/reference/update-a-block> — type-keyed
  body, "replaces the _entire_ value for a given field", children not
  updatable, `child_page` through update page, Update content capability;
  no `notifications` anywhere in the page.
- <https://developers.notion.com/reference/delete-a-block> — "sets a Block
  object, including page blocks, to `in_trash: true`", restorable, no
  body, Update content capability.
- <https://developers.notion.com/reference/create-a-comment> — top-level
  fields; no `notifications`.

**WebFetch** for the phase-1 draft (the one-off exception while Context7's
quota was exhausted): the version changes of §0, every other endpoint,
parameter, parent shape, limit, error code, capability, sharing step and
personal-access-token fact.

- Versions: <https://developers.notion.com/reference/versioning>,
  <https://developers.notion.com/docs/upgrade-guide-2025-09-03>,
  <https://developers.notion.com/docs/upgrade-guide-2026-03-11>
- Conventions, ids, pagination: <https://developers.notion.com/reference/intro>
- Limits and errors: <https://developers.notion.com/reference/request-limits>,
  <https://developers.notion.com/reference/status-codes>
- Objects: <https://developers.notion.com/reference/parent-object>,
  <https://developers.notion.com/reference/page>,
  <https://developers.notion.com/reference/database.md>,
  <https://developers.notion.com/reference/data-source.md>,
  <https://developers.notion.com/reference/block.md>
- Endpoints: <https://developers.notion.com/reference/post-search>,
  <https://developers.notion.com/reference/search-optimizations-and-limitations.md>,
  <https://developers.notion.com/reference/retrieve-a-page>,
  <https://developers.notion.com/reference/trash-page.md>,
  <https://developers.notion.com/reference/get-block-children>,
  <https://developers.notion.com/reference/query-a-data-source>,
  <https://developers.notion.com/reference/list-comments>,
  <https://developers.notion.com/reference/get-self>
- Guides: <https://developers.notion.com/guides/data-apis/working-with-page-content.md>
- Credentials and sharing:
  <https://developers.notion.com/docs/authorization>,
  <https://developers.notion.com/reference/capabilities>,
  <https://developers.notion.com/guides/get-started/internal-connections.md>,
  <https://developers.notion.com/guides/get-started/personal-access-tokens.md>,
  <https://developers.notion.com/guides/get-started/handling-api-keys.md>,
  <https://developers.notion.com/docs/create-a-notion-integration>
- Index used to find the guides: <https://developers.notion.com/llms.txt>
