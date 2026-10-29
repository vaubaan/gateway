---
title: The interface is built on one design system and speaks a people's vocabulary bridged to the protocol's names, which never change
status: accepted
date: 2026-10-13
---

# The interface is built on one design system and speaks a people's vocabulary bridged to the protocol's names, which never change

## Context

The first v5 interface had a page per action of the spec, three competing homes and four
credential-like objects under four vocabularies; a cold usability audit found fifty words a
newcomer had to decode ("risk", "share" versus "shares", "token" of several kinds). Four proposals
were mocked up; their synthesis (D, at its balanced density) was chosen. The protocol's names
(tool names, refusal codes, risk ids, API fields) are read by agents and integrations.

## Decision

Every page is built from one design system: tokens in `apps/gateway/src/styles/tokens.css` as the
one layer of visual decisions, shared components in `apps/gateway/src/components/ui`, a gallery at
`/design`. People read one vocabulary (account, permission, key, Waiting for you…), mapped from the
protocol's names by `apps/gateway/src/lib/vocabulary.ts`; the rename covers the interface, the
documentation for people and the bootstrap kit's prose, nothing else.

## Consequences

- A missing component is added to `components/ui`, never in a page; no page carries its own
  palette or modal.
- Two vocabularies coexist; ids print in mono as the protocol spells them. Routes follow the words,
  and old page paths answer 308 for as long as anything points to them.
- Every default view follows the attention budget of the style guide
  ([style-guide](../spec/style-guide.md)); contrast is held by a test over the token sheet.

## Rejected alternatives

### Proposal A (calm console) or C (live control room)

A's home answers "what exists", not "does anything need me"; C was still too busy. D keeps A's
restraint and C's inline answers.

### Renaming the protocol too

Breaks every agent instruction, catalog, audit record and integration, for the readers best able
to hold two names.

### A global density setting

A fourth concept to explain, tripling what each page must be designed and tested for.
