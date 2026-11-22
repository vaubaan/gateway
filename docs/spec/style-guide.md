---
title: Style guide — the attention budget, tokens and components
status: stable
---

# Style guide — spec

> **Status:** stable. The visual and verbal rules of the web interface
> ([vaubaan-gateway](./vaubaan-gateway.md) §4.2). Decision:
> [interface-redesign-vocabulary-and-design-system](../decisions/interface-redesign-vocabulary-and-design-system.md).
> Build: handbook [web-app](../handbook/web-app.md); every component in every state and both themes:
> the gallery page `/design` of a running gateway.
>
> **Stance.** A quiet control room: what waits for the person, answerable where they see it, and
> what is running. A page shows the exception, not the rule.

## 0. Vocabulary

- **Token** — a named variable carrying one visual decision; the only source of visual values.
- **Component** — a shared part built from tokens only. No screen rebuilds one.
- **Theme** — one mapping of every colour token: light or dark.
- **Hairline** — a one-pixel line told apart by luminance only; the preferred separator after
  whitespace.
- **Region** — content separated from the rest by whitespace or a heading.
- **Data point** — a value read as a fact: a name, a count, a time, a state.
- **Exception** — a state that differs from normal and may need the person.
- **Detail** — what a default view leaves out and gives back on demand.

## 1. The attention budget

Binding on every default view, at 1440×900.

1. **Above the fold: at most three regions, one focal point, 15 to 25 data points.**
2. **Overview first, details on demand**: counts and links ("All 26").
3. **One primary action per screen**, at most two secondary visible, the rest behind "···". When
   something waits for the person, answering it is the primary action.
4. **Whitespace before borders**: rows with hairlines, not cards; a filled box **once per page at
   most**, for what needs the person.
5. **Nothing decorative**: no zebra, double separator, decorative icon, uppercase tracked label,
   repeated unit, or bar restating its number.
6. **Four text sizes, two weights.** Sentence case. Prose under ~75 characters a line.
7. **One accent colour**, for the primary action, links and what waits for the person's answer
   (with its own shape, which links never have). **Status colour only where a status differs from
   normal**: red only for "stopped, refused, limit reached"; no orange or yellow anywhere. Never
   "active" or "allowed" in colour. One exception: a service mark in its brand colour, which carries no
   meaning and is never read as a state.
8. **A number only where someone would act on it**: a meter near a limit, otherwise a dash.
9. **At most seven navigation entries.**
10. **Tables of five columns by default**, seven at most; the activity record shows six.
11. **No page-level help longer than one sentence.**
12. **The five-second and squint tests** pass on every default view.

### 1.1 Detail is per page

Detail is reached through disclosures that **remember their state, per page and per region**. When
nothing needs the person, a page shrinks to one sentence saying so, and where to go.

### 1.2 Explicitly out of scope

- No global density setting, no theme customisation beyond light and dark, no illustrations or
  mascots.
- No choreographed animation: an atomic transition of 150 ms at most.
- No design-tool source of truth: the tokens in the code are the reference; no local redefinition of
  a token.
- No side sheet that stays open, no status footer. The one bar above the page is the path bar (§4).

## 2. Words

One word per thing; a person never learns the protocol's word. The word list is
[vaubaan-gateway](./vaubaan-gateway.md) §0.

- **Protocol names do not change**: tool names, refusal codes, risk ids, stored and transmitted
  fields, configuration keys. Quoted, they are printed as spelled, in monospace.
- **Who reads the sentence decides its words**: text for a person (the setup kit, mission API
  messages, authorization pages, catalog prose about the product) uses the interface's words; text
  for an agent or a program (refusal hints, preview messages, tool descriptions) keeps
  the protocol's.
- **Roles are said in sentences** ("you own it with Platform", "waiting for Alice's yes"); never
  "principal" or "beneficiary".
- **Risk is one concept: the row and its reason.** A permission is printed with the name of its row
  — Harmless, Worth a look, Repairable, at a price, Cannot be repaired — and, in quiet
  type where it helps, the reason that put it there (personal data, costly to undo…). No severity
  word (low, medium, high, critical), no score, never the word "tier" (risk model §4.6).
- **The five facts are words**, behind "why?" in the Reference only: Undo, Blast radius, Data,
  Cost, Visible to.
- **A state is a word**, never colour alone; the normal state is plain or unsaid.
- **Routes follow the words**; an older path answers with a permanent redirect; a protocol path
  keeps its name.
- **One list of words**: words and sentence patterns come from one place.

## 3. Tokens

### 3.1 Colour

- Families: paper, hairlines, ink (four levels), accent, the four risk rows (green, cool grey,
  mauve, deep plum: a light tint each, its word darker), exceptions (refused — the one red; done,
  on checklists only), code (dark in both themes), overlay, marks (a person's mark, never a
  status), focus. The trust levels are ink, not colour. A service's brand colour is the one colour that is neither a token nor a status.
- The lowest ink level is below AA on purpose and carries no information (placeholder, disabled
  mark).
- A skin changes values only; names and readers stay.
- The sheet is shared by the interface and the site
  ([ADR](../decisions/design-system-on-shadcn-shared-by-the-app-and-the-site.md)).

### 3.2 Type

Four sizes (title; body, rows, controls and section headings; small, for secondary lines;
captions and identifiers; named `title`, `body`, `small`, `caption` in the token sheet — a size
never shares a name with a colour), weights 400 and 600, a sans-serif and a monospace for identifiers and code, both
bundled, the same on the site.

