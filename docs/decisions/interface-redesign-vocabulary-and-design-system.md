---
title: The interface is rebuilt on one design system, one vocabulary and an attention budget (proposal D, balanced)
status: accepted
date: 2026-10-13
---

# The interface is rebuilt on one design system, one vocabulary and an attention budget (proposal D, balanced)

> Decided by the product owner on 2026-10-13, after a cold usability audit and four
> design proposals. This record covers the foundation (step R1): the tokens, the
> components, the shell, the words and the routes. Spec:
> [style-guide](../spec/style-guide.md). Handbook: [web-app](../handbook/web-app.md).

## Context

The v5 interface was complete — every action of spec §7 had a page — and it was hard
to enter.

**The owner's verdict.** Three sentences set the bar: "on arriving, one should think:
wow, a mature, well thought-out application"; "lots of concepts hard to grasp… tokens
of different kinds everywhere"; and, of the first proposals, "still a bit too busy".

**The cold audit.** Someone who had read no documentation used the demo as three
people and wrote down what they understood. Its ten most damaging problems:

1. the first screen says nothing of what the product does, and three pages compete for
   "home" (the sign-in card, `/` → Missions, the wordmark → Connections);
2. "risk" is the unit of permission, with an unexplained six-cell profile on every row;
3. the Custom mode of a new mission is a 7,000 px page with its summary at the bottom;
4. "Share" (a verb, on a connection) against "Shares" (a navigation entry that lists
   what was received); what a person gave is listed nowhere;
5. presets that yield nothing are offered without a reason;
6. a request is signalled by a badge only: not on its mission, never to a teammate;
7. four credential-like objects under four vocabularies (mission, member and named
   tokens, the bootstrap token, a client id, the provider credential);
8. rotating a token revokes it at once, with no confirmation and no stated consequence;
9. connect forms refuse a key without saying the shape they expect;
10. Administration has no checklist and reuses the labels of the application for other
    things ("Connections" for "Connections without owner").

The audit also inventoried fifty words a newcomer must decode, several used for more
than one thing (provider, connection, share, member, token, session).

**What existed.** A top bar of eight entries; a Geist-inspired token sheet (fourteen
grays, four status families, nine "type hues" that coloured every name by its kind);
twenty primitives; pages styled by eleven local style sheets; a light theme pinned in
the root layout and a dark one that could not be reached.

Four proposals were drawn as static mockups (A: a calm console; B; C: a live control
room; D: their synthesis, in three densities).

## Decision

**The interface follows proposal D at its Balanced density**, and is built from one
design system that every page uses. The mockups are its specification; the foundation
delivers what the three page steps are built from.

**One design system.**

- _Tokens_ (`apps/gateway/src/styles/tokens.css`): paper and ink, **one blue accent**
  for the primary action and links, amber for "needs you", red for "stopped, refused,
  limit reached", green on checklist ticks only. **Four text sizes** (12, 13, 14, 20 px)
  and **two weights** (400, 600). A 4 px space base and a page rhythm (36 px between
  sections). Hairlines before boxes. The gray and status primitive scales and the nine
  type hues are removed: a name is no longer coloured by its kind.
- _Themes_: light is the default; dark is the same tokens, equally finished. A
  **three-state choice** — System, Light, Dark — is kept in a cookie
  (`vaubaan_theme`) so that the server writes `data-theme` on `<html>` itself: the
  first paint is in the right theme, with no inline script. No attribute means
  "follow the system" (`prefers-color-scheme`).
- _Components_ (`apps/gateway/src/components/ui`): page header, section heading, quiet
  rows, data table, meter, status marks, avatars and key holders, mono ids, permission
  row, the Can / Asks first / Cannot summary, inline answer row, empty and first-run
  states, callout, dialog, details on demand, tabs, filters, search, form fields, code
  block, toast, skeleton. A component a page misses is added there, never in the page.
- _A gallery_ at `/design` shows every component in every state on a light and a dark
  island. It is the reference for whoever builds or reviews a page.

**One shell.** A short side navigation of **seven entries** — Now, Waiting for you
(with its count), Missions, Accounts, Activity, Reference, then Settings — with the
person and the theme at its foot, collapsing to its icons in a narrow window.
Administration uses the same shell and the same global navigation; its pages get the
local navigation of Settings. There is **one home**, `/`.

**One vocabulary** (`apps/gateway/src/lib/vocabulary.ts`), the words a person reads:

| The spec and the code say                     | A person reads                                           |
| --------------------------------------------- | -------------------------------------------------------- |
| connection                                    | **account**                                              |
| share, shares received                        | **access**: Who has access, Give access, Shared with you |
| risk, `RiskId`                                | **permission** (its severity kept as one word)           |
| preset                                        | preset (kept)                                            |
| gate `auto` / `approval`                      | **runs freely** / **ask me first**                       |
| budget, quota, rate limit                     | **limits**, per day and per minute                       |
| mission token, member token                   | **key**, your key                                        |
| named token                                   | **machine key**                                          |
| rotate                                        | **Replace key**                                          |
| request (claim, approval request)             | **Waiting for you**                                      |
| delegation, OAuth client                      | **connected app**                                        |
| provider app                                  | **company app**                                          |
| provider (the vendor) / Providers (the pages) | **service** / **Reference**                              |
| session, audit                                | **Activity**                                             |
| member                                        | **teammate**                                             |
| operator                                      | **administrator**                                        |
| group                                         | **team**                                                 |
| mission                                       | mission (kept)                                           |

