---
title: The risk model is explained inside the interface — a generated provider reference, and Preset or Custom per connection
status: accepted
date: 2026-10-13
extends:
  - plugin-contract-and-credential-spec
  - pivot-v4-to-v5-on-prem-mission-tokens
---

# The risk model is explained inside the interface — a generated provider reference, and Preset or Custom per connection

## Context

The first hands-on test of the v5 interface by the product owner came back
with three findings: the documentation that explained each plugin's risk model
was gone (the v4 provider pages were deleted with the v4 application); a preset
was a `<select>` and one truncated line, so it could be chosen but not
understood; and the granular editor, although present, was a collapsed section
titled "unfold only to adjust", which read as absent. The same owner had asked
earlier for a screen that is "simple and practical", and spec §4.2 requires
the creation screen to stay usable on three connections "without scrolling
through a wall of checkboxes".

Both demands hold. The earlier implementation had answered the second one
alone, by folding everything.

Constraints that do not move: the persisted policy is the explicit list
`RiskId → (quota, rate limit, gate)`, never a preset reference and never a
wildcard (spec §3.2); issuance is re-checked server-side and that check is the
authority; the provider list has one source, the plugin registry; no new
interface dependency.

## Decision

**D1 — A provider reference, generated from the registry.** `/providers` and
`/providers/<id>` are projections of the registered plugins
(`server/providers/reference.ts`): descriptor, data model, catalog, presets,
tools. No page is written per provider. Any signed-in principal reads them.
Every catalog entry and every preset has a stable anchor (`#risk-<id>`,
`#preset-<id>`), built in one file (`server/providers/links.ts`), and every
risk id the interface prints links to its entry.

**D2 — The plugin descriptor gains an optional `summary`.** The existing
`description` is one line naming what the plugin reaches; it does not say what
a connection is, what a resource is, or where the environment of a call comes
from, which is what a reader needs before the data model. `summary` is that
paragraph (at most 600 characters). It is additive and optional in the SDK
contract; a structural test requires it of the shipped plugins.

**D3 — What cannot be derived is said, not guessed.** A plugin classifies a
call from its arguments and declares no static tool-to-risk table. The
reference therefore prints "depends on the arguments" for every tool and
points to the catalog. A pattern's "plain words" are a mechanical reading of
the pattern (`describePattern`), and the scale of each vector axis is shown as
the catalog's values with the question the risk-model spec gives for the axis:
no meaning is added that the plugin did not declare.

The one static statement a plugin does make is `tokenHandouts`, added with
this decision: the tools whose purpose is to hand the agent a short-lived
provider token (spec §2.4), with the risks such a call touches. It exists so
that the exception to "the executor never sees a provider credential" is
marked on the page from the plugin's own declaration rather than from a list
of tool names in the host. The reference marks those tools and risks "hands a
token to the agent"; the host decides nothing from the field.

**D4 — Preset or Custom, per connection, as a mode of the screen.** Each
included connection has a visible switch. _Preset_ is an explicit choice among
the plugin's presets, with the reading of the chosen one on the page
(`explainPreset`: allowed without asking, under approval, not included, left
out here). _Custom_ is the granular editor in place: every explicit id of the
catalog, grouped into reads, writes and irreversible writes, with "start from
preset", search and filter. Entering Custom keeps the preset's values; leaving
it after an edit asks first. The mode is never sent: the draft is the same
explicit list in both.

**D5 — One reading spread out at a time.** With every preset's lists spread
out, a mission on three connections measures a little over three viewports at
1280×800 (37 accepted risks to print). The screen therefore spreads out the
reading of the preset just picked and keeps the others as their full
description and their counts ("8 allowed without asking · 2 need your approval
· 5 not included"), each with a button that spreads it out again; the creator
may keep several open. "Not included" is a count whose names unfold in place.
That state measures 2.1 viewports, which the browser test bounds at 2.25.

**D6 — One component explains a risk.** `RiskExplain` (label, reason, the six
vector badges, markers, linked id) is used by the Custom editor, the Share
dialog, the mission page and the reference. A badge reads `Axis: value`; its
tone follows the position of the value on its scale, and the text always
carries the value. `CatalogRisk` gains `vector` and `kind` for it; `kind`
(read, write, destructive) is derived from the entry's patterns and from the
`reversibility` axis, and only groups a list.

**D7 — The Share dialog's checklist is open.** The dialog is a page whose
purpose is that checklist; folding it hid the one thing the owner came to
read.

## Consequences

- A plugin added to the registry is documented in the interface with no
  further work, and a catalog change shows on the next deploy. The reference
  cannot drift from what the gateway enforces, because it is read from the
  same objects.
- The reference documents the catalog, not the handbook of the plugin: the
  maintainer's reasoning (edge cases, tools deliberately left out) stays in
  `docs/handbook/providers/`, linked through `docsUrl`.
- "Which risks does this tool touch" has no static answer in the interface,
  except for the tools a plugin lists in `tokenHandouts`. Giving one would
  need a declaration per tool in the plugin contract, checked against the
  classifier by the plugin's tests — the same declaration spec §11.2 names as
  the condition for filtering `tools/list` per tool.
- The creation screen is longer than before in its default state (2.1
  viewports against 1.3 for three connections), and a creator who wants every
  preset spread out at once clicks once per connection.
- `CatalogRisk` is larger (a vector and a kind per row) in the issuance
  context sent to the creation form. The management door's wire shape is
  mapped field by field (`management/views.ts`) and does not change.
- The pages of the interface that list risks depend on
  `server/providers/links.ts`; renaming an anchor is a change in one place.

## Rejected alternatives

- **Hand-written pages per provider**, as in v4. They were the documentation
  that disappeared; they drift from the catalog and a new plugin ships without
  one.
- **Linking out to the repository handbooks.** An on-prem instance may run a
  version whose handbook is not the one on the default branch, and the owner
  asked for the explanation where the decision is taken.
- **Every preset's lists spread out at all times.** Measured at 3.1 viewports
  for three connections; it contradicts spec §4.2 and the "not a gas factory"
  demand. Kept reachable in one click per connection.
- **A preset select with a one-line summary** (the previous screen, improved).
  A select shows one option at a time and hides the alternatives; the width of
  each preset next to its radio is what lets a creator compare.
- **A preset reference persisted on the mission**, so that the mission page
  could say "Developer". Refused by spec §3.2: a preset changed in a later
  plugin version must not alter an existing mission.
- **Deriving tool → risks by classifying sample arguments at page render.**
  The samples would be invented by the host, and a wrong table in a security
  reference is worse than none.
- **Per-value definitions of the vector axes** ("account: the whole account").
  The risk-model spec defines the question of each axis and the order of its
  values, not a sentence per value; writing them in the interface would create
  a second, unreviewed specification.
- **A tabs or segmented-control primitive** for the mode switch. The style
  guide provides neither; two native radios in a group need no new primitive
  and are keyboard-reachable as they are.
