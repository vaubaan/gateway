---
title: Miro provider plugin
status: draft
date: 2026-10-16
last_synced: 2026-10-16
tracks:
  - plugins/miro/src/
  - plugins/miro/tests/unit/
---

# Miro provider plugin

> **Draft, phase 1 of [`provider-modeler`](../../skills/provider-modeler.md):
> nothing under `plugins/miro/` exists yet.** This page proposes the model
> for a human review before any code. Decisions already taken by the
> product owner are marked **(PO)**; the questions left to him are in
> "Open questions" at the end. Every fact about Miro's API on this page was
> read on developers.miro.com on 2026-10-16 (see "Sources": Context7 was
> unavailable, and the product owner authorised a one-off exception). A
> fact the documentation does not state is marked **⚠ unverified**, and
> the model is built so that it fails closed when the fact turns out worse
> than assumed.

`@vaubaan/plugin-miro` 0.1.0 (proposed), tool prefix `miro__`, Miro REST API
v2 (`https://api.miro.com/v2`). Scope v0.1 **(PO)**: "boards + items" —
list and read boards; read items (generic list and get); create, update and
delete sticky notes, shapes, texts, cards, frames and connectors; tags
(read, create, attach, remove — argued in §5.9). **Out of scope (PO)**:
creating, copying or deleting a board; sharing; board members.

**Token expiry, the deciding fact, in one paragraph** (details §6.1). A
Miro app chooses at creation between **non-expiring** tokens and
**expiring** ones (access token 1 hour, refresh token 60 days, both rotated
on every refresh), and "you cannot enable, disable, or update this setting
after you create your app". A refresh needs the app's `client_id` **and
`client_secret`**, which an `api-key` connection never holds. So **`api-key`
is viable only with a non-expiring token**: the person leaves "Expire user
authorization token" **unchecked** when creating the app. Miro still offers
that choice, calls it "fine for test applications", recommends expiring
tokens, and announces no deprecation on the pages read. If Miro drops it,
the plugin needs a second way, `oauth2` with `refreshable: true` through a
company app (Open question 2).

## 1. Data model

One plane, `board`. The **board** is the resource; the **environment** is
the owner's label on it **(PO)**.

```
board[<board ref>]            the resource; labelled staging / prod by its owner (envScopable)
  ├─ item[<item id>]          sticky note, shape, text, card (and, read-only, any other item type)
  │    ├─ delete              verb leaf: deleting the item
  │    └─ tag-link[<tag id>]  a tag attached to the item (attach / remove)
  ├─ frame[<item id>]         a frame: a parent item that contains other items
  │    └─ delete              verb leaf: deleting the frame (children may go with it, §5.4)
  ├─ connector[<id>]          a line between two items
  │    └─ delete              verb leaf
  └─ tag[<tag id>]            a tag of the board (board-scoped vocabulary)
```

| Entity      | Parent                       | Cardinalities      | Notes                                                                                                                                                                                                                          |
| ----------- | ---------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `board`     | —                            | `one`, `unbounded` | The resource (`envScopable: true`). `unbounded` for `list_boards` only.                                                                                                                                                        |
| `item`      | `board`                      | `one`, `unbounded` | Every item that is not a frame or a connector. Miro's items share one id space (frames are items too: `GET /items?type=frame`).                                                                                                |
| `frame`     | `board`                      | `one`, `unbounded` | A separate entity although Miro stores it as an item, because deleting one has its own risk (§5.4). Frames are the only parents the platform supports ("Kanban, Mind Map, Table, and User Story Mapping" are not, as parents). |
| `connector` | `board`                      | `one`, `unbounded` | Its own endpoints (`/connectors`), its own ids; not returned by `GET /items` (the `type` enum has no connector).                                                                                                               |
| `tag`       | `board`                      | `one`, `unbounded` | "When you create a tag, it is added to the current board". At most 100 per board (documented for the Web SDK and the board UI; the REST page is silent).                                                                       |
| `tag-link`  | `item`                       | `one`              | Attaching or removing a tag on a card or sticky note (up to 8 tags per item).                                                                                                                                                  |
| `delete`    | `item`, `frame`, `connector` | `one`              | Verb leaf, declared once per parent (three entries named `delete`; `validateDataModel` checks parents by name only, as Cloudflare DNS and the template do with one).                                                           |

Not modelled: board members and sharing (out of scope), images, documents,
embeds, app cards (readable through `get_item` / `list_items`, not
writable in v0.1), mind maps, the experimental and flowchart endpoints.

## 2. Tool → slice mapping

