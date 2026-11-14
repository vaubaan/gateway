# `@vaubaan/plugin-notion`

Notion as a Vaubaan Gateway provider plugin on the v5 SDK
(`@vaubaan/plugin-sdk`). Pages, page content (blocks), databases (data
sources and their entries) and comments, over Notion's REST API with
`Notion-Version: 2026-03-11` — with **one resource per top-level page or
database shared with the account**, and every id a call names proven to
be under that resource before anything is read or written.

Contract: [`plugin-contract-and-credential-spec`](../../docs/decisions/plugin-contract-and-credential-spec.md).
Modelling handbook: [`docs/handbook/providers/notion.md`](../../docs/handbook/providers/notion.md).
Contributor guide: [`plugins/README.md`](../README.md).

## Data model

One plane, `content`, **flat under the resource**: a slice names the root
and the object, whatever its real depth; the depth is proven at run time.

```
root[<root id>]                  the resource: a top-level page or database shared with the account
├─ page[<page id>]   ─ subpage · properties · trash · restore   (verb leaves)
├─ block[<block id>] ─ children · delete                        (verb leaves; a write on the block rewrites it)
│    └─ comment[<discussion id>]
├─ database[<database id>]
├─ data-source[<data source id>] ─ entry[<page id>]
└─ root-trash                    verb leaf: the root page itself goes to the trash
```

No entity is `envScopable`: Notion has no environments, and no risk is
env-scoped. Destructive operations are gated by their row instead.

## Credential and resources

Kind `api-key`, an **internal account** token:

| Field       | Pattern        | Purpose                                                                                                                   |
| ----------- | -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `api_token` | `^\S{20,512}$` | The token of an internal account (`ntn_…`; older `secret_…` tokens work). Not a format check: Notion advises against one. |

A Workspace Owner creates the account at
`https://app.notion.com/developers/accounts` (Build → Internal
accounts), ticks the capabilities the agents need (Read content, Insert
content, Update content, Read comments, Insert comments) and shares the
top-level pages and databases with it. `verify` calls `GET /v1/users/me`
and refuses a token whose bot is not owned by the workspace: a **personal
access token** acts as its creator over everything that person can open,
which is not the resource model.

`discoverResources` pages through `POST /v1/search` for pages, then for data
sources (100 per page, at most 20 pages per kind), and returns **one
resource per top-level object**: one whose parent is the workspace, or whose
parent the token can neither find nor read (a `GET` answering 404). At most
200 roots. Discovery fails rather than truncate when a ceiling is reached.

```ts
{ provider: 'notion', ref: '1f2e…-…', displayName: 'Handbook', metadata: { kind: 'page' } }
```

## Tools

18 tools named `notion__<verb>_<noun>`. Each content tool takes `root`, one
of the mission's roots (it may be omitted when the mission has one).

| Tool                          | Slice                                                        |
| ----------------------------- | ------------------------------------------------------------ |
| `notion__list_roots`          | `notion.root[<R>].R` per root of the mission (no request)    |
| `notion__search_content`      | `notion.root[<R>].page[*].R`, `….data-source[*].R`           |
| `notion__get_page`            | `notion.root[<R>].page[<P>].R`                               |
| `notion__list_block_children` | `notion.root[<R>].block[<B>].R`                              |
| `notion__get_database`        | `notion.root[<R>].database[<D>].R`                           |
| `notion__get_data_source`     | `notion.root[<R>].data-source[<S>].R`                        |
| `notion__query_data_source`   | `notion.root[<R>].data-source[<S>].entry[*].R`               |
| `notion__create_page`         | `notion.root[<R>].page[<parent>].subpage.W`                  |
| `notion__update_page`         | `notion.root[<R>].page[<P>].properties.W`                    |
| `notion__append_blocks`       | `notion.root[<R>].block[<B>].children.W`                     |
| `notion__update_block`        | `notion.root[<R>].block[<B>].W`                              |
| `notion__delete_block`        | `notion.root[<R>].block[<B>].delete.W`                       |
| `notion__trash_page`          | `notion.root[<R>].page[<P>].trash.W` (+ `root-trash.W` on R) |
| `notion__restore_page`        | `notion.root[<R>].page[<P>].restore.W`                       |
| `notion__create_entry`        | `notion.root[<R>].data-source[<S>].entry.W`                  |
| `notion__update_entry`        | `notion.root[<R>].data-source[<S>].entry[<P>].W`             |
| `notion__list_comments`       | `notion.root[<R>].block[<B>].comment[*].R`                   |
| `notion__create_comment`      | `notion.root[<R>].block[<B>].comment.W` (or `comment[<D>]`)  |

Every id is a Notion id, 32 hexadecimal characters with or without dashes,
read into one canonical form (`notionId`, shared by `classify` and
`execute`); anything else — a page URL, `..`, an encoded separator — is
refused. Undeclared arguments are refused (`erase_content`,
`notifications`, `display_name`…). Every write whose endpoint accepts it is
sent with `notifications: { mode: "silent" }`.

