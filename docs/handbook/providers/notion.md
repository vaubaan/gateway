---
title: Notion provider plugin
status: draft
date: 2026-10-16
last_synced: 2026-10-16
tracks:
  - plugins/notion/src/
  - plugins/notion/tests/unit/
---

# Notion provider plugin

> **Phase 1 of [`provider-modeler`](../../skills/provider-modeler.md),
> reviewed.** The product owner's decisions of 2026-10-16 are in
> "Decisions" at the end; they remove the environment, add a restore tool,
> block update and deletion, and silent notifications. Where a section below
> still says otherwise, "Decisions" wins until the page is aligned with the
> code.

> **Sources.** Provider facts were checked on 2026-10-16 against the
> official developer documentation at `developers.notion.com`, read with
> WebFetch — a one-off exception to the Context7 rule, authorised by the
> product owner because Context7's quota was exhausted — then cross-checked
> in Context7 once it was reconnected, which also settled two facts WebFetch
> had left open ("Sources" at the end says which fact came from where). A
> fact the documentation does not state is
> still marked ⚠ and listed in §7; everything else on this page about
> Notion's API is confirmed by a page listed there.

`@vaubaan/plugin-notion` 0.1.0 (proposed), tool prefix `notion__`. Scope
v0.1 **(PO)**: "pages + databases" — search, read a page and its blocks,
create a page, update a page's properties, append blocks, move a page to
the trash; read and query a database (its data sources), create and update
an entry; read and create comments. No administration: no user listing
beyond what the credential check needs, no sharing, no database schema
change, no file upload.

Notion now calls an integration a **connection** ("internal connection",
"public connection"); this page uses Notion's current word.

Repository precedents this design follows:

- **A target bound to its resource at run time** — Vercel's "deployment
  binding" (`verifiedDeploymentId` in `plugins/vercel/src/execute.ts`: a
  `GET` under the pinned team before the call, 403 / 404 turned into an
  `ExecutorRefusal`), Resend's broadcast check (`GET /broadcasts/:id`, a
  broadcast of another segment declined), Cloudflare DNS's record read-back
  before an update or a deletion. Notion needs the same guard on every call,
  reads included (§5.1).
- **A synthetic tool that calls nothing** — Resend's `describe_zones`.
- **Discovery filtered to what a mission may see** — Cloudflare DNS's
  `list_zones`, filtered to the mission's zones.

## 0. Version pinned and what it changes

The plugin sends **`Notion-Version: 2026-03-11`** on every request, a
constant of the plugin (`NOTION_VERSION`), never configuration. It is the
latest version on 2026-10-16 (versioning page). It keeps the data-source
model introduced by `2025-09-03` and adds three breaking changes of its
own; the plugin is written against both sets.

What `2025-09-03` changed for databases (not backwards-compatible), and
how the model uses it:

| Before (`2022-06-28`)                                     | Since `2025-09-03`                                                                                                                                                         | In this model                                                                                                                                                 |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A database is one table: schema, rows, query              | A **database** contains one or more **data sources**; the schema (`properties`) and the rows belong to a data source. Access is managed at the database level              | Two entities: `database` (the container, what a person sees and shares) and `data-source` (schema + entries). A database **resource** ref is the database id. |
| `POST /v1/databases/{id}/query`                           | `POST /v1/data_sources/{id}/query`                                                                                                                                         | `notion__query_data_source` takes a `data_source_id`.                                                                                                         |
| `GET /v1/databases/{id}` returns the schema               | `GET /v1/databases/{id}` returns the container with `data_sources: [{ id, name }]`; `GET /v1/data_sources/{id}` returns the schema, its `parent` and its `database_parent` | `notion__get_database` lists the data sources; `notion__get_data_source` reads a schema.                                                                      |
| Page parent `{ type: "database_id" }`                     | Page parent `{ type: "data_source_id", data_source_id, database_id }` (the `database_id` "provided for convenience")                                                       | Creating an entry names its data source; the ancestry walk reads the `database_id` a page parent carries.                                                     |
| Search filter `{ property: "object", value: "database" }` | `value: "data_source"`; results are data source objects, one per data source; matching still on the database title                                                         | Discovery finds databases through their data sources (§6.2).                                                                                                  |
| Relation write names a `database_id`                      | Relation writes must name `data_source_id` only (`database_id` refused)                                                                                                    | Relation **writes** are bound like every other target (§5.4).                                                                                                 |

What `2026-03-11` changes on top:

| `2025-09-03`                                   | `2026-03-11`                                                                                                    | In this model                                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `archived` accepted (deprecated since 2024-04) | `archived` gone from requests and responses; `in_trash` only                                                    | `trash_page` sends `in_trash: true`; the plugin reads `in_trash` only.                        |
| Append children: flat `after` string           | `position`: `{ type: "end" }` (default), `{ type: "start" }`, or `{ type: "after_block", after_block: { id } }` | `append_blocks` takes `position` (`end` / `start` / `after_block`) and `after_block_id` (§2). |
| Block type `transcription`                     | renamed `meeting_notes`; not creatable with the general block endpoints                                         | Refused in `children` (§2).                                                                   |

## 1. Data model

One plane, `content`. Notion's tree is recursive (a page holds blocks,
blocks hold blocks and sub-pages, to any depth), and a slice cannot express
"any depth below": the model is therefore **flat under the resource** —
every page, block, database and data source of a resource is a direct
child of `root` in the slice, whatever its real depth. That is what the
classifier can say purely; the real depth is checked by `execute` (§5.1).

```
root[<root id>]                       the resource: one page or database shared with the connection;
│                                     labelled by its owner (envScopable)
├─ page[<page id>]                    any page under the root, the root page itself included
│    ├─ subpage                       verb leaf: create a page under this page
│    ├─ properties                    verb leaf: overwrite the page's title / icon / cover
│    └─ trash                         verb leaf: move the page (and everything under it) to the trash
├─ block[<block id>]                  any block under the root; a page id is a block id too
│    ├─ children                      verb leaf: append blocks under this block
│    └─ comment[<discussion id>]      comments on this block or page; `comment` alone = a new comment
├─ database[<database id>]            a database container under the root, or the root itself
├─ data-source[<data source id>]      a data source of such a database (schema)
│    └─ entry[<page id>]              an entry (row) of the data source; `entry` alone = a creation
└─ trash                              verb leaf: the root page itself goes to the trash
```

| Entity        | Parent        | Cardinalities      | Notes                                                                                |
| ------------- | ------------- | ------------------ | ------------------------------------------------------------------------------------ |
| `root`        | —             | `one`              | `envScopable: true`. A page or a database, as discovery found it (`metadata.kind`).  |
| `page`        | `root`        | `one`, `unbounded` | Flat: depth is checked at run time.                                                  |
| `subpage`     | `page`        | `one`              | Verb leaf.                                                                           |
| `properties`  | `page`        | `one`              | Verb leaf.                                                                           |
| `trash`       | `page`        | `one`              | Verb leaf.                                                                           |
| `block`       | `root`        | `one`              | Flat.                                                                                |
| `children`    | `block`       | `one`              | Verb leaf.                                                                           |
| `comment`     | `block`       | `one`, `unbounded` | Identified by its discussion id when it is a reply.                                  |
| `database`    | `root`        | `one`              | Flat.                                                                                |
| `data-source` | `root`        | `one`, `unbounded` | Flat (a data source is reached by its own id; its database is checked at run time).  |
| `entry`       | `data-source` | `one`, `unbounded` | An entry is a page; reached by `entry` when the tool says it acts on a database row. |
| `trash`       | `root`        | `one`              | Verb leaf: the root page itself goes to the trash (`root[R].trash.W`).               |

