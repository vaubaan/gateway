---
title: The risk model is explained inside the interface — a generated provider reference, and Preset or Custom per connection
status: accepted
date: 2026-10-13
amended: 2026-10-13
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

## Amendment — 2026-10-13: one component per kind of object, order by need, type colours

### Context

The reference of D1 shipped as one long column in which the explanation, the
data model, each of fifteen risks, each preset and the tools were the same grey
card. The product owner's verdict: he finally saw the model and the risks, and
the page was "unreadable and indigestible" — the kinds of card could not be
told apart, the how-tos were always unfolded, the presets came at the very
bottom, and nothing distinguished a risk id from a tool name. He asked, in
turn, for help that stays folded, for the planes of a data model as a way to
slice the page, for the presets near the top and compared side by side, and for
a colour per kind of item, consistent between a card and the slug that names
it. D1 to D7 stand, except where a line below says so.

### Decision

**A1 — The sections of a provider page are tabs, in the order a reader needs
them.** Presets, Risks, Data model, Tools; one section in view at a time, the
tabs sticky. The header (name, the plugin's summary, three facts) is the
overview and is always visible, so there is no "Overview" tab. Presets are the
default tab: they are the ready-made answers a reader came for; the risks are
what they are made of; the data model and the tools are reference material.

**A2 — Presets are compared in one matrix.** A column per preset, a row per
catalog entry grouped by class, a cell per budget (quota, rate limit, gate; one
line per environment for an env-scoped risk), an empty cell for a risk left
out. It replaces one table per preset followed by a "not included" list: the
difference between two presets is read along a row. It fits at 1280 px for
three presets and twenty-five risks (Supabase), which is the largest shipped
catalog. A risk row names the presets that include it, and a preset cell leads
to its risk: one moves both ways without scrolling.

**A3 — A provider with several planes is sliced by plane, across sections.**
The plane control sits under the tabs and applies to all of them; "All" is the
default; a provider with one plane shows no control. The plane was made a
filter over the sections rather than the primary axis: the sections answer
"what do I want to know", the plane "about which part", and a reader of GitHub
(one plane) must not meet an empty level. The plane of a risk is read from its
pattern and the plane of a tool from its name, under the rule of D3: what
cannot be read is filed under "other", not guessed (`server/providers/planes.ts`).

**A4 — D6 is amended: one component still explains a risk, as a compact row.**
The six worded badges (`Axis: value`) become a six-cell strip: the axis in a
few letters over its value, neutral at the mildest value, a status tone above
it. The value stays written in every cell, each cell names its axis in full to
assistive technology and on hover, and the whole profile is spelled out on
hover and on keyboard focus. The reason is one line that unfolds. In the
reference, patterns, per-environment profiles and notes are behind the row's
own disclosure.

**A5 — Help is on demand.** Every explanatory block is one line at most and a
button; the rest is closed by default and its state is remembered per browser.
This extends D5's reasoning ("one reading spread out at a time") from the
preset lists to the prose. D7 stands: the Share dialog's checklist stays open;
only its helper paragraph folds.

**A6 — A type colour system, separate from the status colours.** One hue and
one glyph per kind of object the interface names — risk, preset, tool, plane or
entity, resource, connection, mission, member, token — carried by the row or column of
that kind and by every reference to it (`Slug`). The hue says what kind of
thing a name is and never its state: severity, class, gate and status keep the
four status accents and their own forms. The nine hues are new primitive
families chosen between the four status hues; a kind is also said by its glyph
and a hidden word, never by the colour alone.

**A7 — Three primitives the style guide lists as "not provided" are added:
tabs, a glyph set, a callout** (plus `Slug` and `Help`). The rejected
alternative "a tabs primitive for the mode switch" of this ADR stands for the
mode switch, which stays two native radios; tabs are introduced for the
sections of a page, which is what the pattern is for. The plane control and
the mode switch are native radios. The glyphs are a dozen line drawings kept in
one file, not an icon package: no new dependency.

**A8 — The application bar is one line.** Labels are one short word ("Shares",
"Admin"), the current section is marked, and the account is one button with the
role and "Sign out" behind it.

### Consequences

- A provider page opens on about one viewport of header and matrix instead of
  six viewports of cards; a `#risk-<id>` link now changes the tab and possibly
  the plane before it scrolls, which needs the browser: without scripts the
  page shows the Presets tab only.
- The reference body is a client component fed with the whole projection of
  the plugin (the Supabase one is the largest); nothing is fetched after the
  page loads.
- The tools table still does not say whether a tool reads or writes, and the
  outline does not mark "the resource level": a plugin declares neither.
  Showing them would be a guess; both need a declaration in the plugin
  contract.
- Filing a tool under a plane by its name is weaker than filing a risk by its
  pattern. On Supabase 34 of 44 tools get a plane; the ten others are under
  "other". A declaration of the plane per tool in the plugin contract would
  remove the rule.
- `docs/spec/style-guide.md` no longer describes the interface on five points:
  the type hues and their tokens, the `--text-2xs` step, the primitives of
  A7, reduced motion (now handled), and the use of the base surface for
  content. They are listed for the spec's owner; the handbook
  ([web-app](../handbook/web-app.md)) documents what the code does.
- The word that names the kind to assistive technology is generated content of
  the slug, not text: the text of a cell that prints an id stays the bare id,
  for a browser test as for a copy and paste.
- The holder of a member token is a person and takes the member colour; the
  holder of a named token is a name and takes the token colour. "Token holder"
  is therefore not a colour of its own: it is one of the two.

### Rejected alternatives

- **The plane as the primary axis, sections under it.** Four planes times four
  sections hides the comparison of presets, which spans planes, and gives the
  nine single-plane providers a useless level.
- **Stacked preset tables kept as the main view.** It is what the owner called
  confusing: three tables each followed by a list of what is missing, where
  the question is what differs.
- **Colour by class of risk on the rail** (read, write, irreversible), as first
  planned. The rail is the identity of the row — a risk — and the class is its
  state-like attribute: mixing the two on one channel is what the type colour
  system forbids. The class is the group title, and an outlined word where a
  list is not grouped by it.
- **An icon package.** A dependency for twenty glyphs, against "no new
  interface dependency".
- **Hover-only tooltips for the full axis names.** Unreachable by keyboard and
  by touch; the names are in the legend, in each cell's label, and shown on
  focus.
- **Guessing the plane of a tool by classifying sample arguments**, or its
  read/write nature from its verb: the same reason as in D3.