### 3.3 Space, radius, motion

One spacing scale, three page measures, three control heights, a few radii. Motion on colour,
opacity and transform only. **One shadow**, for what floats; nothing in the page flow casts one.

### 3.4 Themes

Light by default; dark is the same tokens with other values, equally finished. **System, Light,
Dark**, remembered and applied before first paint; part of a page may use the other theme.

## 4. The shell

- **A side navigation**: Now, Waiting for you with its count (its one coloured mark), Missions,
  Accounts, Activity, Reference; after a hairline, Settings. The current section is a fill and the
  strong weight, not a colour; every page belongs to exactly one section.
- **A path bar above the page**: the path (this gateway leading home, the section, crumbs, the
  title), then the theme toggle and the person. No search, no page action.
- **Settings lists its pages in the side column, under its entry**, while one is in Settings
  (You, then Administration); a narrow window or a phone draws them above the page instead.
  Administration is part of Settings. Another local navigation is a row of tabs under the path
  (the Reference); no local column beside the page.
- **Navigation, not a status panel**: no health line, no version; the build is said once, quietly,
  where a page ends.
- **Narrow window**: icons only, still named; **phone**: a bar at the foot, rarer sections behind
  "More".
- **One home**, the root.

## 5. Components

A feature screen uses **only** tokens and components. A need neither provides is stated, then this
guide and the design system are extended, then the screen is built. Rules a component holds:

- **Page header** — title, one sentence of lede, one primary action, at most two secondary.
- **Quiet list row** and **data table** — hairlines, no card, no zebra; five columns by default; row
  actions on hover and on keyboard focus; an exception row tinted, its text saying why.
- **Meter** — shown only near a limit (the caller gives the threshold), a dash below, red and "limit
  reached" at it.
- **Status mark** — a pill for an exception; a squared tag for a fact that is not a state (an
  environment).
- **Avatar** — a person round with initials, a machine key a dashed square, a team squared; then
  what they are here, in words.
- **Service mark** — the icon its plugin declares, in the brand colour it declares, on a neutral
  fill; a near-black brand takes the ink in the dark theme; never a status; two letters of its name
  on a hue without an icon.
- **Identifier** — mono, as the protocol spells it; wraps between words, never inside one.
- **Permission row** — what it allows in words, its id, the name of its row with the reason in quiet
  type, limits, gate, and "why?". Every row is a light pill in its own hue, row 4 in the strong
  weight; no gauge or icon beside it: the word carries the order, so it is never abbreviated or
  hidden. Lists of permissions are ordered by row, the hardest to repair first.
- **Can / Asks first / Cannot** — a mission's summary; says how many permissions it sums up; never
  replaces the explicit list.
- **Dialog** — one question, **the consequence stated before anything happens**, a button named
  after the act; a typed phrase for what cannot be undone.
- **Form field** — the expected shape in its label and again in the error, with what to do; required
  unless it says optional.
- **Code** — a block a person copies has a button copying exactly that; a secret is shown once.
- **Toast** — confirms what the person just did; a failure stays; never the only copy of something
  that matters.
- **Button** — danger is red words, never a red fill; a control that navigates is a link.
- **More menu** — its "···" trigger is drawn as a secondary button of the same size as its
  neighbours, never a faint glyph; it holds acts on the page's object, not the acts of a
  section that has its own place (a mission's keys are in Keys).
- **Card** — once per page at most. **Tabs** — never hide the one thing a newcomer needs.

## 6. Accessibility

- One main region, one navigation named "Main", one title per page; a region is named by its
  heading.
- Everything reachable by keyboard; a dialog traps focus, closes on Escape and returns focus.
- Focus always visible; never colour alone (a status has its word, a meter its figure, a mark its
  shape).
- AA contrast for every text–surface pair in both themes; reduced motion takes no time; click
  targets of 32 px at least; errors announced and tied to their field.

## 7. Tests

- A contrast probe over the documented text–surface pairs, both themes; the two dark-theme
  definitions hold the same values.
- No dead or unknown token, no raw colour outside the token sheet.
- The column budget of a table is enforced where it is built.
- Every page sits under one navigation entry; every old path redirects to a page that exists.
- A gallery renders every component in every state, light and dark, walked by a browser test. Looks
  are judged by eye against it.

## 8. Decisions and open questions

### 8.1 Settled

- Primitives from shadcn/ui, copied into the code and owned; domain components written for this
  interface on them
  ([ADR](../decisions/design-system-on-shadcn-shared-by-the-app-and-the-site.md)).

### 8.2 Open

- **A search across the gateway**: not provided.
- **Notifications** outside the interface for what waits.
- **The phone**: pages hold at 390 px, none designed phone-first.

## 9. Known gaps between this guide and the interface

- Until the migration of [recognise Vaubaan at a glance](../intents/recognise-vaubaan-at-a-glance.md)
  lands, the interface's components not yet rebuilt on the shared primitives (the data table, the
  page frame, the local navigation, the filters, the disclosure, the doc hint) and the pages' own
  style sheets keep CSS modules, which read the shared tokens through aliases of their former names.

- Raw lengths remain in page style sheets and for mark dimensions.
- The consent pages and the refusals of a forwarded request URL load nothing and repeat the tokens
  they need, value for value; a test keeps them equal.