`trash` appears twice in the model (under `page` and under `root`); if the
data-model validator refuses two entities of the same name in one plane,
the root leaf is named `root-trash` (decide at step 2, the catalog pattern
follows).

**Resource (PO).** One resource per **top-level** page or database shared
with the connection: a shared object whose parent the connection cannot
read, or whose parent is `{ type: "workspace" }` ("a top-level page within
a Notion workspace"). Sharing a parent page grants access to all of its
child pages (internal connections guide), so everything below a root
belongs to it. `ref` = the object's id in canonical form (§Identifiers),
`displayName` = its title, `metadata.kind` = `page` or `database`.

**Environment (PO).** The owner's label on the resource (`staging`,
`prod`…); the slice always names `root[R]` as its first identifier, so the
gateway's resolution (risk-model spec §6, step 2) finds the label without an
`envOf` hook. Notion has no mode of its own.

## 2. Tool → slice mapping

Every tool that acts on content takes `root` — the resource ref — as an
explicit argument. Rule of the kit (template's `resolveWorkspace`): a `root`
given must be one of the mission's Notion resources, otherwise `denied`;
absent, the mission's single Notion resource; none or several, `denied`.
**The classifier never infers the root from a page or block id**: it cannot
(no network), and guessing would let one resource's budget price a call on
another.

`R` = the resolved root ref. Ids are canonical (§Identifiers).

| Tool                          | Arguments (required in **bold**)                                                         | Slice(s)                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `notion__list_roots`          | —                                                                                        | `notion.root[R].R` for each Notion resource of the mission (synthetic: no request)           |
| `notion__search_content`      | `root`, `query`, `object` (`page` \| `data_source`), `sort`, `page_size`, `start_cursor` | `notion.root[R].page[*].R`; plus `notion.root[R].data-source[*].R` unless `object` is `page` |
| `notion__get_page`            | `root`, **`page_id`**                                                                    | `notion.root[R].page[P].R`                                                                   |
| `notion__list_block_children` | `root`, **`block_id`**, `depth` (1–3, default 1), `page_size`, `start_cursor`            | `notion.root[R].block[B].R`                                                                  |
| `notion__get_database`        | `root`, **`database_id`**                                                                | `notion.root[R].database[D].R`                                                               |
| `notion__get_data_source`     | `root`, **`data_source_id`**                                                             | `notion.root[R].data-source[S].R`                                                            |
| `notion__query_data_source`   | `root`, **`data_source_id`**, `filter`, `sorts`, `page_size`, `start_cursor`             | `notion.root[R].data-source[S].entry[*].R`                                                   |
| `notion__create_page`         | `root`, **`parent_page_id`**, **`title`**, `children`, `icon`, `cover`                   | `notion.root[R].page[P].subpage.W` (P = `parent_page_id`)                                    |
| `notion__update_page`         | `root`, **`page_id`**, `title`, `icon`, `cover`                                          | `notion.root[R].page[P].properties.W`                                                        |
| `notion__append_blocks`       | `root`, **`block_id`**, **`children`**, `position`, `after_block_id`                     | `notion.root[R].block[B].children.W`                                                         |
| `notion__trash_page`          | `root`, **`page_id`**                                                                    | `notion.root[R].page[P].trash.W`; **and** `notion.root[R].trash.W` when `P` = `R`            |
| `notion__create_entry`        | `root`, **`data_source_id`**, **`properties`**, `children`, `icon`                       | `notion.root[R].data-source[S].entry.W`                                                      |
| `notion__update_entry`        | `root`, **`data_source_id`**, **`page_id`**, **`properties`**, `icon`                    | `notion.root[R].data-source[S].entry[P].W`                                                   |
| `notion__list_comments`       | `root`, **`block_id`**, `page_size`, `start_cursor`                                      | `notion.root[R].block[B].comment[*].R`                                                       |
| `notion__create_comment`      | `root`, **`block_id`**, **`rich_text`**, `discussion_id`                                 | `notion.root[R].block[B].comment.W`, or `….comment[Q].W` when `discussion_id` = Q is given   |

Titles (`toolTitles`): "List the shared roots", "Search pages and
databases", "Read a page", "Read a page's content", "Read a database", "Read
a database's schema", "Query a database", "Create a page", "Update a page",
"Add content to a page", "Move a page to the trash", "Add a database entry",
"Update a database entry", "Read comments", "Add a comment".

`append_blocks`: `position` is `end` (default), `start` or `after_block`;
`after_block_id` is required with `after_block` and refused otherwise. The
executor builds Notion's `position` object from them.

**Refused by the classifier** (`denied`, audited, never executed):

- an unknown tool; `root` outside the mission, malformed, ambiguous or
  absent with zero / several resources; any id outside its grammar;
- `depth` outside 1–3; `page_size` outside 1–100;
- Notion's request limits, refused up front (kit step 3: "a limit the
  provider needs is refused by your classifier"): more than 100 blocks in
  any `children` array, more than two levels of nesting in one
  `children`, more than 1 000 block elements in one request, more than 100
  items in any array (rich text, relation, people, multi-select), a text
  `content` or a link URL over 2 000 characters (request limits page; the
  500 KB payload ceiling is left to Notion's `400`);
- a block in `children`, at any level, of type `synced_block` with
  `synced_from` set (a duplicate: §5.7); `child_page` / `child_database`
  (created through the pages and databases endpoints only);
  `link_preview`, `meeting_notes`, `transcription`, `unsupported` (not
  creatable through the block endpoints); a media block (`file`, `image`,
  `pdf`, `video`, `audio`) whose source is a `file_upload` (file uploads are
  out of scope — **PO**); a `link_to_page` or a mention whose target is not
  a Notion id;
- on `create_entry` / `update_entry`, a `files` property value carrying a
  `file_upload`, and a value for a property type Notion does not let a
  request set (formula, rollup, unique id, created / edited time and
  person, button — create a page reference);
- an undeclared argument (below).

### Undeclared arguments

The plugin **refuses undeclared arguments**, in `classify` and again in
`execute` (`undeclaredArgumentDenial` with `declared =
declaredArgumentsOf(notionTools)`, wrapped in one exported
`undeclaredArgument(tool, args)`), **and** builds every request field by
field from the declared arguments. Both, because the values of `properties`,
`children`, `filter`, `sorts` and `rich_text` are forwarded as JSON (the
tool's own business, as the SDK says of nested values), so the top level is
the one place an unpriced field could slip in. The current endpoints accept
fields this model deliberately leaves out, and an agent that sends one gets
a sentence, not a silently dropped field:

- `PATCH /v1/pages/{id}`: **`erase_content`** ("deletes all block children
  … can't be reversed through the API"), `is_archived` (Notion's
  _archive_, a state of its own: "`is_archived` is separate from
  `in_trash`"), `template`, `is_locked`, `notifications`,
  `filter_properties`;
- `POST /v1/pages`: `markdown`, `content`, `template`, `position`,
  `notifications`, a free `parent` (including `database_id` and
  `workspace`);
- `PATCH /v1/blocks/{id}/children`: the deprecated `after`, `notifications`;
- `POST /v1/data_sources/{id}/query`: `is_archived`, `result_type` (the
  executor sends `result_type: "page"` itself, §6.3), `filter_properties`;
- `POST /v1/search`: `filter.in_trash`;
- `POST /v1/comments`: `markdown`, `attachments` (file uploads),
  **`display_name`** (a `custom` name would let the agent sign a comment as
  anybody).

No `routing` argument.

## 3. Catalog and presets

11 named risks + the fallback. Reads are account-scoped (the owner need not
label a root for an agent to read it); **every content write is env-scoped**
(`acceptable_in_envs: [staging, prod]`), so an unlabelled root can be read
but not written, and production writes have their own budget. Comments are
account-scoped (see the reason of `comment-create`, and Open question 6).

Layering: none of the write patterns overlap — each write slice touches
exactly one named risk, except the trash of the root page, which touches
`page-trash` **and** `root-trash` by emitting two slices.

```yaml
provider: notion
catalog_version: 1
catalog_date: 2026-10-16

risks:
  # ─── Reads ───────────────────────────────────────────────────────────────

  - id: notion.read-content
    label: 'Read pages, their content and database descriptions'
    reason: >-
      Page titles, properties and block content of the selected pages and
      databases, search results within them, and the description of their
      databases. Content written by people, which can carry instructions
      aimed at the agent.
    matches:
      - 'notion.root[*].R'
      - 'notion.root[**].page[**].R'
      - 'notion.root[**].block[*].R'
      - 'notion.root[**].database[*].R'
      - 'notion.root[**].data-source[*].R'
    infra_limits: { calls_per_minute_max: 60 }
    vector:
      reversibility: reversible
      blast: single
      data: data
      cost: free
      visibility: internal
      persistence: stateless

  - id: notion.query-databases
    label: 'Query database entries in bulk'
    reason: >-
      One query returns up to a hundred entries with all their properties —
      a CRM, a hiring pipeline or a task list in a few calls. Kept apart from
      reading one page so a mission can read documents without exporting
      tables.
    matches: 'notion.root[**].data-source[*].entry[*].R'
    infra_limits: { calls_per_minute_max: 30 }
    vector:
      reversibility: reversible
      blast: bulk
      data: pii
      cost: free
      visibility: internal
      persistence: stateless

  - id: notion.read-comments
    label: 'Read comments and discussions'
    reason: >-
      Open discussions on pages and blocks, with the names of who wrote
      them. Often more candid than the page itself.
    matches: 'notion.root[**].block[*].comment[*].R'
    infra_limits: { calls_per_minute_max: 30 }
    vector:
      reversibility: reversible
      blast: single
      data: pii
      cost: free
      visibility: internal
      persistence: stateless

  # ─── Writes — pages ──────────────────────────────────────────────────────

  - id: notion.page-create
    label: 'Create a page under a page'
    reason: >-
      Adds a page, with its first content, under an existing page of the
      selected roots. Additive and visible to everyone who can see the
      parent page; removed by moving it to the trash.
    matches: 'notion.root[**].page[*].subpage.W'
    acceptable_in_envs: [staging, prod]
    infra_limits: { calls_per_minute_max: 30 }
    vector:
      reversibility: reversible
      blast: single
      data: data
      cost: free
      visibility: team
      persistence: posture
    vector_overrides:
      prod: { visibility: public }

  - id: notion.page-update
    label: "Change a page's title, icon or cover"
    reason: >-
      Overwrites what a page is called and how it looks. The previous value
      is kept only in Notion's page history, whose length depends on the
      workspace's plan.
    matches: 'notion.root[**].page[*].properties.W'
    acceptable_in_envs: [staging, prod]
    infra_limits: { calls_per_minute_max: 30 }
    vector:
      reversibility: reversible
      blast: single
      data: data
      cost: free
      visibility: team
      persistence: posture
    vector_overrides:
      prod: { reversibility: costly, visibility: public }

  - id: notion.content-append
    label: 'Add content to a page'
    reason: >-
      Adds blocks (text, lists, to-dos, code, links) at the start or the end
      of a page or a block, or after a given block. Nothing existing is
      changed; mentions in the new text notify the people they name.
    matches: 'notion.root[**].block[*].children.W'
    acceptable_in_envs: [staging, prod]
    infra_limits: { calls_per_minute_max: 30 }
    vector:
      reversibility: reversible
      blast: single
      data: data
      cost: free
      visibility: team
      persistence: posture
    vector_overrides:
      prod: { visibility: public }

  - id: notion.page-trash
    label: 'Move a page to the trash'
    reason: >-
      The page and everything under it — sub-pages, inline databases —
      disappear for everyone. It can be restored from Notion's trash; the
      API cannot delete it for good. Database entries are pages too.
    matches: 'notion.root[**].page[*].trash.W'
    acceptable_in_envs: [staging, prod]
    infra_limits: { calls_per_minute_max: 10 }
    vector:
      reversibility: costly
      blast: bulk
      data: data
      cost: free
      visibility: team
      persistence: posture
    vector_overrides:
      prod: { visibility: public }

  - id: notion.root-trash
    label: 'Move a whole shared root page to the trash'
    reason: >-
      Trashing the page that was shared with the connection takes the whole
      resource away: every page under it, for every person and every
      mission. Listed in no preset; a mission that needs it holds it
      explicitly, beside the permission to trash a page.
    matches: 'notion.root[*].trash.W'
    acceptable_in_envs: [staging, prod]
    infra_limits: { calls_per_minute_max: 2 }
    vector:
      reversibility: costly
      blast: env
      data: data
      cost: free
      visibility: public
      persistence: posture

  # ─── Writes — database entries ───────────────────────────────────────────

  - id: notion.entry-create
    label: 'Add an entry to a database'
    reason: >-
      Creates a row in a database: a task, a contact, a ticket. Can start the
      database's automations and notify the people its properties name.
    matches: 'notion.root[**].data-source[*].entry.W'
    acceptable_in_envs: [staging, prod]
    infra_limits: { calls_per_minute_max: 30 }
    vector:
      reversibility: reversible
      blast: single
      data: data
      cost: free
      visibility: team
      persistence: posture
    vector_overrides:
      prod: { visibility: public }

  - id: notion.entry-update
    label: "Change a database entry's properties"
    reason: >-
      Overwrites the values of an entry — a status, an owner, a date, a
      relation; a list value replaces the whole list. Views, automations and
      relations elsewhere follow the change; the previous value is only in
      the page history.
    matches: 'notion.root[**].data-source[*].entry[*].W'
    acceptable_in_envs: [staging, prod]
    infra_limits: { calls_per_minute_max: 30 }
    vector:
      reversibility: reversible
      blast: single
      data: data
      cost: free
      visibility: team
      persistence: posture
    vector_overrides:
      prod: { reversibility: costly, visibility: public }

  # ─── Writes — comments ───────────────────────────────────────────────────

  - id: notion.comment-create
    label: 'Add a comment'
    reason: >-
      Opens a discussion on a page or a block, or replies to an open one,
      signed by the connection. Notifies the people it mentions. Not
      env-scoped: it changes no content.
    matches: 'notion.root[**].block[*].comment[**].W'
    infra_limits: { calls_per_minute_max: 20 }
    vector:
      reversibility: reversible
      blast: single
      data: data
      cost: free
      visibility: team
      persistence: session

  # ─── Fallback (required) ─────────────────────────────────────────────────

  - id: notion.uncategorized-write
    label: 'Uncategorized Notion write'
    reason: >-
      Catch-all for writes without a dedicated entry. Seen in an audit, it
      means a tool classifies to a slice no entry covers: add the entry.
    matches: 'notion.**.W'
    fallback: true
    vector:
      reversibility: costly
      blast: env
      data: data
      cost: free
      visibility: team
      persistence: posture

presets:
  - id: read-only
    label: Read-only
    description: Read the pages, databases and comments of the selected roots. No write, no comment.
    entries:
      - risk_id: notion.read-content
        quota: 3000
        rate_limit: { max: 30, window_seconds: 60 }
        gate: auto
      - risk_id: notion.query-databases
        quota: 500
        rate_limit: { max: 10, window_seconds: 60 }
        gate: auto
      - risk_id: notion.read-comments
        quota: 500
        rate_limit: { max: 10, window_seconds: 60 }
        gate: auto

  - id: reviewer
    label: Reviewer
    description: Read everything in the selected roots and leave comments. No change to pages or databases.
    entries:
      - risk_id: notion.read-content
        quota: 3000
        rate_limit: { max: 30, window_seconds: 60 }
        gate: auto
      - risk_id: notion.query-databases
        quota: 500
        rate_limit: { max: 10, window_seconds: 60 }
        gate: auto
      - risk_id: notion.read-comments
        quota: 500
        rate_limit: { max: 10, window_seconds: 60 }
        gate: auto
      - risk_id: notion.comment-create
        quota: 100
        rate_limit: { max: 5, window_seconds: 60 }
        gate: auto

  - id: editor
    label: Editor
    description: >-
      Daily work: read, comment, create and edit pages and database entries
      on staging and production roots freely; moving a page to the trash
      runs freely on staging and asks first on production. Never trashes a
      whole root.
    entries:
      - risk_id: notion.read-content
        quota: 5000
        rate_limit: { max: 30, window_seconds: 60 }
        gate: auto
      - risk_id: notion.query-databases
        quota: 1000
        rate_limit: { max: 10, window_seconds: 60 }
        gate: auto
      - risk_id: notion.read-comments
        quota: 1000
        rate_limit: { max: 10, window_seconds: 60 }
        gate: auto
      - risk_id: notion.comment-create
        quota: 200
        rate_limit: { max: 5, window_seconds: 60 }
        gate: auto
      - risk_id: notion[staging].page-create
        quota: 200
        rate_limit: { max: 10, window_seconds: 60 }
        gate: auto
      - risk_id: notion[prod].page-create
        quota: 50
        rate_limit: { max: 5, window_seconds: 60 }
        gate: auto
      - risk_id: notion[staging].page-update
        quota: 300
        rate_limit: { max: 10, window_seconds: 60 }
        gate: auto
      - risk_id: notion[prod].page-update
        quota: 100
        rate_limit: { max: 5, window_seconds: 60 }
        gate: auto
      - risk_id: notion[staging].content-append
        quota: 500
        rate_limit: { max: 15, window_seconds: 60 }
        gate: auto
      - risk_id: notion[prod].content-append
        quota: 200
        rate_limit: { max: 10, window_seconds: 60 }
        gate: auto
      - risk_id: notion[staging].entry-create
        quota: 300
        rate_limit: { max: 10, window_seconds: 60 }
        gate: auto
      - risk_id: notion[prod].entry-create
        quota: 100
        rate_limit: { max: 5, window_seconds: 60 }
        gate: auto
      - risk_id: notion[staging].entry-update
        quota: 500
        rate_limit: { max: 15, window_seconds: 60 }
        gate: auto
      - risk_id: notion[prod].entry-update
        quota: 200
        rate_limit: { max: 10, window_seconds: 60 }
        gate: auto
      - risk_id: notion[staging].page-trash
        quota: 50
        rate_limit: { max: 5, window_seconds: 60 }
        gate: auto
      - risk_id: notion[prod].page-trash
        quota: 10
        rate_limit: { max: 2, window_seconds: 60 }
        gate: approval
```

**In no preset, deliberately:** `notion.root-trash` (both environments: it
removes a whole resource for everyone) and the fallback (forbidden by the
loader).

### Rate limits

Notion's request limits page: **180 requests a minute per connection (3 a
second on average) on most plans, 600 a minute (10 a second) on Business
and Enterprise**, plus a **separate limit shared by all connections of the
workspace**. Requests may come evenly or in a burst as long as the 60-second
budget holds. Beyond it Notion answers `429 rate_limited` with a
`Retry-After` header (an integer number of seconds, repeated in the body as
`additional_data.retry_after`); `529 service_overload` asks for the same
`Retry-After`.

The plugin plans for the lower figure: ~180 requests a minute **for the
connection**, shared by every mission issued on it, and by whatever else
the workspace runs. A tool call costs more than one request (§5.1: one per
level of the ancestry walk, plus the call itself):

| Call                                                 | Requests, typical (depth 3)                     | Worst case                                      |
| ---------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------- |
| `get_page`, `get_database`, `get_data_source`        | 1 + 2 (the target's own `GET` is the first hop) | 1 + `MAX_ANCESTRY_DEPTH` (16)                   |
| `list_block_children`, `query_data_source`, comments | 1 + 3                                           | 1 + 16, + up to 20 listings for `depth` > 1     |
| a write                                              | 1 + 3                                           | 2 + 16 (`update_entry`, `create_comment` reply) |
| `search_content`                                     | 1 + the filter's budget                         | 1 + `MAX_SEARCH_VERIFY_REQUESTS` (25)           |

How the presets respect it:

- the **preset rate limits are sized so that one mission's realistic mix
  stays near one call a second**: `read-only` allows 50 calls a minute in
  total, `reviewer` 55, `editor` 147 if every risk ran at its maximum at
  once (which no realistic mix does: an editing agent reads, then writes).
  At ~4 requests a call, `read-only` at full speed reaches ~200 requests a
  minute — Notion's ceiling on most plans, so Notion, not the gateway, is
  what slows the agent at the edge;
- `infra_limits.calls_per_minute_max` (the one enforced catalog limit) caps
  what a creator can raise a risk to: 60 for page reads, 30 for bulk
  queries, comments and ordinary writes, 10 for a trash, 2 for a root
  trash. A mission above those numbers would only collect `429`s;
- `execute` makes **no retry of its own**: a `429` or a `529` is thrown as
  `UpstreamHttpError(…, status)` with the `Retry-After` value in the message
  the agent reads. A retried write is also unsafe: Notion's `503` may come
  after a write that was saved (status codes page, `retry_guidance`), so
  the plugin never replays a request (Open question 7).

## 4. Coverage

Every tool is covered by a named risk, none by the fallback.

| Tool                          | Risk(s) touched                                      |
| ----------------------------- | ---------------------------------------------------- |
| `notion__list_roots`          | `read-content`                                       |
| `notion__search_content`      | `read-content`                                       |
| `notion__get_page`            | `read-content`                                       |
| `notion__list_block_children` | `read-content`                                       |
| `notion__get_database`        | `read-content`                                       |
| `notion__get_data_source`     | `read-content`                                       |
| `notion__query_data_source`   | `query-databases`                                    |
| `notion__create_page`         | `page-create` (env)                                  |
| `notion__update_page`         | `page-update` (env)                                  |
| `notion__append_blocks`       | `content-append` (env)                               |
| `notion__trash_page`          | `page-trash` (env); + `root-trash` (env) on the root |
| `notion__create_entry`        | `entry-create` (env)                                 |
| `notion__update_entry`        | `entry-update` (env)                                 |
| `notion__list_comments`       | `read-comments`                                      |
| `notion__create_comment`      | `comment-create`                                     |

`risksUntouched` over realistic samples: none (`root-trash` is reached by a
sample that trashes the root page).

## 5. Edge cases

### 5.1 Which resource a call is on — the ancestry check

**The problem.** The classifier is pure. A call names a page, block,
database or data source by id, and nothing in a Notion id says where it
lives. The connection's token reaches every page shared with it, across
every root. A mission limited to root A must not read or write a page of
root B because the agent named B's page id — and must not have that call
priced against A's budget and A's environment label.

**The design.**

1. **Every tool takes `root` explicitly** (or the single root of the
   mission). The classifier checks it against the mission's resources and
   emits every slice under `root[R]`. The slice is therefore exact about
   the resource it _claims_; the environment and the budget come from that
   root.
2. **`execute` proves the claim before anything else.** For the target of
   the call (and every other id it acts on: the parent of a new page, the
   data source of an entry, the `after_block_id`, relation targets, the
   original of a synced block, the block a discussion is on), it walks the
   `parent` chain up with `ctx.fetch` until it meets `R`. The parent shapes
   are those of the parent object reference: `page_id`, `data_source_id`
   (with `database_id`), `database_id`, `block_id`, `workspace`, and
   `agent_id`.

   | Kind met    | Request                     | Next hop read from                                                                                  |
   | ----------- | --------------------------- | --------------------------------------------------------------------------------------------------- |
   | page        | `GET /v1/pages/{id}`        | `parent`: `page_id`, `data_source_id` (+ `database_id`), `block_id`, `workspace`                    |
   | block       | `GET /v1/blocks/{id}`       | `parent`: `page_id`, `data_source_id`, `block_id`                                                   |
   | data source | `GET /v1/data_sources/{id}` | `parent.database_id`, and `database_parent` (the database's own parent) — two levels in one request |
   | database    | `GET /v1/databases/{id}`    | `parent`: `page_id`, `block_id`, `workspace` (a wiki's database may have a `data_source_id` parent) |
   - **Proven** when an id met on the way (the target itself included)
     equals `R`. A parent of type `data_source_id` carries its
     `database_id`: when that is `R`, one hop proves an entry of a database
     root.
   - **Refused** (`ExecutorRefusal`, before any write and before any read
     result leaves the executor) when the chain reaches `workspace`; meets
     an `agent_id` parent (agent instruction pages, outside any shared
     root) or a parent type it does not know; meets a parent the connection
     cannot read (`404 object_not_found`: "the resource doesn't exist for
     this token, or it hasn't been shared" — the object is outside every
     root, as Vercel's binding treats a hidden deployment); meets an id
     outside the grammar or an id twice (a cycle: not expected from Notion,
     refused rather than looped); or exceeds `MAX_ANCESTRY_DEPTH` hops (16;
     fail closed — a deeper page is refused with a sentence saying so).
     Sentence: `notion: <kind> '<id>' is not under the shared root '<R>' of
this call` (or `could not be shown to be … within 16 levels`).
   - A `401 unauthorized` on a hop is the credential's
     (`UpstreamAuthError`); a `403 restricted_resource` is a missing
     capability (`UpstreamAuthError`, which the door does not treat as a
     rejected credential); a `429`, a `5xx` or a network failure is the
     provider's and is thrown as it is. Only a `404` on an **ancestor**
     becomes a refusal; on the target itself it is the provider's answer to
     the agent's call (thrown).

3. **Reads too.** A read is checked like a write: the boundary of a
   mission is a confidentiality boundary. For a read whose answer already
   carries `parent` (`get_page`, `get_database`, `get_data_source`), the
   target's own `GET` is the first hop: the answer is held, the walk
   completes, and it is returned only if proven.
4. **Memo within one call, nothing across calls.** The walk keeps the ids
   it proved during the call (siblings share ancestors: a search result
   set or a relation list is verified cheaply). Nothing is cached between
   calls: a page can be moved out of a root at any moment, and the SDK
   offers no state for it (`credentialCache` is for credentials). Open
   question 3 asks whether a short per-connection cache is wanted.

**What it costs.** One request per level, at ~3 requests a second for the
whole connection: a page three levels under its root costs ~1 second of
the connection's budget on top of the call (§3, "Rate limits"). A data
source costs one request for two levels (`database_parent`). The `depth`
argument of `list_block_children` (§5.6) pays the walk once for a whole
page body instead of once per nested block.

**What it does not cover.**

- **Time of check, time of use.** A page moved to another root between the
  walk and the write is written in its new place. The window is one
  request; no tool of this plugin moves pages (a page's `parent` cannot be
  changed through `PATCH /v1/pages`). Accepted.
- **The root is the claim, not a proof of "least" root.** Roots are
  top-level by construction (discovery), so a page belongs to exactly one
  root; if the owner later shares a parent of root A, A stops being
  top-level at the next discovery but missions holding A keep working (the
  walk still meets A).

**Alternatives rejected.**

- _Infer the root in the classifier from the resource metadata_ (a list of
  known descendant ids per root, filled at discovery): stale as soon as a
  page is created or moved, unbounded in size, and a page missing from it
  would be refused or, worse, attributed to the wrong root.
- _Classify every call on `root[*]`_ (all roots): a mission would need its
  write risks on every environment it holds, and the slice would no longer
  name the label that prices it — a staging edit and a production edit
  would be indistinguishable.
- _Check only writes_: a mission on the "Marketing" root could read the
  "Board" root. Refused: the read check costs the same walk.

### 5.2 Search results outside the mission

Notion's search covers every page and data source shared with the
connection and matches titles only; its filter takes `object` and
`in_trash`, **no ancestor or parent filter**. `execute` therefore **filters
the results to the named root**: each result carries its `parent`, the walk
of §5.1 runs with the memo shared across the result set, and a result is
returned only when proven. A result proven outside the root, or not proven
within the call's budget (`MAX_SEARCH_VERIFY_REQUESTS` = 25 extra
requests), is dropped; the answer carries `results_hidden: <n>`, Notion's
`next_cursor` and `request_status` (which can say `incomplete` /
`query_result_limit_reached`) so the agent can page on. Hidden results are
never named. The `page_size` sent to Notion is the agent's, always sent
explicitly (default 20, ≤ 100).

Search is also not exhaustive ("not guaranteed to return everything") and
its index lags ("search indexing is not immediate"); Notion recommends
querying a data source for anything inside a database. The tool's
description says so to the agent.

Searching several roots at once would mean a slice per root and a budget
per root; v0.1 keeps one root per search like every other tool (Open
question 2).

### 5.3 Creating a page: its parent

`create_page` takes `parent_page_id`, never a free `parent` object
(refused). The parent is walked like a target: the new page lands under
`R` because its parent does. `parent_page_id` = `R` is the common case
(zero hops). A page **at the top of the workspace** is not offered: an
internal connection must name a page or data source parent (`workspace`
parents are for public connections and personal access tokens only), and
it would belong to no resource. A database root has no page parent:
creating in it is `create_entry`. Giving `parent_page_id` the id of a
database entry creates a sub-page inside that entry — allowed, it is under
the root. A page under a page has a `title` and no other property.

### 5.4 Database entries, relations, rollups and people

- **Entry or page.** An entry is a page whose parent is a data source; the
  classifier cannot tell an entry from a page by its id. Two tools with
  their own risks, and `execute` checks the claim: `update_page` refuses a
  page whose parent is a data source ("an entry of a database: use
  `notion__update_entry`"), `update_entry` refuses a page whose
  `parent.data_source_id` is not the `data_source_id` named, and walks
  that data source to `R`. `update_page` takes only `title`, `icon`,
  `cover`: outside a data source a page's only property is its title.
- **Relation writes.** A `relation` value lists up to 100 page ids, and a
  list value replaces the whole list. Writing one links the entry to other
  pages. A two-way relation (`type: "dual_property"`) has a matching
  property on the target data source (`dual_property.synced_property_id`),
  so the related page shows the link too; that a write here changes the
  related page's value is implied by that sync, not stated in so many
  words ⚠. Each related id "must belong to the data source named by the
  relation schema". Every id in a relation value is walked to `R`; one
  outside is refused. A relation to a database of another root is
  therefore not writable in v0.1 (Open question 4).
- **Rollups and relations on read.** A page answer returns at most 25
  references of a relation (`has_more: true` beyond), may omit people past
  25, and returns at most 25 mentions in a title or rich text; "formula and
  rollup results can depend on references the page response does not fully
  load". The property-item endpoint that reads the full value is not
  offered in v0.1 (its property id is percent-encoded and travels in a
  path). Rollup values are computed by Notion from the related pages, and
  only from those the connection can read: "missing access can leave
  relation values empty or make formula and rollup results incomplete".
  So a rollup never carries data from a page that was not shared with the
  connection, but it can carry data from a page **under another root** that
  was shared — outside the mission. The plugin returns them as Notion
  computes them — values of the entry, not the related pages. Recorded as a
  leak of aggregated values across roots (Open question 5). For the same
  reason an empty relation or rollup may mean "not shared", not "empty":
  the tool's description says so to the agent.
- **People properties and mentions** take user ids; the plugin does not
  list users (**PO**), so the agent reuses ids it read. Writing a person or
  a mention notifies them — in the reasons of the write risks. Notion's
  `notifications: { mode: "silent" }` would suppress that; it is not
  declared in v0.1 (Open question 12).
- **Linked and synced data sources.** A linked view inside root A of a data
  source that lives under root B: `query_data_source` walks the data source
  to its database, under B, and refuses. A view cannot be used to reach
  another root. Notion says linked or externally synced data sources "may
  have other parents" (a `data_source_id` parent) and are "not thoroughly
  supported"; the walk follows such a parent through the `database_id` it
  carries, and refuses what it cannot follow. Search excludes duplicated
  linked databases.
- **Queries return pages only.** `POST /v1/data_sources/{id}/query` can
  return pages or data sources (wikis); the executor sends `result_type:
"page"`. A query stops at 10 000 results (`request_status: incomplete`,
  passed through).

### 5.5 Trash

`trash_page` sends `in_trash: true` on `PATCH /v1/pages/{id}` (the trash
page reference); restoring is the same request with `in_trash: false`, and
the API cannot delete a page permanently. The capability is Update content
(`PATCH /v1/pages` needs it). Trashing a page takes its subtree with it
⚠ (the reference does not say; it is how the Notion app behaves), hence
`blast: bulk`; how long the trash keeps it is not stated ⚠. The root page
itself also emits `root[R].trash.W` (the classifier compares the canonical
`page_id` with `R`, which is pure), so it needs `root-trash`, in no preset.
A database root cannot be trashed by this tool (no database change in
scope — **PO**). No restore tool in v0.1 (Open question 8).

### 5.6 Reading a page's content: `depth`

`get_page` returns properties, not content; content is the block tree, read
with `GET /v1/blocks/{id}/children` (a page id is accepted as the block id),
which returns **only the first level**: nested content must be read
recursively from each block with `has_children: true`.
`list_block_children` with `depth` 2 or 3 does that in the same call, after
**one** walk for `block_id` — every block met below is under it by
construction. Ceilings: `MAX_BLOCKS_PER_CALL` = 500, at most
`MAX_CHILD_REQUESTS` = 20 child listings per call; reached, the answer says
so and carries the ids not expanded. A `child_page` block is a reference
with a title and no children: it is not expanded (the sub-page is read with
its own call). Without `depth`, an agent reading a page with 30 toggles
would pay 30 walks.

### 5.7 Synced blocks

A synced block is either an original (`synced_from: null`) or a duplicate
(`synced_from: { type: "block_id", block_id }`), whose children mirror the
original's, which may live elsewhere. On read, a duplicate is expanded only
when its original is walked to `R`; otherwise its children are not fetched
and the answer says why. Whether Notion itself serves a duplicate's
children when the original is not shared with the connection is not stated
⚠ — the walk makes the answer irrelevant. On write, the API does create
duplicates; appending one is refused by the classifier, since it would
show content from wherever the original lives.

### 5.8 Comments

`list_comments` takes `block_id`, "a Notion block or page", and returns the
**unresolved** comments only, each with its `discussion_id` and its
`parent` (`page_id` or `block_id`). `create_comment` sends exactly one of
`parent.page_id`, `parent.block_id` or `discussion_id`: a new discussion on
a page or a whole block (the API cannot anchor one on a text selection), or
a reply. The executor picks `page_id` or `block_id` from the target it
walked. A reply's `discussion_id` cannot be looked up on its own: `execute`
lists the comments of `block_id` (at most 5 pages of 100) and refuses a
`discussion_id` not found there, so a reply cannot land on a discussion of
another root — nor on a resolved one, which the listing does not return.
Both comment capabilities are off by default on a new connection.

### 5.9 Content is attacker-influenced

Pages, comments and entries are written by people, inside and sometimes
outside the company (guests, forms). Everything the plugin returns is
provider text; nothing in it is ever read as an instruction by the plugin.
Said in the reason of `read-content`.

## 6. Credential, discovery, execution, tests

### 6.1 Credential (**PO**: `api-key`, token first)

One `api-key` spec, no alternative, no company app: an internal connection
is made per workspace by its owner (ADR
[`company-apps-kept-where-they-add-something`](../../decisions/company-apps-kept-where-they-add-something.md),
D2 "token first";
[`token-connections-beside-the-integration-app`](../../decisions/token-connections-beside-the-integration-app.md)
D1 for `label`, `guide`, `verify`). A public connection (OAuth) and a
personal access token are out of v0.1 (Open questions 9 and 13).

Notion has three kinds of token (authorization guide): an **internal
connection** token, static and tied to one workspace, reaching only what
is shared with the connection; a **public connection**'s OAuth token; and a
**personal access token**, which "acts as the user who created it" and
"can access pages, data sources, databases, comments, files, and other
resources that the creator can access", without any page being shared, and
expires after 7 days to 1 year. Only the first matches the resource model
(PO: resources are what is shared with the integration), so `verify`
refuses the others.

- `label`: "internal connection token".
- Field `api_token`: `secret: true`, required, `pattern` `^\S{20,512}$`
  (no whitespace or control character, a bounded length) and nothing
  more. Tokens made since 2024-09-25 start `ntn_`; older `secret_` tokens
  "will continue to work", and Notion "strongly advise[s] against using
  regular expressions … to identify or validate" its tokens because "the
  token format may change over time": validate "by making authenticated
  requests", which is what `verify` does. The placeholder shows `ntn_…`.
- `createUrl`: `https://app.notion.com/developers/connections` (Developer
  portal → Build → Internal connections; only a Workspace Owner can create
  one).
- `verify(ctx)`: `GET /v1/users/me`, which answers with any content or
  comment capability. The answer is a bot user whose `bot.owner` is
  `{ type: "workspace", workspace: true }` for an internal connection and
  `{ type: "user", … }` for a personal access token: **anything but a
  workspace owner is refused** ("paste an internal connection token, not a
  personal access token"). `account` = `bot.workspace_name`, or
  `bot.workspace_id` when the name is `null`; `expiresAt` = `null` (an
  internal connection "sends the same token in every API request"; no
  expiry is documented for it, unlike personal access tokens and OAuth
  grants ⚠). A `401` throws
  `UpstreamAuthError`, nothing is stored.
- `guide` (rendered on the connect page):
  - steps: "Open Notion's Developer portal, go to Build → Internal
    connections and create a connection in the workspace you want to
    connect (you must be a Workspace Owner)." / "On the Configuration tab,
    tick the capabilities listed below and choose No user information." /
    "Copy the token from the Configuration tab and paste it here." / "Give
    the connection access only to the pages and databases the agents need:
    on each top-level page, open the ••• menu → Connections → + Add
    connection, or use the Content access tab → Edit access. Sharing a page
    includes everything under it."
  - permissions: `Read content` (read) → every read tool; `Insert content`
    (read-write) → `create_page`, `append_blocks`, `create_entry`; `Update
content` (read-write) → `update_page`, `update_entry`, `trash_page`;
    `Read comments` (read) → `list_comments`; `Insert comments`
    (read-write) → `create_comment`. Insert content "doesn't grant full read
    access", so Read content is always needed.
  - `recommendedExpiryDays`: `null`.
- `help`: "Create an internal connection with only the capabilities the
  agents need, and share with it only the top-level pages and databases
  they may work in: everything under a shared page is reachable with this
  token, whatever the gateway allows."
- `manualRevocation`: "In Notion's Developer portal, open the connection
  and refresh its token on the Configuration tab, or remove the connection
  from the shared pages (••• → Connections)." Whether refreshing
  invalidates the old token at once is not stated ⚠.

### 6.2 Discovery

`discoverResources` pages through `POST /v1/search` (no `query`,
`page_size` 100) for pages, then for data sources (`filter: { property:
"object", value: "data_source" }`), up to `MAX_SEARCH_PAGES` = 20 per kind
(2 000 objects). Notion does not support enumerating everything a
connection can reach through search, but guarantees that "any pages or
databases that are directly shared with a connection are guaranteed to be
returned" — and a root is, by definition, directly shared. It keeps:

- a **page** whose parent is `workspace`, or a `page_id` / `block_id` /
  `data_source_id` parent not in the set found — then confirmed with one
  `GET` on that parent: a `404` makes the page a root; a readable parent (a
  block of a shared page, which search does not list) means it is not;
- a **database**, from each data source's `parent.database_id` (its
  `database_parent` tells where the database sits), kept when that parent
  is outside the set by the same rule.

At most `MAX_DISCOVERED_ROOTS` = 200; the README states the ceilings, and
discovery fails (rather than silently truncating) when the search did not
end within `MAX_SEARCH_PAGES`. Search indexing is not immediate: a page
shared a moment ago may appear only at the next refresh, which the
connection page says. Every id goes through `notionId`; every payload
through a type guard; a payload it does not recognise fails discovery.
Discovery is the one place the plugin spends many requests at once — up to
~40 search pages and one `GET` per candidate — sent one after the other.

### 6.3 Execution

- Base `https://api.notion.com/v1` (`NOTION_API_BASE`), headers
  `Authorization: Bearer <token>`, `Notion-Version: 2026-03-11`,
  `Content-Type: application/json`. `ctx.fetch` only; the body of
  `executeNotion` runs under `declining`.
- `execute` re-reads every identifier with the classifier's functions
  (`resolveRoot`, `notionId`, `readTargets`) and builds each request from
  them; `undeclaredArgument` again first.
- Then the ancestry check (§5.1) for every id the call acts on, then the
  call. Refusals: `ExecutorRefusal`. Failures (status codes page): `401
unauthorized` → `UpstreamAuthError(…, 401)`; `403 restricted_resource`
  (a capability the connection lacks, or a workspace block limit) →
  `UpstreamAuthError(…, 403)`, the message naming the capability to tick;
  any other failed status (`400 validation_error`, `404`, `409
conflict_error`, `429`, `5xx`, `529`) → `UpstreamHttpError`.
- `list_roots` calls nothing: it returns the mission's Notion resources
  (ref, title, kind, label).

Endpoints per tool:

| Tool                  | Requests, after the walk                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_roots`          | none                                                                                                                                            |
| `search_content`      | `POST /v1/search` (`query`, `filter.object`, `sort`, `page_size`, `start_cursor`), then the filter of §5.2                                      |
| `get_page`            | `GET /v1/pages/{page_id}` (the first hop)                                                                                                       |
| `list_block_children` | `GET /v1/blocks/{block_id}/children?page_size=&start_cursor=` (× up to 20 with `depth`)                                                         |
| `get_database`        | `GET /v1/databases/{database_id}` (the first hop)                                                                                               |
| `get_data_source`     | `GET /v1/data_sources/{data_source_id}` (the first hop)                                                                                         |
| `query_data_source`   | `POST /v1/data_sources/{data_source_id}/query` (`filter`, `sorts`, `page_size`, `start_cursor`, `result_type: "page"`)                          |
| `create_page`         | `POST /v1/pages` (`parent: { page_id }`, `properties.title`, `children`, `icon`, `cover`)                                                       |
| `update_page`         | `GET /v1/pages/{page_id}` (first hop, parent kind) then `PATCH /v1/pages/{page_id}` (`properties.title`, `icon`, `cover`)                       |
| `append_blocks`       | `PATCH /v1/blocks/{block_id}/children` (`children`, `position`)                                                                                 |
| `trash_page`          | `PATCH /v1/pages/{page_id}` (`in_trash: true`)                                                                                                  |
| `create_entry`        | `POST /v1/pages` (`parent: { data_source_id }`, `properties`, `children`, `icon`)                                                               |
| `update_entry`        | `GET /v1/pages/{page_id}` (parent = the data source) then `PATCH /v1/pages/{page_id}` (`properties`, `icon`)                                    |
| `list_comments`       | `GET /v1/comments?block_id=&page_size=&start_cursor=`                                                                                           |
| `create_comment`      | (reply: `GET /v1/comments?block_id=` ≤ 5 pages) then `POST /v1/comments` (`parent.page_id` / `parent.block_id` or `discussion_id`, `rich_text`) |

Pagination (API introduction): `page_size` is 1–100 on every paginated
endpoint (search, block children, query, comments); the documentation
gives two different defaults (100 in the parameter table, ten in the
prose), so the plugin **always sends `page_size`**: 20 for search and
comments, 50 for children and queries, 100 in discovery. `start_cursor` is
the previous `next_cursor`, "an opaque value", present only while
`has_more` is true; it goes in the query string of a `GET` and in the body
of a `POST`. Plugin ceilings (stated in its README): `MAX_ANCESTRY_DEPTH`
16; `MAX_SEARCH_VERIFY_REQUESTS` 25; `MAX_BLOCKS_PER_CALL` 500 and
`MAX_CHILD_REQUESTS` 20 (`depth`); 5 comment pages for a reply check;
discovery `MAX_SEARCH_PAGES` 20 per kind and `MAX_DISCOVERED_ROOTS` 200.
Notion's request limits refused up front are listed in §2.

### Identifiers

One grammar per kind, in `resources.ts`, read by `classify` and `execute`
alike; a value outside its grammar is refused, never repaired.

| Value                                                                                                                              | Grammar                                                                                                                                                                                                                                                            | Where it lands                                                                                                   | Outside the grammar                              |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `root`, `page_id`, `parent_page_id`, `block_id`, `database_id`, `data_source_id`, `after_block_id`, `discussion_id`, resource refs | `notionId` — a UUID with dashes (`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`) or without (`^[0-9a-fA-F]{32}$`; "you may omit dashes from the ID when making requests"); returns the **canonical** form, lower-case with dashes | URL path segment (canonical), JSON body (`parent`, `position.after_block.id`, `discussion_id`), slice identifier | `denied` / refusal: `<arg>: malformed Notion id` |
| ids inside `properties` (relation targets, people), inside `children` (`link_to_page`, mentions, `synced_from`)                    | `notionId`                                                                                                                                                                                                                                                         | JSON body; relation targets and synced originals are walked (§5.4, §5.7)                                         | `denied`                                         |
| ids Notion answers (parents during a walk, search results, discovery)                                                              | `notionId`                                                                                                                                                                                                                                                         | the next hop's URL path; resource refs                                                                           | the walk refuses; discovery fails                |
| `start_cursor`                                                                                                                     | `cursor` — `^[A-Za-z0-9-]{1,128}$` (Notion types it as a UUID string on search and block children and calls it opaque; the grammar is wider than a UUID and still carries no separator)                                                                            | query string (`URLSearchParams`) or JSON body; never a path, never a slice                                       | `denied`: `start_cursor: malformed`              |
| `page_size`, `depth`                                                                                                               | integers 1–100, 1–3                                                                                                                                                                                                                                                | query string / body; `depth` stays in the executor                                                               | `denied`                                         |
| `position`                                                                                                                         | one of `end`, `start`, `after_block`                                                                                                                                                                                                                               | JSON body, built by the executor                                                                                 | `denied`                                         |
| `query`, `title`, `filter`, `sorts`, `rich_text`, `properties` keys and values, `icon`, `cover`                                    | none — not identifiers; JSON values. `icon` / `cover` external URLs must be `https:` and ≤ 2 000 characters (`httpsUrl`)                                                                                                                                           | JSON body only                                                                                                   | `denied` for a non-https or overlong URL         |

A Notion page URL (`https://www.notion.so/Title-<32 hex>`) is **not** an id
and is refused; the refusal tells the agent to pass the 32 hex characters.
Canonicalising the two spellings is reading the one grammar, not repairing
a value: Notion documents both forms as the same id, and a slice, a
resource ref and an ancestry comparison must see one spelling. The
canonical id is a `pathIdent` (letters, digits, dashes, 36 characters), so
it is a single safe path segment and a valid slice identifier.

### 6.4 Tests (planned)

`plugin.test.ts` (kit: `assertPluginWellFormed`, `assertPresetsValid`,
`assertNoWildcard`, `assertCatalogCoverage` with samples for the 15 tools,
`fallbackHits` empty, `risksUntouched` empty; `assertIdentifiersRefused` on
the same samples with routes for the walk), `classify.test.ts` (one case per
branch: root resolution, every refusal of §2 including the request limits
and the refused block types, the root-trash double slice),
`ancestry.test.ts` against `mockFetch` (proven in 0, 1, n hops; a data
source proven through `database_parent`; workspace parent; `agent_id`
parent; hidden ancestor `404` → refusal with no write sent; target `404` →
thrown; `403 restricted_resource` → `UpstreamAuthError`; depth 17 →
refusal; cycle → refusal; malformed parent id → refusal; memo shared across
a search result set; entry/page mismatch; relation target outside;
discussion not found or resolved), `discovery.test.ts` (top-level
detection, block parents, a personal access token refused by `verify`,
ceilings, unknown payload), `identifiers.test.ts` (hostile values in every
id position of `classify` and `execute`: `..`, `%2e%2e`, `%2f`, a dashed
UUID with a trailing `/x`, a 32-hex id with a line break),
`risk-catalog.test.ts` (no overlap between write patterns, the root trash
touching two risks, the env-scoped set), `mission-evaluation.test.ts` (each
preset call by call, unlabelled root refused on writes).

## 7. Facts still unverified

Of the six facts left open after WebFetch, Context7 settled two:

- **Settled — token format** (§6.1): `ntn_` since 2024-09-25, `secret_`
  still valid, no regex validation (Notion changelog).
- **Settled — rollups** (§5.4): computed only from pages the connection can
  read (property object and page property values references).

Still not stated by the documentation, in WebFetch or in Context7; each is
marked ⚠ where it is used. None changes a refusal of the classifier; each
is to be checked against the real service before the plugin ships:

1. Whether an internal connection token expires, and whether refreshing it
   on the Configuration tab invalidates the old one at once (§6.1). (The
   180-day / 30-day expiry Context7 returned is for OAuth refresh tokens of
   Notion's MCP server, not for internal tokens.)
2. That trashing a page trashes its subtree, and how long the trash keeps
   it (§5.5). The trash reference only says the API cannot delete
   permanently and `in_trash: false` restores.
3. That a write to a two-way relation changes the related page's value
   (§5.4): the synced property is documented, the effect of a write on it
   is not.
4. Whether Notion serves a synced duplicate's children when the original is
   not shared (§5.7) — the walk makes the answer irrelevant to safety.

Pages read only in part (WebFetch reads the first 100 000 characters of a
page): the references of query a data source, update page, create a page,
and append block children; the parameters quoted here come from the parts
read. The upgrade guide for `2025-09-03` names the query as `PATCH`; the
endpoint reference says `POST`, which this page follows.

## Decisions

Taken by the product owner on 2026-10-16 (marked **(PO)**), or the proposed
default of the draft kept as written (marked _default_). Each closes the open
question of the same number in the reviewed draft.

1. **No environment (PO).** No entity is `envScopable`, no risk has
   `acceptable_in_envs`, no preset entry is env-qualified. A root is written
   whatever its owner's label. The presets put `gate: approval` on the
   destructive operations instead: moving a page to the trash, deleting a
   block; trashing a whole root stays in no preset.
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
   `notion.page-restore` (§5.5).
9. **No public connection (OAuth)** (_default_): token first.
10. **`editor` writes run freely** (_default_); only the destructive
    operations ask first (decision 1).
11. **`notion__update_block` and `notion__delete_block` added (PO)**, each
    with its own risk (`notion.block-update`, `notion.block-delete` through a
    verb leaf), the same ancestry check as every write and the same refused
    block types and limits.
12. **Notifications silent (PO).** Every write whose endpoint accepts it sends
    `notifications: { mode: "silent" }`; the agent cannot change it (an
    undeclared argument). Where it applies is in §6.3.
13. **Personal access tokens refused at `verify` (PO)**; credential `api-key`
    on an internal connection.

## Sources

Read on 2026-10-16 with WebFetch, restricted to `developers.notion.com`: a
one-off exception, authorised by the product owner, to the rule that
provider documentation comes from Context7 (Context7 answered "Monthly
quota exceeded" to `resolve-library-id` and `query-docs`).

**Context7**, once reconnected with its key (same day), libraries
`/websites/developers_notion` and `/websites/developers_notion_reference`
(`query-docs`). What it confirmed or added:

| Fact                                                                                                               | Context7 page                                                                              |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Latest `Notion-Version` is `2026-03-11` (the pin; the Admin API's `2026-06-01` is a separate API)                  | `reference/versioning`, `reference/admin/versioning`                                       |
| Token prefix `ntn_` since 2024-09-25, `secret_` still valid, do not validate tokens with a regex                   | `page/changelog` (2024-09-11)                                                              |
| Internal token: the same token on every request, refreshable on the Configuration tab (no expiry stated)           | `guides/get-started/internal-connections`, `guides/get-started/authorization`              |
| Trash and restore with `in_trash`, no permanent deletion through the API (subtree and retention not stated)        | `reference/trash-page`                                                                     |
| `is_archived` (archive) is separate from `in_trash` (trash)                                                        | `reference/query-a-data-source`                                                            |
| Two-way relation = `dual_property` with `synced_property_id`; relation ids must belong to the target source        | `reference/property-object`, `reference/page-property-values`                              |
| Missing access leaves relations empty and formulas / rollups incomplete                                            | `reference/property-object`, `reference/page-property-values`                              |
| Synced block shapes (original `synced_from: null`, duplicate `synced_from.block_id`); synced content not updatable | `reference/block` (whether a duplicate's children need access to the original: not stated) |

**WebFetch** (the exception above), for everything else on this page: the
version changes of §0, every endpoint, parameter, parent shape, limit,
error code, capability, sharing step and personal-access-token fact. The
pages read:

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
  <https://developers.notion.com/reference/post-page>,
  <https://developers.notion.com/reference/patch-page>,
  <https://developers.notion.com/reference/trash-page.md>,
  <https://developers.notion.com/reference/get-block-children>,
  <https://developers.notion.com/reference/patch-block-children>,
  <https://developers.notion.com/reference/query-a-data-source>,
  <https://developers.notion.com/reference/list-comments>,
  <https://developers.notion.com/reference/create-a-comment>,
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