Every tool takes `board` — the board **ref** (§Identifiers) — as an explicit
argument. Kit rule (template's `resolveWorkspace`): a `board` given must be
one of the mission's Miro resources, otherwise `denied`; absent, the
mission's single Miro board; none or several, `denied`. The classifier never
guesses a board from an item id.

`B` = the resolved board ref; `I`, `F`, `C`, `T` = an item, frame,
connector, tag id (numeric strings, §Identifiers).

| Tool                       | Arguments (required in **bold**)                                                                                          | Slice(s)                                             | Miro endpoint(s)                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| `miro__list_boards`        | —                                                                                                                         | `miro.board[B].R` for each Miro board of the mission | `GET /v2/boards/{id}` per mission board (L1 each), no listing call (§5.10)     |
| `miro__get_board`          | `board`                                                                                                                   | `miro.board[B].R`                                    | `GET /v2/boards/{board_id}` (L1)                                               |
| `miro__list_items`         | `board`, `type`, `parent_frame_id`, `limit`, `cursor`                                                                     | `miro.board[B].item[*].R`                            | `GET /v2/boards/{board_id}/items` (L2; `parent_item_id` when a frame is given) |
| `miro__get_item`           | `board`, **`item_id`**                                                                                                    | `miro.board[B].item[I].R`                            | `GET /v2/boards/{board_id}/items/{item_id}` (L1)                               |
| `miro__list_connectors`    | `board`, `limit`, `cursor`                                                                                                | `miro.board[B].connector[*].R`                       | `GET /v2/boards/{board_id}/connectors` (L2)                                    |
| `miro__get_connector`      | `board`, **`connector_id`**                                                                                               | `miro.board[B].connector[C].R`                       | `GET /v2/boards/{board_id}/connectors/{connector_id}`                          |
| `miro__list_tags`          | `board`, `limit`, `offset`                                                                                                | `miro.board[B].tag[*].R`                             | `GET /v2/boards/{board_id}/tags` (L1)                                          |
| `miro__list_item_tags`     | `board`, **`item_id`**                                                                                                    | `miro.board[B].item[I].tag-link[*].R`                | `GET /v2/boards/{board_id}/items/{item_id}/tags`                               |
| `miro__create_sticky_note` | `board`, `data`, `style`, `position`, `geometry`, `parent_frame_id`                                                       | `miro.board[B].item.W`                               | `POST /v2/boards/{board_id}/sticky_notes` (L2)                                 |
| `miro__update_sticky_note` | `board`, **`item_id`**, `data`, `style`, `position`, `geometry`, `parent_frame_id`                                        | `miro.board[B].item[I].W`                            | `GET …/items/{id}` (type check, L1), `PATCH …/sticky_notes/{item_id}` (L2)     |
| `miro__delete_sticky_note` | `board`, **`item_id`**                                                                                                    | `miro.board[B].item[I].delete.W`                     | `GET …/items/{id}` (L1), `DELETE …/sticky_notes/{item_id}` (L3)                |
| `miro__create_shape`       | as `create_sticky_note`                                                                                                   | `miro.board[B].item.W`                               | `POST /v2/boards/{board_id}/shapes` (L2)                                       |
| `miro__update_shape`       | as `update_sticky_note`                                                                                                   | `miro.board[B].item[I].W`                            | `GET …/items/{id}`, `PATCH …/shapes/{item_id}` (L2)                            |
| `miro__delete_shape`       | `board`, **`item_id`**                                                                                                    | `miro.board[B].item[I].delete.W`                     | `GET …/items/{id}`, `DELETE …/shapes/{item_id}`                                |
| `miro__create_text`        | `board`, **`data`**, `style`, `position`, `geometry`, `parent_frame_id`                                                   | `miro.board[B].item.W`                               | `POST /v2/boards/{board_id}/texts` (L2)                                        |
| `miro__update_text`        | as `update_sticky_note`                                                                                                   | `miro.board[B].item[I].W`                            | `GET …/items/{id}`, `PATCH …/texts/{item_id}` (L2)                             |
| `miro__delete_text`        | `board`, **`item_id`**                                                                                                    | `miro.board[B].item[I].delete.W`                     | `GET …/items/{id}`, `DELETE …/texts/{item_id}`                                 |
| `miro__create_card`        | as `create_sticky_note` (no `assigneeId`, §5.8)                                                                           | `miro.board[B].item.W`                               | `POST /v2/boards/{board_id}/cards` (L2)                                        |
| `miro__update_card`        | as `update_sticky_note` (no `assigneeId`)                                                                                 | `miro.board[B].item[I].W`                            | `GET …/items/{id}`, `PATCH …/cards/{item_id}` (L2)                             |
| `miro__delete_card`        | `board`, **`item_id`**                                                                                                    | `miro.board[B].item[I].delete.W`                     | `GET …/items/{id}`, `DELETE …/cards/{item_id}`                                 |
| `miro__create_frame`       | `board`, **`data`**, `style`, `position`, `geometry`                                                                      | `miro.board[B].frame.W`                              | `POST /v2/boards/{board_id}/frames` (L2)                                       |
| `miro__update_frame`       | `board`, **`frame_id`**, `data`, `style`, `position`, `geometry`                                                          | `miro.board[B].frame[F].W`                           | `GET …/items/{id}`, `PATCH …/frames/{item_id}` (L2)                            |
| `miro__delete_frame`       | `board`, **`frame_id`**                                                                                                   | `miro.board[B].frame[F].delete.W`                    | `GET …/items/{id}`, `DELETE …/frames/{item_id}` (L3)                           |
| `miro__create_connector`   | `board`, **`start_item_id`**, **`end_item_id`**, `start_snap_to`, `end_snap_to`, `shape`, `captions`, `style`             | `miro.board[B].connector.W`                          | `POST /v2/boards/{board_id}/connectors` (L2)                                   |
| `miro__update_connector`   | `board`, **`connector_id`**, `start_item_id`, `end_item_id`, `start_snap_to`, `end_snap_to`, `shape`, `captions`, `style` | `miro.board[B].connector[C].W`                       | `PATCH /v2/boards/{board_id}/connectors/{connector_id}` (L2)                   |
| `miro__delete_connector`   | `board`, **`connector_id`**                                                                                               | `miro.board[B].connector[C].delete.W`                | `DELETE /v2/boards/{board_id}/connectors/{connector_id}`                       |
| `miro__create_tag`         | `board`, **`title`**, `fill_color`                                                                                        | `miro.board[B].tag.W`                                | `POST /v2/boards/{board_id}/tags` (L1)                                         |
| `miro__attach_tag`         | `board`, **`item_id`**, **`tag_id`**                                                                                      | `miro.board[B].item[I].tag-link[T].W`                | `POST /v2/boards/{board_id}/items/{item_id}?tag_id=…` (L1)                     |
| `miro__remove_tag`         | `board`, **`item_id`**, **`tag_id`**                                                                                      | `miro.board[B].item[I].tag-link[T].W`                | `DELETE /v2/boards/{board_id}/items/{item_id}?tag_id=…` (L1)                   |

29 tools. L1–L3 are Miro's rate-limit levels (§3, "Rate limits"); a level
not written was not stated on a page read.

Titles (`toolTitles`): "List the boards", "Read a board", "List a board's
items", "Read an item", "List connectors", "Read a connector", "List a
board's tags", "List an item's tags", "Add a sticky note", "Edit a sticky
note", "Delete a sticky note", "Add a shape", "Edit a shape", "Delete a
shape", "Add a text", "Edit a text", "Delete a text", "Add a card", "Edit a
card", "Delete a card", "Add a frame", "Edit a frame", "Delete a frame",
"Connect two items", "Edit a connector", "Delete a connector", "Create a
tag", "Tag an item", "Remove a tag from an item".

**Refused by the classifier** (`denied`, audited, never executed): an
unknown tool; `board` outside the mission, malformed, ambiguous, or absent
with zero / several Miro boards; an id outside its grammar (`item_id`,
`frame_id`, `connector_id`, `tag_id`, `start_item_id`, `end_item_id`,
`parent_frame_id`); `start_item_id` equal to `end_item_id` (Miro's own
rule: "startItem.id must be different from endItem.id"); `limit` outside
10–50 on items and connectors, 1–50 on tags (Miro's bounds); a `type`
outside Miro's item-type enum; a key of `data`, `style`, `position` or
`geometry` outside the tool's allowlist (§ "Undeclared arguments"); a
`captions` list longer than 20 or a caption over 200 characters (Miro's
limits); a tag `title` over 120 characters; an undeclared argument.

**Bulk creation is not offered** (`POST /v2/boards/{board_id}/items/bulk`,
up to 20 items in one transactional call, frames included). Argued in §5.6.

### Undeclared arguments

The plugin **refuses undeclared arguments** in `classify` and again in
`execute` (`undeclaredArgumentDenial` with `declared =
declaredArgumentsOf(miroTools)`, wrapped in one exported
`undeclaredArgument(tool, args)`), **and** closes one level deeper: the
four objects a write forwards to Miro — `data`, `style`, `position`,
`geometry` — are checked key by key against an allowlist per tool, taken
from Miro's request schemas (e.g. sticky note `data`: `content`, `shape`;
`style`: `fillColor`, `textAlign`, `textAlignVertical`; `position`: `x`,
`y`; `geometry`: `width`, `height`). An unknown key is `denied` in
`classify` and declined in `execute`, because those objects are forwarded
as JSON and a field Miro adds later (or an undocumented one) would
otherwise reach the board unpriced. `parent` is **not** one of them: the
parent is the flat identifier `parent_frame_id` (§5.3), which the executor
writes as `parent: { id }` itself. Values inside the allowlisted keys are
Miro's business (an enum Miro rejects comes back as a 400). No `routing`
argument.

## 3. Catalog and presets

5 named risks + the fallback. **Reads are account-scoped** (an owner need
not label a board for an agent to read it); **every write is env-scoped**
(`acceptable_in_envs: [staging, prod]`), so an unlabelled board can be read
but not changed, and a production board's writes have their own budget
(Open question 5 on the labels).

Layering, as in Cloudflare DNS: `content-write` matches every write under a
board (`board[**].…[**].W` patterns are recursive), so a deletion touches
`content-write` **and** its delete risk. A mission that may delete must be
able to edit; a mission that edits need not be able to delete.

```yaml
provider: miro
catalog_version: 1
catalog_date: 2026-10-16

risks:
  # ─── Reads ───────────────────────────────────────────────────────────────

  - id: miro.read-boards
    label: 'Read board details'
    reason: >-
      Name, description, team, links and sharing policy of the selected
      boards, with the names of the people who own, created, last modified
      and last opened them. No email address is returned.
    matches: 'miro.board[*].R'
    infra_limits: { calls_per_minute_max: 200 }
    vector:
      reversibility: reversible
      blast: single
      data: pii
      cost: free
      visibility: internal
      persistence: stateless

  - id: miro.read-board-content
    label: 'Read the items, connectors and tags of a board'
    reason: >-
      Everything written on the board: sticky notes, texts, cards, shapes,
      frames, connectors and tags, with their position and the id of who
      created them. Content written by people, which can carry
      instructions aimed at the agent.
    matches:
      - 'miro.board[**].item[**].R'
      - 'miro.board[**].frame[**].R'
      - 'miro.board[**].connector[**].R'
      - 'miro.board[**].tag[**].R'
    infra_limits: { calls_per_minute_max: 300 }
    vector:
      reversibility: reversible
      blast: single
      data: data
      cost: free
      visibility: internal
      persistence: stateless

  # ─── Writes ──────────────────────────────────────────────────────────────

  - id: miro.content-write
    label: 'Add and edit items on a board'
    reason: >-
      Creates or edits sticky notes, shapes, texts, cards, frames and
      connectors, moves an item in or out of a frame, creates tags and
      tags items. Seen at once by everyone on the board; reversible by
      editing again, but the previous text is not kept by the gateway.
      Every deletion touches this permission too.
    matches:
      - 'miro.board[**].item[**].W'
      - 'miro.board[**].frame[**].W'
      - 'miro.board[**].connector[**].W'
      - 'miro.board[**].tag[**].W'
      - 'miro.board[*].item.W'
      - 'miro.board[*].frame.W'
      - 'miro.board[*].connector.W'
      - 'miro.board[*].tag.W'
    acceptable_in_envs: [staging, prod]
    infra_limits: { calls_per_minute_max: 200 }
    vector:
      reversibility: reversible
      blast: single
      data: data
      cost: free
      visibility: team
      persistence: session
    vector_overrides:
      prod: { reversibility: costly }

  - id: miro.item-delete
    label: 'Delete an item or a connector'
    reason: >-
      Removes a sticky note, shape, text, card or connector. Deleting an
      item also removes the connectors attached to it. The REST API has no
      restore: the content must be written again.
    matches:
      - 'miro.board[**].item[**].delete.W'
      - 'miro.board[**].connector[**].delete.W'
    acceptable_in_envs: [staging, prod]
    infra_limits: { calls_per_minute_max: 40 }
    vector:
      reversibility: costly
      blast: single
      data: data
      cost: free
      visibility: team
      persistence: session

  - id: miro.frame-delete
    label: 'Delete a frame'
    reason: >-
      Removes a frame, which can group up to 5000 items. Miro's
      documentation does not say whether the items inside go with it, so
      this permission assumes they may: a whole section of the board, with
      no restore through the API.
    matches: 'miro.board[**].frame[**].delete.W'
    acceptable_in_envs: [staging, prod]
    infra_limits: { calls_per_minute_max: 10 }
    vector:
      reversibility: irreversible
      blast: bulk
      data: data
      cost: free
      visibility: team
      persistence: session

  # ─── Fallback (required) ─────────────────────────────────────────────────

  - id: miro.uncategorized-write
    label: 'Uncategorized Miro write'
    reason: >-
      Catch-all for writes without a dedicated entry. Seen in an audit, it
      means a tool classifies to a slice no entry covers: add the entry.
    matches: 'miro.[**].W'
    fallback: true
    acceptable_in_envs: [staging, prod]
    vector:
      reversibility: costly
      blast: bulk
      data: data
      cost: free
      visibility: team
      persistence: session

presets:
  - id: read-only
    label: Read-only
    description: Board details and everything on the selected boards. Nothing is changed.
    entries:
      - risk_id: miro.read-boards
        quota: 1000
        rate_limit: { max: 30, window_seconds: 60 }
        gate: auto
      - risk_id: miro.read-board-content
        quota: 5000
        rate_limit: { max: 120, window_seconds: 60 }
        gate: auto

  - id: scribe
    label: Scribe
    description: Read the boards, then add and edit sticky notes, texts, cards, shapes, frames, connectors and tags. Never deletes anything.
    entries:
      - risk_id: miro.read-boards
        quota: 1000
        rate_limit: { max: 30, window_seconds: 60 }
        gate: auto
      - risk_id: miro.read-board-content
        quota: 5000
        rate_limit: { max: 120, window_seconds: 60 }
        gate: auto
      - risk_id: miro[staging].content-write
        quota: 2000
        rate_limit: { max: 60, window_seconds: 60 }
        gate: auto
      - risk_id: miro[prod].content-write
        quota: 1000
        rate_limit: { max: 30, window_seconds: 60 }
        gate: auto

  - id: facilitator
    label: Facilitator
    description: Run a workshop board end to end. Deleting on a production board, and deleting any frame, asks first.
    entries:
      - risk_id: miro.read-boards
        quota: 1000
        rate_limit: { max: 30, window_seconds: 60 }
        gate: auto
      - risk_id: miro.read-board-content
        quota: 5000
        rate_limit: { max: 120, window_seconds: 60 }
        gate: auto
      - risk_id: miro[staging].content-write
        quota: 2000
        rate_limit: { max: 60, window_seconds: 60 }
        gate: auto
      - risk_id: miro[prod].content-write
        quota: 1000
        rate_limit: { max: 30, window_seconds: 60 }
        gate: auto
      - risk_id: miro[staging].item-delete
        quota: 300
        rate_limit: { max: 20, window_seconds: 60 }
        gate: auto
      - risk_id: miro[prod].item-delete
        quota: 50
        rate_limit: { max: 5, window_seconds: 60 }
        gate: approval
      - risk_id: miro[staging].frame-delete
        quota: 10
        rate_limit: { max: 2, window_seconds: 60 }
        gate: approval
      - risk_id: miro[prod].frame-delete
        quota: 5
        rate_limit: { max: 1, window_seconds: 60 }
        gate: approval
```

**Why these five.** One decision per intent: _see the board_ (details, with
people's names), _see what is on it_, _change it_, _remove one thing_,
_remove a section_. Creating and editing share one risk because an edit can
empty an item as surely as a deletion and both are reversible by writing
again; splitting them would ask a person a question with no different
answer. Connectors and tags ride on the item risks: a connector or a tag is
a mark on the board like a sticky note (§5.5, §5.9). Frames get their own
deletion risk because one call can take away a section (§5.4).

**Deliberately in no preset:** the fallback only. `prod` frame deletion is
in `facilitator`, behind approval, because a facilitator tidies boards
after a workshop; a mission that should never do it drops it.

**Vectors.** `read-boards` is `pii` because the board object carries the
**names** of its owner, creator, last modifier and last opener
(`UserInfoShort`: `id`, `name`, `type`; no email anywhere in the Board
schema). Item reads carry only user **ids** (`createdBy`, `modifiedBy`:
`id`, `type`), so `read-board-content` is `data`. `content-write` is
`team` visibility (board members see it live); a board shared by public
link makes it wider, which the owner expresses by the `prod` label and
not by the catalog.

### Rate limits

Miro counts **credits per user per application**: a global
**100,000 credits a minute**, each call costing by level — Level 1 = 50
credits (2,000 calls a minute), Level 2 = 100 (1,000), Level 3 = 500
(200), Level 4 = 2,000 (50). Every answer carries `X-RateLimit-Limit`,
`X-RateLimit-Remaining`, `X-RateLimit-Reset`; past the limit Miro answers
`429` (`tooManyRequests`). Miro warns the limits are "subject to change at
any time without notice".

One connection is one token, hence one user × one app: **every mission on
the connection shares the 100,000 credits**. How the catalog respects it:

| Risk                 | Typical call cost (credits)                         | `calls_per_minute_max` | Credits / min at that ceiling |
| -------------------- | --------------------------------------------------- | ---------------------- | ----------------------------- |
| `read-boards`        | 50 (L1)                                             | 200                    | 10,000                        |
| `read-board-content` | 50–100 (L1 get, L2 list)                            | 300                    | ≤ 30,000                      |
| `content-write`      | 100 create; 150 update (L1 type check + L2 `PATCH`) | 200                    | ≤ 30,000                      |
| `item-delete`        | 550 (L1 type check + L3 `DELETE`)                   | 40                     | 22,000                        |
| `frame-delete`       | 550                                                 | 10                     | 5,500                         |

A single mission at every ceiling stays under 100,000 (≈ 97,500); the
presets sit far below (the `facilitator` maxima add up to ≈ 24,000
credits a minute). Several missions on one connection can still exhaust
it: `execute` makes **no retry**, a `429` is thrown as
`UpstreamHttpError(…, 429)` with `X-RateLimit-Reset` in the sentence the
agent reads.

## 4. Coverage

Every tool is covered by a named risk, none by the fallback.

| Tool(s)                                                                                     | Risk(s) touched                        |
| ------------------------------------------------------------------------------------------- | -------------------------------------- |
| `list_boards`, `get_board`                                                                  | `read-boards`                          |
| `list_items`, `get_item`, `list_connectors`, `get_connector`, `list_tags`, `list_item_tags` | `read-board-content`                   |
| `create_*` (sticky note, shape, text, card, frame, connector), `create_tag`                 | `content-write` (env)                  |
| `update_*` (sticky note, shape, text, card, frame, connector)                               | `content-write` (env)                  |
| `attach_tag`, `remove_tag`                                                                  | `content-write` (env)                  |
| `delete_sticky_note`, `delete_shape`, `delete_text`, `delete_card`, `delete_connector`      | `content-write` + `item-delete` (env)  |
| `delete_frame`                                                                              | `content-write` + `frame-delete` (env) |

`risksUntouched` over realistic samples: none.

## 5. Edge cases

### 5.1 The board id cannot be a slice identifier as Miro writes it

Miro board ids look like `uXjVOD6LSME=` (the documented example; the board
link is `https://miro.com/app/board/uXjVOD6LSME=`). The documentation gives
no grammar; the trailing `=` suggests base64 padding ⚠. A slice identifier
holds `[a-zA-Z0-9_./~-]` only, so `=` cannot be carried, and the SDK's
answer, `identSegment`, would write the board as `[*]`.

`[*]` keeps the risk decision right (every pattern above uses `board[**]`
or `board[*]`) but breaks the environment: the default resolver finds the
board's label by comparing the slice's identifiers with the resources'
refs (`resourceEnvResolver`, `packages/policy-engine/src/qualify.ts`). With
`board[*]` it finds none, and falls back to the label only when the mission
holds **exactly one** Miro board. A mission on two boards would see every
write refused (every write risk is env-scoped). That is fail-closed, but
it makes multi-board missions useless.

**Proposed: the ref is a slice-safe spelling of the board id**, bijective
by grammar:

- the Miro board id grammar `MIRO_BOARD_ID = ^[A-Za-z0-9_-]{1,62}={0,2}$`
  (letters, digits, `_`, `-`, then at most two `=` at the end; no `~`, no
  `+`, no `/`, no `.`);
- the ref is that id with each trailing `=` written `~`
  (`uXjVOD6LSME~`), grammar `BOARD_REF = ^[A-Za-z0-9_-]{1,62}~{0,2}$`;
- one function per direction (`boardRefOf(miroId)`, `miroIdOf(ref)`), each
  returning `null` outside its grammar; `~` cannot occur in a Miro id
  accepted by the grammar, so the mapping is one to one.

The tools take the **ref** (what `list_boards` and the mission show), the
slice carries it as is (`miro.board[uXjVOD6LSME~]…`), the owner sees and
labels it, and `execute` turns it back into the Miro id for the URL. An
agent that passes the Miro spelling (`uXjVOD6LSME=`, copied from a board
link) is refused with a sentence naming the ref to use; it is not
converted (refuse, never repair). This departs from the kit's "use the
provider's id" by spelling, not by value, and is Open question 1 (an ADR
if accepted). The two alternatives: `identSegment` and one board per
mission (no new rule, multi-board missions cannot write), or widening the
slice grammar with `=` (a spec change, out of a plugin's reach).

A board id outside `MIRO_BOARD_ID` at discovery (a `/`, a `+`, a `~`, an
inner `=`) is **left out of the resources** with a logger warning naming
how many were skipped, rather than failing the discovery. One unusual board
should not make a team unconnectable; a board that is not offered cannot be
selected, so nothing is widened (Open question 7).

### 5.2 Item ids, and the item type behind a typed tool

Item, frame, connector and tag ids are numeric strings in every example
(`3458764517517819000`, `3074457363306854000`) ⚠. Grammar `MIRO_ITEM_ID =
^[0-9]{1,24}$`: safe for a path segment and a slice identifier.

Miro's items share one id space, and the classifier cannot know whether
`item_id` names a sticky note or a frame (no network). The model relies on
the **typed endpoints** (`DELETE /sticky_notes/{id}`, `DELETE
/frames/{id}`), and does not trust that a typed endpoint refuses an item of
another type (not stated ⚠). Before every `update_*` and `delete_*` (frames
included) `execute` reads `GET /v2/boards/{board}/items/{id}` and declines
(`ExecutorRefusal`) when the answer's `type` is not the tool's (`sticky_note`,
`shape`, `text`, `card`, `frame`), or carries no type. So
`delete_sticky_note` on a frame's id never deletes a frame under
`item-delete`. The read costs one Level 1 call (50 credits), already in
§3's table. **No generic `delete_item` or `update_item`** is offered
(`DELETE /items/{id}`, `PATCH /items/{id}` exist): a generic deletion
cannot be priced without knowing the type.

### 5.3 Moving an item: parent frame, never another board

The write tools take `parent_frame_id`: an item id (`MIRO_ITEM_ID`), or
`null` to "directly attach an item to the canvas". The URL names one board,
and Miro describes the parent as a frame of that board; **no endpoint used
moves an item to another board**. A move into or out of a frame is an
ordinary `content-write` on the item; it emits **no** slice on the frame,
because the frame's own content (title, geometry) is unchanged and the move
is undone by moving back. A frame holds at most 5000 items (Miro's limit,
answered by Miro). `create_frame` and `update_frame` take no parent (the
frame request schema has none).

### 5.4 Deleting a frame

Miro's reference says only "Deletes a frame from a board"; the frame and
parent/child pages say nothing about the children ⚠. The catalog assumes
the worst: `frame-delete` is `irreversible` and `bulk`, gated by approval
in every preset that has it. If a test on a scratch board shows the
children survive (moved to the canvas), the vector drops to `costly` /
`single` in a later catalog version — never the other way without notice.
Whether moving or resizing a frame carries its children is not stated
either ⚠; `update_frame` stays a `content-write`, reversible by moving it
back.

### 5.5 Connectors

A connector "connects two items via a start item and an end item", and
"the connector line is automatically removed if you remove either the
start item or the end item". So:

- creating or updating a connector changes neither item: one slice on the
  connector (`connector.W` / `connector[C].W`). `start_item_id` and
  `end_item_id` are read with `MIRO_ITEM_ID` (they travel in the JSON
  body, never the path) and must differ;
- an `update_connector` may re-point either end (`startItem`, `endItem`
  are optional fields of the `PATCH`): still one connector write;
- deleting an **item** silently deletes its connectors. `item-delete`'s
  reason says so; no extra slice is emitted, because the classifier cannot
  know which connectors exist, and the effect is the same kind (a line
  between two items goes, reversible by drawing it again);
- whether the two ends must be on the same board is not stated ⚠: the
  path names one board, and an id of another board would be answered by
  Miro, not by the gateway.

### 5.6 Bulk creation left out

`POST /items/bulk` creates up to 20 items "in any mix of types",
transactionally ("none of the items will be created" on one failure), at
Level 2 per item. Left out of v0.1 because a mission's quota counts
**calls**: one bulk call would create 20 items for one unit of
`content-write`, and its body mixes types (frames included) that would
each need a slice. If wanted, it comes as `create_items` with one slice
per element and a dedicated `bulk-item-create` risk (Open question 4).

### 5.7 Reading and personal data

- `GET /v2/boards` and `GET /v2/boards/{id}`: `owner`, `createdBy`,
  `modifiedBy`, `lastOpenedBy` carry `id`, `name`, `type`;
  `currentUserMembership` carries `id`, `name`, `role`. **No email** in any
  board schema. Names are personal data: `read-boards` is `pii`, and the
  result is passed as Miro returns it (Open question 6 on stripping names).
- Item, connector and tag reads: `createdBy` / `modifiedBy` are `id` and
  `type` only. A card's `assigneeId` is a user id.
- Board members (`/v2/boards/{id}/members`) are not called by any tool.
- **Board content is attacker-influenced**: anyone with edit access writes
  sticky notes the agent reads. The reason of `read-board-content` says
  so; nothing in the gateway sanitises it.

### 5.8 Cards: no assignee in v0.1

`create_card` / `update_card` do not allow `assigneeId` in their `data`
allowlist. Assigning a card to a person writes a user id the agent would
have to find elsewhere (board members are out of scope), and Miro may
notify the assignee ⚠. `title`, `description` and `dueDate` are allowed
(Open question 8).

### 5.9 Tags: why in, and which part

In, because a facilitator sorts sticky notes by tag and the endpoints are
plain: `POST /tags`, attach `POST /items/{item_id}?tag_id=…`, remove
`DELETE /items/{item_id}?tag_id=…` ("the tag still exists on the board").
They are `content-write`: a tag on a card is a mark on the board, removed
as easily as it is added.

Out of v0.1: **`update_tag` and `delete_tag`**. Deleting a tag removes it
"from all cards and sticky notes on the board", and renaming it changes it
on all of them: a board-wide effect from one call, which would deserve its
own risk for a small gain. Tag changes "will not be reflected on the board
in realtime" (viewers refresh), which is Miro's behaviour, not a risk.
`tag_id` travels in the query string (`URLSearchParams`), read with
`MIRO_ITEM_ID`; it is in the slice as `tag-link[T]`.

### 5.10 Pagination and ceilings

- Items and connectors: cursor pagination, `limit` 10–50 (default 10),
  `cursor` from the previous answer. One tool call is one page; the agent
  passes `cursor` back. `cursor` is an opaque string (example
  `MzQ1ODc2NDUyMjQ5MDA4Mjg5NX4=`) sent in the query only, bounded to 512
  characters, never in a path or a slice.
- Tags: offset pagination, `limit` 1–50 (default 20).
- Boards: offset pagination, `limit` up to 50 (used by discovery only).
- `list_boards` makes **no listing call**: it answers from the mission's
  boards, one `GET /v2/boards/{id}` each (Level 1), so a mission never
  learns the names of boards it was not given. At most 50 boards per
  mission are read (`MAX_LISTED_BOARDS`); more is declined.

### 5.11 What a token reaches, and discovery

`GET /v2/boards` returns "boards accessible to the user associated with
the provided access token". A token is created by installing the app on
**one team** (the token context, `GET /v1/oauth-token`, names one `team`);
whether it reaches boards of the user's other teams is not stated ⚠.
Discovery therefore asks for the installed team only: `team_id` from the
token context, which also makes new boards appear immediately (other
filters "allow a few seconds for indexing"). An Enterprise Content Admin
token can list private boards whose content stays refused: such a board is
discovered, and its content calls answer an error, thrown as Miro's status.

### 5.12 Deletion as a verb leaf

`delete_*` emit `…[id].delete.W`, never `…[id].W`, so that `item-delete`
and `frame-delete` are decisions of their own. Because `content-write`'s
patterns are recursive, a deletion touches it too (§3, layering).

## 6. Credential, discovery, execution, tests

### 6.1 Credential (**PO**: `api-key`, token first)

One `api-key` spec, no alternative, no company app in v0.1 (ADR
[`company-apps-kept-where-they-add-something`](../../decisions/company-apps-kept-where-they-add-something.md),
D2 "token first";
[`token-connections-beside-the-integration-app`](../../decisions/token-connections-beside-the-integration-app.md)
D1 for `label`, `guide`, `verify`).

**How a person gets a token without the gateway running OAuth** (Miro's
REST quickstart: "Install app and get OAuth token"):

1. In Miro: avatar → Settings → Your apps → **Create new app** (needs a
   Developer team; Miro's Developer team is a sandbox limited to 3 boards
   and 5 collaborators).
2. **Leave "Expire user authorization token" unchecked.** This cannot be
   changed after the app is created.
3. Give the app the scopes **`boards:read`** and **`boards:write`** only.
4. **Install app and get OAuth token**, choose the team that holds the
   boards, authorise, copy the access token.

**Scopes.** The REST scopes are `boards:read` ("retrieve information about
boards, board members, or items") and `boards:write` ("create, update, or
delete boards, board members, or items"); there is **no item-only scope**.
The token itself can therefore delete boards and manage members; the
gateway refuses it because no tool does it, which is the reason the `help`
text says so. (The quickstart writes `board:read`; the scopes reference
writes `boards:read`, used here ⚠.)

**Expiry, settled.**

| App setting        | Access token     | Refresh                                                               | Viable as `api-key`? |
| ------------------ | ---------------- | --------------------------------------------------------------------- | -------------------- |
| Expiring (checked) | 1 hour           | refresh token 60 days, rotated on each refresh; needs `client_secret` | **No**               |
| Non-expiring       | no expiry stated | none                                                                  | **Yes**              |

The refresh grant is `POST https://api.miro.com/v1/oauth/token` with
`grant_type=refresh_token`, `client_id`, `client_secret`, `refresh_token`;
an `api-key` connection holds none of the app's secrets, and the gateway's
standard refresh belongs to `oauth2`. A person who checked the box gets a
connection that works for one hour and then turns "Needs reconnecting".
`verify` cannot tell the two apart from the token context ⚠ (no expiry
field is documented there), so the guide insists on step 2.

- `label`: "access token of a Miro app".
- Field `access_token`: `secret: true`, required, `pattern`
  `^[A-Za-z0-9._~+/=-]{20,512}$` — loose on purpose: Miro documents no
  token format ⚠; `verify` is the real check.
- `createUrl`: Miro's "Your apps" settings page ⚠ (exact URL to confirm).
- `verify(ctx)`: `GET https://api.miro.com/v1/oauth-token` (token
  context: `type`, `team`, `organization`, `scopes`, `user`, `createdBy`).
  `account` = "`<team name>` (Miro team)"; refuses the token
  (`UpstreamAuthError`) when the answer is a 400 ("invalid token") or
  401, and declines with a sentence when `scopes` lack `boards:read` or
  `boards:write`; `expiresAt` = `null`. `team.id` goes to the connection
  metadata (`team_id`, grammar `MIRO_ITEM_ID`) for discovery.
- `guide`: the four steps above; permissions `boards:read` (read) → the
  eight read tools, `boards:write` (read-write) → the 21 write tools;
  `recommendedExpiryDays`: `null`; `docsUrl`: Miro's REST quickstart.
- `help`: "Create a Miro app with only boards:read and boards:write, leave
  'Expire user authorization token' unchecked, and install it on the one
  team whose boards the agents may work on. The token can do everything
  those scopes allow on every board of that team, including deleting
  boards; the gateway limits what agents do with it, not the token itself."
- `manualRevocation`: "In Miro, open Settings → Your apps and delete the
  app, or uninstall it from the team; its token stops working." ⚠ (menu
  path to confirm). No declarative `revocation`: Miro's
  `POST /v2/oauth/revoke` needs `clientId` and `clientSecret`, which an
  `api-key` connection does not hold.

Rejected for v0.1: an `oauth2` company app (one app per instance,
expiring tokens refreshed by the gateway). It adds short-lived tokens, at
the cost of an app registration per instance; Open question 2.

### 6.2 Discovery

`discoverResources(ctx)`: `GET /v2/boards?team_id=<team_id>&limit=50&offset=N`
(Level 1), following `offset` until a page shorter than 50, `total`, or
`MAX_DISCOVERED_BOARDS` = 500 (logger warning when reached). The answer is
checked with a type guard (`data` a list of objects with string `id` and
`name`); a payload it does not recognise fails discovery. Each board:
`ref` = `boardRefOf(id)` (§5.1; outside the grammar → skipped with a
warning), `displayName` = `name`, `metadata` = `{ team_id, view_link }`
(`viewLink` kept only when it starts with `https://miro.com/app/board/`).
No `env`: the owner labels.

### 6.3 Execution

- Base `https://api.miro.com/v2` (constant), `Authorization: Bearer
<access_token>` (`expectCredentialKind(…, 'api-key')`), JSON bodies.
- The board in the URL is `encodeURIComponent(miroIdOf(ref))` of the
  board the classifier resolved (`resolveBoard`, shared); item ids are
  `MIRO_ITEM_ID` and go in as they are; `tag_id`, `cursor`, `limit`,
  `offset`, `type`, `parent_item_id` go through `URLSearchParams`.
- Bodies are built field by field: the four allowlisted objects (§2), the
  `parent: { id }` from `parent_frame_id`, the connector's
  `startItem` / `endItem` from the two ids and their `snapTo`.
- The type check before `update_*` / `delete_*` (§5.2).
- A `DELETE` answers 204: the executor returns its own confirmation.
- Failures thrown: 401 → `UpstreamAuthError` (the gateway then marks the
  connection expired); 403 (`insufficientPermissions`, a missing scope) →
  `UpstreamAuthError(…, 403)`, a failed call that changes nothing; any
  other failed status (Miro answers **404 for "invalid access"** on
  writes, 400 for a malformed body, 429) → `UpstreamHttpError`. Declined
  calls (`ExecutorRefusal` under `declining`): unknown tool, unresolved
  board, malformed id, undeclared argument or nested key, a type check
  that fails.

### Identifiers

| Value                                                               | Grammar                                         | Where it lands                                                  | Outside the grammar                               |
| ------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------- |
| `board` argument, board resource ref                                | `BOARD_REF` — `^[A-Za-z0-9_-]{1,62}~{0,2}$`     | slice `board[B]`; turned into the Miro id for the URL           | `denied` / declined: `board: malformed board ref` |
| Miro board id (discovery answer, `miroIdOf(ref)`)                   | `MIRO_BOARD_ID` — `^[A-Za-z0-9_-]{1,62}={0,2}$` | URL path `/boards/<id>`, percent-encoded (`=` → `%3D`)          | board left out of discovery; never sent           |
| `item_id`, `frame_id`, `connector_id`                               | `MIRO_ITEM_ID` — `^[0-9]{1,24}$`                | URL path segment; slice `item[I]` / `frame[F]` / `connector[C]` | `denied` / declined: `<arg>: malformed id`        |
| `tag_id`                                                            | `MIRO_ITEM_ID`                                  | query string (`tag_id=`); slice `tag-link[T]`                   | `denied` / declined                               |
| `start_item_id`, `end_item_id`, `parent_frame_id` (or `null`)       | `MIRO_ITEM_ID`                                  | JSON body only                                                  | `denied` / declined                               |
| `team_id` (connection metadata)                                     | `MIRO_ITEM_ID`                                  | query string of discovery only                                  | discovery fails                                   |
| `cursor`                                                            | printable ASCII, 1–512, no whitespace           | query string only                                               | `denied`                                          |
| `data`, `style`, `position`, `geometry` values; `title`, `captions` | none — never an identifier                      | JSON body                                                       | keys outside the allowlist `denied`               |

One grammar function per kind, shared by `classify` and `execute` (ADR
[`plugin-identifiers-one-grammar-for-classify-and-execute`](../../decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md)).
`..`, `.`, `%2e%2e`, `%2f`, a line break, `?x=1#y` fail every grammar.

### 6.4 Tests (planned)

- `plugin.test.ts`: the SDK kit (`assertPluginWellFormed`,
  `assertPresetsValid`, `assertNoWildcard`, `assertCatalogCoverage` with
  one sample per tool, `fallbackHits` empty, `risksUntouched` empty), and
  `assertIdentifiersRefused` on the same samples. The board travels as
  `%3D`-encoded Miro id, not as the sample's ref, so the board is given to
  the kit through `routes`; item ids are found as path identifiers.
- `classify.test.ts`: every branch (board resolution, each grammar, equal
  connector ends, limits, nested keys, undeclared arguments).
- `risk-catalog.test.ts`: the exact risks each tool touches; deletions
  touch `content-write` + their delete risk; a write on an unlabelled board
  is refused, on two labelled boards in one mission resolves each label
  (the reason of §5.1).
- `identifiers.test.ts`: `boardRefOf` / `miroIdOf` round trip, hostile
  values to `classify` and `execute`, no request sent on a refusal.
- `execute.test.ts` against `mockFetch`: request shapes, the type check
  (a frame id given to `delete_sticky_note` sends no `DELETE`), 204
  handling, 401 / 403 / 404 / 429; discovery paging, ceiling, skipped
  board ids, refused payload; `verify` on missing scopes.

## Sources

**Context7 exception.** The project rule is Context7 for provider
documentation. On 2026-10-16 every Context7 call
(`resolve-library-id` "Miro REST API", "Miro"; `query-docs`
`/websites/developers_miro`), including a retry after the coordinator
reported a new API key, answered _"Monthly quota exceeded"_. **No fact on
this page comes from Context7.** The product owner authorised, as a
one-off exception, WebFetch restricted to developers.miro.com (and
help.miro.com only if the developer docs pointed there for token setup;
they did not, so help.miro.com was not used). Every page below was read
with WebFetch on 2026-10-16.

| Fact                                                                              | Page                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page index                                                                        | https://developers.miro.com/llms.txt                                                                                                                                                                                      |
| Token setup without OAuth, expiring vs non-expiring, "fine for test applications" | https://developers.miro.com/docs/rest-api-build-your-first-hello-world-app (and `.md`)                                                                                                                                    |
| Choice fixed at app creation, 1 h / 60 days, rotation                             | https://developers.miro.com/reference/authorization-flow-for-expiring-access-tokens, https://developers.miro.com/reference/authorization-flow-for-expiring-tokens                                                         |
| Refresh grant, token and authorize endpoints                                      | https://developers.miro.com/docs/getting-started-with-oauth                                                                                                                                                               |
| 4XX on invalid token, 403 `insufficientPermissions`                               | https://developers.miro.com/docs/troubleshooting-oauth20.md                                                                                                                                                               |
| Scopes                                                                            | https://developers.miro.com/reference/scopes                                                                                                                                                                              |
| Token context                                                                     | https://developers.miro.com/reference/get-access-token-context                                                                                                                                                            |
| Revoke endpoint                                                                   | https://developers.miro.com/reference/revoke-token-v2.md                                                                                                                                                                  |
| Developer team limits, sharing an app with another team                           | https://developers.miro.com/docs/developer-team.md, https://developers.miro.com/docs/share-an-app-outside-of-a-developer-team.md                                                                                          |
| Rate limits (credits, levels, headers, 429)                                       | https://developers.miro.com/reference/rate-limiting                                                                                                                                                                       |
| Boards list and board object (ids, names, no email, pagination)                   | https://developers.miro.com/reference/get-boards-1.md, https://developers.miro.com/reference/get-specific-board-1.md                                                                                                      |
| Items list / get, item ids, cursor                                                | https://developers.miro.com/reference/get-items-1.md, https://developers.miro.com/reference/get-specific-item-1.md, https://developers.miro.com/reference/get-items-within-frame.md                                       |
| Generic delete, position / parent update                                          | https://developers.miro.com/reference/delete-item-1.md, https://developers.miro.com/reference/update-item-position-or-parent-1.md                                                                                         |
| Sticky notes, shapes, texts, cards                                                | https://developers.miro.com/reference/create-sticky-note-item-1.md, …/update-sticky-note-item-1.md, …/delete-sticky-note-item-1.md, …/create-shape-item-1.md, …/create-text-item-1.md, …/create-card-item-1.md            |
| Frames                                                                            | https://developers.miro.com/reference/create-frame-item.md, …/update-frame-item.md, …/delete-frame-item.md, https://developers.miro.com/docs/frame-1.md, https://developers.miro.com/docs/children-inside-parent-items.md |
| Connectors                                                                        | https://developers.miro.com/reference/create-connector-1.md, …/update-connector-1.md, …/get-connectors-1.md, https://developers.miro.com/docs/connector_intro.md                                                          |
| Tags                                                                              | https://developers.miro.com/docs/tag-concepts.md, https://developers.miro.com/reference/create-tag.md, …/get-tags-from-board.md, …/attach-tag-to-item.md, …/remove-tag-from-item.md, …/delete-tag.md                      |
| Bulk creation                                                                     | https://developers.miro.com/reference/create-items.md                                                                                                                                                                     |
| Miro's own MCP server (OAuth 2.1, not used)                                       | https://developers.miro.com/docs/miro-mcp.md                                                                                                                                                                              |

Unanswered by these pages (⚠ above): what happens to a frame's children
on deletion or move; whether typed endpoints refuse another item type;
the board-id and token alphabets; whether a token reaches boards outside
its team; the exact settings URL; whether a card assignee is notified.

## Open questions

1. **Board ref spelling (§5.1).** Accept a ref that writes the board id's
   trailing `=` as `~` (multi-board missions work, one new rule, an ADR), or
   keep the Miro id and `identSegment` (no new rule, but a mission that
   writes must hold a single board)? Recommendation: the `~` ref.
2. **Non-expiring tokens.** `api-key` works only with them. Accept that
   dependency for v0.1 and add an `oauth2` company app (expiring, refreshed
   by the gateway) only if Miro deprecates them, or plan the second way now?
3. **Which team to install on.** The quickstart installs on the Developer
   team (3 boards); a company's boards live on its real team. Confirm on a
   real account that "Install app and get OAuth token" offers that team,
   or document the app's installation URL ("Share app") as step 4.
4. **Bulk creation (§5.6).** Out of v0.1, or in with a dedicated
   `bulk-item-create` risk?
5. **Environment labels.** `[staging, prod]` as Notion's draft, or Miro
   wording (`sandbox`, `client`)? A label outside the list makes writes
   refused.
6. **Names in board reads (§5.7).** Pass them (useful to an agent asked "who
   owns this board"), as proposed, or strip `name` from user objects and
   make `read-boards` `metadata`?
7. **A board id outside the grammar at discovery.** Skip it with a warning
   (proposed) or fail the discovery as the template does?
8. **Card assignee (§5.8).** Leave `assigneeId` out of v0.1, as proposed?
9. **Tag update and deletion (§5.9).** Out of v0.1, as proposed, or in with
   a `tag-delete` risk (board-wide)?
10. **Frame deletion check.** Allow a test on a scratch board to settle
    whether children are deleted, before the catalog is final?
