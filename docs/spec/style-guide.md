---
title: Style guide — the attention budget, tokens and components
status: current
date: 2026-10-13
---

# Style guide — spec

> **Status:** current. The visual and verbal vocabulary of the web interface
> ([vaubaan-gateway](./vaubaan-gateway.md) §4.2) and the rules a screen must
> follow. Rewritten for the redesign decided on 2026-10-13 (ADR
> [interface-redesign-vocabulary-and-design-system](../decisions/interface-redesign-vocabulary-and-design-system.md)).
> How it is built is in the handbook [web-app](../handbook/web-app.md); every
> component can be seen, in every state and both themes, on the gallery page of
> a running gateway (`/design`).
>
> **Stance.** A quiet control room: what waits for the person, answerable
> where they see it, and what is running — in quiet lists, hairlines instead of
> boxes, nothing decorative. A page shows the exception and not the rule.

## 0. Vocabulary

- **Token** — a named variable that carries one visual decision. Tokens are the
  only source of visual values.
- **Component** — a shared part of the interface built from tokens only. No
  screen rebuilds one.
- **Theme** — one mapping of every colour token. Two exist: light and dark.
- **Hairline** — a one-pixel line told apart only by its luminance: the
  preferred separator after whitespace.
- **Region** — a group of content separated from the others by whitespace or a
  heading.
- **Data point** — a value a person could read as a fact: a name, a count, a
  time, a state.
- **Exception** — a state that differs from normal and may need the person:
  something waits for them, something is stopped.
- **Detail** — what a default view leaves out and gives back on demand.

## 1. The attention budget

Binding on every default view. Measured on a window of 1440×900.

1. **Above the fold: at most three regions, one focal point, fifteen to
   twenty-five data points.** Every extra unit of information competes with the
   relevant ones.
2. **Overview first, details on demand.** Counts and links where the content is
   not needed now ("All 26", "Show the 14 unused").
3. **One primary action per screen**, at most two secondary ones visible, the
   rest behind "···". When something waits for the person, answering it is the
   primary action and the page's usual one steps down.
4. **Whitespace before borders.** A border, a fill and a shadow are each a claim
   that something is a separate object. Lists are rows with hairlines, not
   cards; the navigation is a fill, not a box; a filled box is used **once per
   page at most**, for the thing that needs the person.
5. **Nothing decorative.** No zebra, no double separator, no decorative icon, no
   uppercase tracked label, no repeated unit, no bar that says what the number
   beside it already says.
6. **Four text sizes and two weights** (§3.2). Sentence case everywhere. Prose
   lines stay under about 75 characters.
7. **One accent colour**, for the primary action and links. **Status colour
   only where a status differs from normal**: amber for "needs you", red for
   "stopped, refused, limit reached". Nothing is ever labelled "active" or
   "allowed" in colour.
8. **A number only where someone would act on it.** A meter appears when a
   limit is near; otherwise a dash.
9. **At most seven navigation entries.**
10. **Tables of five columns by default**, the others on demand; seven at most.
    The activity record is the one exception, at six: a log is rows.
11. **No page-level help longer than one sentence.**
12. **The five-second test and the squint test** pass on every default view:
    after five seconds one knows what the page is for and what to do next;
    blurred, it shows one focal point and at most three groups.

### 1.1 Detail is per page

A default view shows what a person acts on. The rest is reached through
disclosures on the page — "show details", "All 26", "Edit the permissions one by
one" — **which remember their state, per page and per region**. An
administrator wants the detail on this mission during an incident, not on every
page.

What a page becomes when nothing needs the person is its smallest form: one
sentence that says so, and where to go.

### 1.2 Explicitly out of scope

- **No global density setting.** Density is decided per page, by its
  disclosures.
- **No theme customisation** per person or per company beyond light and dark.
- **No illustrations or mascots.**
- **No choreographed animation.** Motion is an atomic transition of 150 ms at
  most.
- **No design-tool source of truth.** The tokens in the code are the reference.
- **No local redefinition of a token.** If a need has no token, a token is
  added.
- **No side sheet that stays open**, no top bar, no status footer in the
  navigation.

## 2. Words

The interface names each thing with one word, and a person never has to learn
the word the protocol uses.

