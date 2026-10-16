---
title: The Miro plugin names a board by its id with the trailing `=` written `~`
status: accepted
date: 2026-10-16
---

# The Miro plugin names a board by its id with the trailing `=` written `~`

> **Accepted** on 2026-10-16 by the product owner, Renaud Pelissier, who
> chose "ref spelled with `~` + ADR" for the Miro plugin
> (`@vaubaan/plugin-miro` 0.1.0). Handbook:
> [`providers/miro.md`](../handbook/providers/miro.md) §5.1. The exception
> is local to this plugin: the plugin kit, the SDK and the slice grammar are
> unchanged.

## Context

The plugin kit (`plugins/README.md`, step 6) asks that a resource `ref` be
"the provider's stable id". A Miro board id looks like `uXjVOD6LSME=`: the
documentation gives no grammar, and the trailing `=` reads as base64
padding. A slice identifier holds `[a-zA-Z0-9_./~-]` only (spec
`gateway-risk-model.md` §3), so `=` cannot be carried.

The kit has a rule for that case (`plugins/README.md`, step 4, "An
identifier the slice grammar cannot carry is written as 'any'"): build the
segment with `identSegment(value)`, which writes `[*]`, and **never escape
the identifier**, "the slice would no longer be the name an owner writes".
The rule protects one thing: that the identifier in a slice is the very
string a person reads and writes elsewhere — in the interface, in a mission.
An escape would make the slice say `uXjVOD6LSME~` while everything else says
`uXjVOD6LSME=`.

That reason does not hold here, because the spelling is not an escape
applied to the slice alone: the `ref` itself is spelled with `~`. The ref
discovery stores, the ref the interface shows and a mission selects, the
`board` argument an agent passes and the slice identifier are one and the
same string, `uXjVOD6LSME~`; only `execute` turns it back into Miro's
spelling, for the URL. Nothing a person writes is a pattern over board ids
either: missions store explicit risk ids, not slice patterns, and every
catalog pattern names boards as `board[*]` or `board[**]`. So the slice
stays "the name an owner writes" — the name the gateway shows them.

The product owner first chose a slice-safe spelling because `[*]` defeated
the environment resolver on a mission holding several boards. The Miro model
then dropped environments altogether (no `envScopable` entity, no env-scoped
risk), which removed that reason. Re-evaluated without environments, the risk
decision does not need the board in the slice either: every catalog pattern
is `board[**]` or `board[*]`, and the classifier checks the `board` argument
against the mission's resources before emitting anything.

One consequence remains. The gateway's resource stage
(`apps/gateway/src/server/execution/resource-stage.ts`, `citedRefs`) finds
the resource a call targets by reading the known refs off the slices the
classifier emitted; it never guesses from argument names. With `board[*]` it
finds none and falls back to the mission's resource only when the mission
holds exactly one. On a mission with two boards, every Miro call would be
audited with `resource_ref: null`, and an approval request would be headed
"Delete a frame" without the board the person must decide about.

## Decision

The `ref` of a Miro board is its Miro id with each trailing `=` written `~`:
`uXjVOD6LSME=` → `uXjVOD6LSME~`.

- Two grammars, one per spelling: the Miro id
  `^[A-Za-z0-9_-]{1,62}={0,2}$` and the ref `^[A-Za-z0-9_-]{1,62}~{0,2}$`;
  `~` cannot occur in an accepted Miro id, so the mapping is one to one.
- Two functions, `boardRefOf(miroId)` and `miroIdOf(ref)`, each `null`
  outside its grammar, shared by `classify`, `execute` and discovery.
- Tools take the ref, slices carry it as is, `execute` turns it back into the
  Miro id for the URL (`encodeURIComponent`, `=` → `%3D`).
- A `board` argument in Miro's spelling is refused — never converted
  (refuse, never repair, ADR
  [`plugin-identifiers-one-grammar-for-classify-and-execute`](./plugin-identifiers-one-grammar-for-classify-and-execute.md));
  the refusal names the ref to use only when the mission holds that board.
- The exception is this plugin's: no change to the kit's rule, which keeps
  applying to every other plugin and to every other identifier of this one.
- A board id outside the Miro grammar at discovery is left out of the
  resources, with a warning.

## Consequences

- The audit and the approval pages name the board on every mission, whatever
  the number of boards it holds; `resource-not-in-mission` can name it too.
- The ref a person sees in the interface differs from the id in a Miro board
  link by its last characters. The refusal sentence bridges the two for an
  agent that copies a link.
- The rule is local to the plugin: no SDK, spec or slice-grammar change. If
  environments return to the Miro model, the resolver works on several
  boards with no further change.
- If Miro board ids turn out to carry `+`, `/` or an inner `=`, those boards
  are not offered at all; the grammar would then need a revision (and this
  ADR an amendment).

## Rejected alternatives

- **The Miro id as ref, slice segment by `identSegment` (`[*]`).** No new
  rule, and the risk decision is unchanged; but the board is lost for the
  audit and the approval header on every multi-board mission.
- **One board per mission.** Restores the fallback of the resource stage by
  construction, at the price of a restriction the product does not have
  elsewhere.
- **Widening the slice grammar with `=`.** A spec change for one provider,
  out of a plugin's reach, and it would let a padding character into every
  pattern a person writes.
- **Converting a Miro-spelled argument silently.** A repair: what the agent
  sent would differ from what was classified, which the identifier ADR
  forbids.