**The rename is the interface, the documentation for people and the prose of the
bootstrap kit — nothing else.** MCP tool names, refusal codes, risk ids, catalog YAML,
database columns, API fields and configuration keys keep their names; an id is printed
as the protocol spells it, in mono.

**Routes follow the words**: `/accounts`, `/waiting`, `/activity`, `/reference`,
`/settings`. Every old page path (`/connections/**`, `/requests/**`, `/audit`,
`/providers/**`) answers with a permanent redirect (308: a form post keeps its method).
Paths that are part of a protocol keep their names: `/mcp`, `/api/**`, `/oauth/**`,
`/r/<id>` and **`/connections/callback/<provider>`**, which companies registered at
their providers.

**An attention budget, binding on every default view** at 1440×900:

- above the fold, at most three regions, one focal point, fifteen to twenty-five data
  points;
- one primary action per screen, at most two secondary ones, the rest behind "···";
- whitespace before borders; a filled box once per page at most;
- status colour for exceptions only: nothing is labelled "active" or "allowed" in colour;
- four text sizes, two weights, sentence case; one sentence of page help at most;
- a number only where someone would act on it: a meter is shown near a limit;
- tables of five columns by default, the others on demand (seven at most);
- at most seven navigation entries.

**Detail is per page and remembered**: "show details" disclosures (`Disclosure`,
`DetailScope`) keep their state in the browser under the name of the page and the
region.

## Consequences

- Three page steps can now run in parallel on one set of components and one set of
  words; a page no longer carries its own palette or its own modal.
- The ten problems of the audit have a named answer in the system: one home; a
  permission with one severity word and a "why?"; a sticky summary; "Who has access";
  a reason on a preset that allows nothing; an answer row on the home and on the
  mission; one word, key; a confirmation that states its consequence; a field that
  states its shape; a setup checklist. The foundation delivers the components; the
  pages that use them follow.
- No capability is removed and no security property is weakened: a permission list
  stays explicit (the summary says how many it sums up, and the list is one click
  away), every quantity and gate stays visible, the reference stays reachable.
- **Two vocabularies now coexist**: the code and the spec say `connection`, `risk`,
  `gate`; the interface says account, permission, runs freely. `lib/vocabulary.ts` is
  the one bridge, keyed by the protocol's names. A reader of the code must know both.
- **Until the page steps land, pages keep their bodies**: the shell, the titles and the
  tokens are new, the content of a page is not. `/` shows the missions list; Settings
  leads to the existing Administration pages; `Slug`, `Glyph`, `KindLegend` and `Help`
  are kept for those pages and go when nothing imports them.
- The spec (`docs/spec/vaubaan-gateway.md` §4.2) still names pages and paths in the
  earlier words. It is the planning step's to align; this record and the style guide
  are the source for the words until then.
- Contrast is held by a test over the token sheet (AA for every documented pair in both
  themes). The mockup's third ink was darkened one step to pass it.
- The theme cookie is readable by scripts on purpose (the toggle writes it); it carries
  a display preference and nothing else.
- Old links keep working at the price of one redirect; the redirect list must outlive
  the pages it points to.

## Rejected alternatives

### Proposal A as a whole — the calm console

A table of missions as the home, a single scroll per page, restraint everywhere. Its
home answers "what exists", not "does anything need me": the owner's day starts with
the second question. Its restraint, its hairlines, its one-screen mission form and its
sticky summary rail are kept in D.

### Proposal B as a whole

It renamed presets "templates" — a word that implies a document one copies — and kept
more of the earlier information architecture. Its words lost to C's, and its structure
to A's.

### Proposal C as a whole — the live control room

A living home with inline answers and an inbox, which D keeps; but also seven tabs on
a mission (tabs hide the one thing a newcomer needs), launch-pad cards, a permanent
side sheet for giving access (a region that is always open always competes), three
signal colours and "role" for preset (it collides with owner, creator, teammate,
administrator). The owner found it "still a bit too busy".

### A global density setting (Essential / Balanced / Detailed as a preference)

The three densities were drawn to find the default, not to be offered. Essential is
what a balanced page becomes when nothing needs the person, and what a phone shows;
Detailed is wanted on _this_ mission during an incident, not on every page. A global
setting would be a fourth concept to explain for a benefit two people would use, and
it would triple what every page must be designed and tested for. Per-page disclosures
that remember their state give the same reach.

### Keeping the type hues

Colouring every name by its kind (violet for a risk, pink for a tool…) made a page a
field of colour in which a status could not stand out. With one accent and two
exception colours, the kind is said in words.

### Renaming the protocol too

One vocabulary everywhere would be simpler to hold. It would break every agent
instruction already written, every catalog, every audit record and every integration,
for the benefit of the people who read code — the ones who can best afford two names.

### Remembering the theme in `localStorage` with an inline script

The usual way to avoid a flash. It needs a script that runs before the first paint,
which a content security policy would have to exempt; the cookie lets the server
render the attribute and needs none.

## References

- Spec: [style-guide](../spec/style-guide.md); [vaubaan-gateway](../spec/vaubaan-gateway.md) §4.2, §7.
- Handbook: [web-app](../handbook/web-app.md).
- The mockups, the rationale of proposal D and the cold audit are working documents of
  the redesign, kept outside the repository.