| The spec and the protocol say             | A person reads                                           |
| ----------------------------------------- | -------------------------------------------------------- |
| connection                                | **account**                                              |
| share; shares received                    | **access**: Who has access, Give access, Shared with you |
| risk                                      | **permission**; its severity is one word                 |
| preset                                    | preset                                                   |
| gate: auto / approval                     | **runs freely** / **ask me first**                       |
| budget, quota, rate limit                 | **limits**, per day and per minute                       |
| mission token, member token               | **key**, your key                                        |
| named token                               | **machine key**                                          |
| rotate                                    | **Replace key**                                          |
| request: a claim, an approval request     | **Waiting for you**                                      |
| delegation, OAuth client                  | **connected app**                                        |
| provider app                              | **company app**                                          |
| provider (the vendor); the provider pages | **service**; **Reference**                               |
| session, audit                            | **Activity**                                             |
| member                                    | **teammate**                                             |
| operator                                  | **administrator**                                        |
| group                                     | **team**                                                 |
| mission                                   | mission                                                  |

Rules:

- **Protocol names do not change.** Tool names, refusal codes, risk ids, catalog
  entries, stored and transmitted field names and configuration keys keep the
  names the spec gives them. An identifier is printed as the protocol spells it,
  in the monospace face, where a person may need to quote it; the words around
  it are the interface's.
- **Roles are said in sentences** where they matter: "you own it with Platform",
  "· you · creator", "waiting for Alice's yes". "Principal" and "beneficiary" are
  never shown.
- **The six axes of a risk are said in words**, behind "why?": Undo, Blast
  radius, Data, Cost, Visible to, Lasts.
- **A state is a word**, never a colour alone; the normal state is written
  plainly or not at all.
- **Routes follow the words**: accounts, waiting, activity, reference, settings;
  the home is the root. A path the interface had before answers with a permanent
  redirect. A path that is part of a protocol keeps its name.
- **One list of words.** The interface takes its words and sentence patterns
  from a single place, so that a page cannot drift.

## 3. Tokens

Tokens live in **one root style sheet**, as custom properties. Components are
styled in files scoped to the component, which reference tokens and nothing
else.

### 3.1 Colour

| Group      | Tokens                                                                                    | Use                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Paper      | `paper`, `paper-side`, `paper-raised`, `fill`, `hover`                                    | the page; the navigation and quiet fills; controls and dialogs; the current entry and neutral pills; a row under the pointer |
| Hairlines  | `line`, `line-strong`                                                                     | separators; the border of a control                                                                                          |
| Ink        | `ink`, `ink-2`, `ink-3`, `ink-4`                                                          | text; secondary text; ledes, hints, captions; placeholders only                                                              |
| Accent     | `accent`, `accent-ink`, `accent-soft`, `accent-line`, `on-accent`                         | the primary action and links                                                                                                 |
| Exceptions | `warn…`, `bad…`, `ok…` — each with `-soft` and `-line`; `on-warn`                         | needs you; stopped, refused, limit reached; done (checklists only)                                                           |
| Code       | `code-bg`, `code-ink`, `code-dim`, `code-key`, `code-string`, `code-btn`, `code-btn-line` | code blocks, dark in both themes                                                                                             |
| Overlay    | `scrim`, `shadow-overlay`, `knob`                                                         | what floats above the page                                                                                                   |
| Marks      | `hue-0` … `hue-5`, `on-hue`                                                               | the mark of a person or a service; never a status                                                                            |
| Focus      | `focus-ring`                                                                              | a gap in the colour of the page, then the accent                                                                             |

`ink-4` is below AA on purpose and carries no information: a placeholder, a
disabled mark.

### 3.2 Type

| Token        | Size  | Use                                                     |
| ------------ | ----- | ------------------------------------------------------- |
| `text-title` | 20 px | the page title; the one statement of a request          |
| `text-base`  | 14 px | body text; section headings, in the strong weight       |
| `text-sm`    | 13 px | rows, tables, controls, ledes                           |
| `text-xs`    | 12 px | captions, chips, table heads, identifiers under a label |

Two weights: regular (400) and strong (600). Two families: a sans-serif for all
interface text and a monospace for identifiers and code, both bundled with the
application. The letters inside a mark (an avatar, a service mark, a step
number) are sized with the mark and are not text sizes.

### 3.3 Space, radius, motion

