---
title: Prose read by people outside the pages follows the interface's words; what an agent's code reads does not
status: accepted
date: 2026-10-14
---

# Prose read by people outside the pages follows the interface's words; what an agent's code reads does not

> Finishing step (R3) of the interface redesign (ADR
> [interface-redesign-vocabulary-and-design-system](interface-redesign-vocabulary-and-design-system.md)).
> Handbooks: [web-app](../handbook/web-app.md), [missions](../handbook/missions.md),
> [management-door](../handbook/management-door.md), [demo-mode](../handbook/demo-mode.md);
> plugin guide: [plugins/README](../../plugins/README.md).

## Context

The redesign gave the interface its own words — account, access, permission, limits,
key, Waiting for you, connected app, Activity, teammate, administrator — and kept every
name of the protocol. The three page steps moved the pages, the notices of the handlers
behind them and the instructions of the setup kit. What a person reads **outside a
page** was left in the earlier words:

- `/agent-bootstrap.md`, the generic companion of the kit (the mission-pages ADR left
  it "to the finishing step");
- the `message` of the mission API (`/api/missions/**`), which the mission pages print
  when an act is refused;
- the message pages of the authorization endpoint (an application that waits for
  approval, a disabled one, a consent that expired);
- the reasons, labels and preset descriptions of the plugin catalogs, printed verbatim
  in Reference, in "New mission" and in the "Give access" dialog;
- the text `npm run demo` prints, the README, the changelog and the handbooks.

Other sentences use the same earlier words and are read by an agent, or by the code of
a client: the `hint` of a structured refusal, the `message` of a `PreviewIssue` (which
also answers the management door), the tools and schemas of the management door, the
labels of the options of a request in `/api/requests`.

Two more things had to be settled: dead code the page steps left behind, and whether a
catalog whose wording changes takes a new `catalog_version`.

## Decision

1. **The seam is who reads the sentence.** A sentence whose reader is a person follows
   the interface's words. A sentence an agent or a client program reads keeps the
   protocol's: the hints of the eight refusals, `PreviewIssue.message`, the management
   door's tool descriptions and errors, the option labels of the request API. Codes,
   fields, tool names, risk ids, variables (`VAUBAAN_MISSION_TOKEN`) and configuration
   keys never move, on either side.
2. **`/agent-bootstrap.md` is on the people's side, with a bridge.** Its prose says key,
   permission, limit, account, teammate, machine key, connected app; it opens with a
   short note mapping those words to the names the agent meets in JSON (`connections`,
   `risk_id`, `quota`, `rate_limit`, `gate`, `token`, `member`, `named`). An agent
   reads both and tells its human the first set.
3. **The mission API's messages and the message pages of the authorization endpoint
   are reworded**, because a page prints the first and a person reads the second in a
   browser. Their `error` codes and HTTP statuses are unchanged.
4. **Catalog prose is reworded only where it addresses the reader about the product**
   ("a mission must hold this permission too", "production deploys ask first", "One
   mission per code project"). A sentence that describes the service ("Low risk",
   "identity provider", a preset called "Operator") stays. Ids, keys, structure, vectors,
   limits and gates are untouched. The plugin guide and the provider-modeler skill state
   the rule for new catalogs.
5. **No `catalog_version` is bumped for this wording.** No id, vector, pattern, limit
   or gate changed, no test depends on the version, and a version exists to tell
   instances that what a catalog _grants_ was reviewed again.
6. **Unused code goes with its tests**: the explanation components of the first
   interface (`components/risk/`), `eventDetailLines`, and the primitives `Slug`,
   `Glyph`, `KindLegend`, `Help`, `Badge`, `Banner` and the bare table elements, with
   their specimens on `/design`. `Callout` loses its `icon` prop, which nothing passed
   and which was the last reader of the glyph set.
7. **The spec is not edited by this step.** `docs/spec/` belongs to the planning step;
   the aligned text (a "Words" note in §0, §4.2 rewritten from the pages, §4.4, §7) is
   handed over as a proposal.

## Consequences

- A person who reads a refusal on a mission page, an OAuth message page, the tour of
  the demo or the agent page meets the words of the navigation. An agent that parses a
  `hint` or a preview issue meets the words of the fields it fills.
- Two wordings of some facts now exist on purpose (the kit's guidance for
  `budget-exhausted` against the door's `hint`). They say the same thing; neither is
  generated from the other.
- The integration test of a mission's session asserts the typed fields of each event
  (`gate`, `gate_before`, `gate_open_until`, `tokens_revoked`) instead of a wording
  that no page prints; the wording a page prints is tested beside the page
  (`event-words.test.ts`).
- The plugin guide says a `catalog_version` is bumped "on every reviewed change of the
  content". This step did not bump for a wording-only change made to every catalog at
  once; the guide's rule stands for a change to a single catalog's content, and the
  question whether wording counts is open (below).
- Until the planning step applies the proposal, the spec's §4.2 still names the pages
  in the earlier words, and the handbooks cite its section titles as they are.

## Rejected alternatives

- **Reword the hints of the refusals too.** They are part of what the execution door
  answers, pinned by tests and quoted by agent instructions already in use. The kit and
  the agent page are where an agent is told how to speak to its human.
- **Leave `/agent-bootstrap.md` in the protocol's words.** The kit it accompanies was
  moved; two documents handed together would disagree on every noun.
- **Generate the catalog's reader-facing sentences from the vocabulary file.** Reasons
  are written by plugin authors, one sentence at a time, and mix facts about the
  service with facts about the product; a template would flatten both.
- **Bump every `catalog_version`.** Eleven version changes that say "reviewed" for
  catalogs nobody re-reviewed, and a release note that would read as a change of what
  missions may do.
- **Keep the legacy primitives "in case".** Nothing imported them; their specimens
  made the gallery show components no page may use.

## Open

- Does a wording-only change of a catalog count as "a reviewed change of the content"
  for `catalog_version`? Decided here as no, for this step.