**The ancestry check.** Before any request of the call itself, `execute`
walks the `parent` chain of every id the call acts on (target, parent of a
new page, data source of an entry, relation targets, page and database
mentions and links to a page in written content, the block an append
follows, the original of a synced copy), before it says anything about the
object until it meets the root: at most 16
levels, one `GET` each. A chain that reaches the workspace, an unreadable
parent or another root is refused. Search results that cannot be
proven under the root (at most 25 extra requests) are dropped silently,
neither named nor counted.

**Deleting a block** first lists what is nested in it (at most 20 listings)
and refuses when it holds a page or a database, or when the tree is larger
than that: `block-delete` never trashes a page. Synced copies are not
scanned: their children are their original's, which deleting a copy does
not trash and which the scan never reads.

A `link_to_page` is exactly `{ type: "page_id", page_id }` or
`{ type: "database_id", database_id }`, and a mention is a `page`,
`database`, `user` or `date` mention; anything else is refused.

## Catalog

`src/risk-catalog.yaml`: 14 named risks and the fallback.

| Risk                         | Action | Notes                                                                |
| ---------------------------- | ------ | -------------------------------------------------------------------- |
| `notion.read-content`        | R      | Pages, blocks, databases, data sources, search, the root list.       |
| `notion.query-databases`     | R      | Bulk entry queries (`blast: bulk`, `data: pii`).                     |
| `notion.read-comments`       | R      | Open discussions.                                                    |
| `notion.page-create`         | W      | A page under a page.                                                 |
| `notion.page-update`         | W      | Title, icon, cover.                                                  |
| `notion.content-append`      | W      | New blocks.                                                          |
| `notion.block-update`        | W      | Rewrites one block (`costly`).                                       |
| `notion.block-delete`        | W      | The `delete` leaf: one block to the trash.                           |
| `notion.page-trash`          | W      | The `trash` leaf: a page and its subtree (`blast: bulk`).            |
| `notion.page-restore`        | W      | The `restore` leaf: a page back from the trash.                      |
| `notion.root-trash`          | W      | The root page itself, beside `page-trash`.                           |
| `notion.entry-create`        | W      | A database entry.                                                    |
| `notion.entry-update`        | W      | An entry's values.                                                   |
| `notion.comment-create`      | W      | A new discussion or a reply.                                         |
| `notion.uncategorized-write` | W      | Fallback (`fallback: true`); touched by no tool, in no macro-action. |

Write patterns do not overlap: each write touches one risk, except trashing
the root page, which also touches `root-trash`.

## Macro-actions

A creator ticks macro-actions, each at a trust level (Careful / Trusting /
Autonomous, risk model §4.6); the trust level sets each risk's gate from its vector and
multiplies the base budget. The fallback sits apart, under "Anything else".

| Macro-action | What it covers                                             | Its risks                                                                                      |
| ------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `read`       | Pages, databases and comments.                             | `read-content`, `query-databases`, `read-comments`                                             |
| `comment`    | Leave comments.                                            | `comment-create`                                                                               |
| `write`      | Create and edit pages, their content and database entries. | `page-create`, `page-update`, `content-append`, `block-update`, `entry-create`, `entry-update` |
| `reorganize` | Delete blocks, move to the trash and restore.              | `block-delete`, `page-trash`, `page-restore`, `root-trash`                                     |

At Trusting, `block-update`, `block-delete`, `page-trash` and `root-trash`
ask first; everything else runs freely. The saved mission holds the explicit
list of risks.

## Ceilings

`MAX_ANCESTRY_DEPTH` 16 levels; `MAX_SEARCH_VERIFY_REQUESTS` 25;
`list_block_children` with `depth` 2–3: `MAX_BLOCKS_PER_CALL` 500 and
`MAX_CHILD_REQUESTS` 20 (listings and synced-original walks together);
`MAX_REFERENCE_WALK_REQUESTS` 50 per write; `MAX_DELETE_SCAN_REQUESTS` 20; a reply's discussion is looked up in at most 5
pages of 100 comments; discovery `MAX_SEARCH_PAGES` 20 per kind and
`MAX_DISCOVERED_ROOTS` 200. Notion's request limits (100 items per array,
2 000 characters per string, two levels of nesting and 1 000 blocks per
request) are refused before any request. No retry: a `429` is thrown with
its `Retry-After`.

## Tests

`npx vitest run plugins/notion` — 148 tests: the SDK kit
(`assertPluginWellFormed`, `assertNoWildcard`,
`assertCatalogCoverage` with no fallback hit and no risk untouched,
`assertIdentifiersRefused` on the plugin's `examples`, `src/examples.ts`), the classifier branch by
branch, the ancestry walk, the requests of `execute` (silent notifications
included), discovery and `verify` against `mockFetch`, hostile identifiers
in every position, the catalog's layering, and every slice and pattern
checked against the data model. No test calls Notion.