- **Space**: a 4 px base — 2, 4, 8, 12, 16, 20, 24, 32, 40, 48.
- **Rhythm of a page**: a column of 1120 px (860 px for one object or a form,
  1240 px for a table), 44 px of side padding, **36 px between two regions**,
  11 px above and below a row, a navigation of 220 px (56 px collapsed).
- **Controls**: three heights — 26, 30 and 36 px.
- **Radius**: 4 px (tags, checkboxes, inline code), 6 px (buttons, inputs,
  navigation entries), 10 px (the one filled box, callouts, dialogs, code
  blocks), full (pills, avatars, dots).
- **Motion**: 100 ms and 150 ms, one ease-out, on colour, background, border
  colour, opacity and transform only.
- **Shadow**: one, on what floats above the page (a dialog, a toast, the
  person's menu). Nothing in the flow of a page casts a shadow.

### 3.4 Themes

Light is the default. Dark is the same tokens with other values, equally
finished on every page.

A person chooses among **three states: System, Light, Dark**. The choice is
remembered and applied before the first paint: a page never flashes in the other
theme while loading. System follows the device.

A part of a page may be drawn in the other theme (the gallery shows both side by
side): a theme applies to an element and everything inside it.

## 4. The shell

- **A side navigation**, a fill without a border: the product and where this
  gateway lives; **Now**, **Waiting for you** with its count, **Missions**,
  **Accounts**, **Activity**, **Reference**; then, after a hairline,
  **Settings**. At its foot, the person — their name, and behind it what they
  are here and "Sign out" — and the theme toggle. The count of what waits is the
  one coloured mark of the navigation.
- **It is navigation, not a status panel**: no health line, no version string.
  The build is said once, quietly, where a page ends.
- **The current section** is marked by a fill and the strong weight, not by a
  colour. Every page belongs to exactly one section.
- **In a narrow window** the navigation collapses to its icons, each still named
  for assistive technology and on hover; on a phone it becomes a bar above the
  page.
- **One home**: the root. The brand and the sign-in both lead there.
- **Administration is part of Settings**: the same shell and the same global
  navigation, with a local navigation beside the page. No label is used for two
  things.
- **A page column** of one of three measures, chosen by the page.

## 5. Components

| Component                     | What it is, and its rule                                                                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Page header**               | where one is, the title, one sentence of lede, one primary action, at most two secondary ones, the rest behind "···"; optionally a mark before the title and the exception beside it           |
| **Section heading**           | a heading, an optional count, one short note or link on the right                                                                                                                              |
| **Summary line**              | the counts that lead elsewhere; a count that leads to a list is a link                                                                                                                         |
| **Quiet list row**            | a title, one line of facts, at most one thing beside it, and at the end an action or a short fact; hairlines between rows, no card                                                             |
| **Data table**                | five columns by default; detail columns on demand; row actions on hover and on keyboard focus; a tint on the exception row, whose text says why; a quiet title per group; no zebra             |
| **Meter**                     | shown only near a limit — the caller gives the threshold; a dash below it; red and "limit reached" at the limit                                                                                |
| **Status mark**               | a pill with a dot for an exception; a dot beside a word that says the state; a squared tag for a fact that is not a state (an environment)                                                     |
| **Avatar, key holder**        | a person is a round mark with initials, a machine key a dashed square, a team a squared mark; the name, then what they are here, in words; a masked key in mono with a key                     |
| **Identifier**                | mono, as the protocol spells it; wraps between its words, never inside one                                                                                                                     |
| **Permission row**            | what it allows in words, its id in mono, one severity word, limits per day and per minute, runs freely or ask me first, and "why?" — the reason, the six words, the tools, the reference       |
| **Can / Asks first / Cannot** | the summary of a mission in three lines, a fourth when one limit is near; says how many permissions it sums up; never replaces the explicit list                                               |
| **Inline answer row**         | who asks, what exactly, where, how long ago, then the answers (approve, refuse, raise) on the same row; as the one filled box of a page when a mission waits for its creator                   |
| **Empty and first-run**       | one sentence that says what is the case and one action; for a first run, what the product is, the model in a few nodes, the steps; a checklist with done, partly done, to do                   |
| **Callout**                   | a note that interrupts on purpose: neutral, where to go next, needs you, stopped, done; never a tinted paragraph of help                                                                       |
| **Dialog**                    | one question, **the consequence stated before anything happens**, optionally a choice between ways of doing it, a button named after the act, Cancel; a typed phrase for what cannot be undone |
| **Show details**              | a quiet link that says what will appear, and the panel it opens; or one toggle for a region; the state is remembered per page                                                                  |
| **Tabs**                      | for peers of a reference; never to hide the one thing a newcomer needs                                                                                                                         |
| **Filters**                   | segments for one choice among a few; chips for facets that add up; a quiet search field                                                                                                        |
| **Form field**                | says the expected shape in its label and again in the error, with what to do; required unless it says optional; no success state; checkbox, radio and a switch labelled by what happens        |
| **Code**                      | inline for a name; a block for what a person copies, with a button that copies exactly that; a secret is shown once                                                                            |
| **Toast**                     | confirms what the person just did and leaves; a failure stays; never the only copy of something that matters                                                                                   |
| **Skeleton**                  | the shape of what is loading, in place of it                                                                                                                                                   |
| **Button**                    | primary (the accent), secondary, ghost, danger (red words, never a red fill); three sizes; a control that navigates is a link with the same look                                               |
| **Card**                      | a bordered box, once per page at most                                                                                                                                                          |
| **Local navigation**          | a short column beside the content of a page that is a small place of its own (Settings, Reference)                                                                                             |

A feature screen uses **only** tokens and components. When a screen needs
something neither provides, the order is: state the need; extend this guide and
the design system (a token, a variant, a component); then build the screen. Not
"hard-code it now and factor it later".

## 6. Accessibility

- **Landmarks and headings**: one main region, one navigation named "Main", one
  title per page; a region is named by its heading.
- **Keyboard**: everything is reachable; the first stop leads straight to the
  page; row actions shown on hover also show on focus; a dialog keeps the focus
  inside itself, closes on Escape and gives the focus back.
- **Focus always visible**: a ring in the accent, never removed.
- **Never colour alone**: a status carries its word, a meter its figure, an
  exception row its reason, a mark its shape.
- **Contrast**: AA at least for every pairing of text and surface, in both
  themes, including text on a tinted surface.
- **Reduced motion is respected**: transitions and animations take no time, the
  end state is the same.
- **Click targets of 32 px at least**, whatever the drawn height of a control.
- **Errors** are announced, and tied to the field they are about.

## 7. Tests

Tokens are the specification; tests check what must hold of them, not "this
button is blue":

- a **contrast probe** over the documented pairs of text and surface, in both
  themes;
- the two definitions of the dark theme (chosen, and from the system) hold the
  same values;
- **no dead token and no unknown token**: every token is used, every reference
  resolves; **no raw colour** outside the token sheet;
- the **column budget** of a table is enforced where the table is built;
- every page sits under exactly one navigation entry, and every old path
  redirects to a page that exists;
- a **gallery** renders every component in every state, on a light and a dark
  island; a browser test walks it.

How a page looks is judged by eye, against the gallery, at 1440×900 and
1280×800, in both themes.

## 8. Decisions and open questions

### 8.1 Settled

- Proposal D at the Balanced density; the attention budget of §1.
- Light by default, dark equally finished, three states, no flash.
- One accent; amber and red for exceptions; green on checklist ticks.
- Four sizes, two weights, sentence case.
- Components written for this interface, with no component library.
- Detail per page, remembered; no global density setting.

### 8.2 Open

- **A search across the gateway** (the mockups draw a field in the navigation).
  Not provided: nothing would answer it yet.
- **Notifications** outside the interface (mail, chat) for what waits.
- **The phone**: the collapsed shell and the answer row hold; whole pages were
  not drawn at 390 px.

## 9. Known gaps between this guide and the interface

Stated so that nobody takes a rule for a fact:

- **Every page was rebuilt on the design system** (Now and Waiting for you;
  the mission pages; Accounts, Reference, Activity, Settings and the
  administration). The components of the first interface — a name with the
  glyph of its kind, a legend of kinds, a one-line help with "More", the
  earlier badge, banner and bare table — are deleted.
- **Raw lengths remain** in the style sheets of those pages and, in the design
  system, for the dimensions of marks and a few hairline adjustments.
- **The consent pages of the authorization endpoint and the refusals of a
  forwarded request URL** are separate documents sent under a content policy
  that loads nothing: they cannot read the token sheet and repeat the tokens
  they need, value for value, in both themes. A test keeps the two equal.
