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

## Amendment 2026-11-05: the risk model's words live in the policy engine

### Context

The public site's plugin page ([website](../spec/website.md) §2.3) prints the six facts of a
permission, the gate words and a mission's Can / Asks first / Cannot "in the gateway's words",
and may not import `apps/gateway` ([ADR](website-nextjs-on-vercel.md)). It kept a copy of the
undo words, checked by a test: a second source of truth (website spec §1.1).

### Decision

The words of the risk model — `WHY_LABELS`, `WHY_ORDER`, `WHY_VALUES`/`whyValue`,
`gateWordOf`/`GATE_WORDS`, `ALLOW_WORDS`, `TRUST_LEVEL_LABELS`, `TRUST_LEVEL_HINTS`,
`SEVERITY_LABEL` — live in `@vaubaan/policy-engine` (`risk-words.ts`), beside the severity and the
tier they name. (Since 2026-11-13: `ROW_LABEL`, `ROW_WORDS`, `REASON_WORDS`, `ROW_GATE_SENTENCES`,
`TREE_LEGEND`, beside the row and the reason; see the amendment below.) `lib/vocabulary.ts` re-exports them: it stays the one file a gateway page imports
its words from; the site imports the same values from the package.

### Consequences

- Changing one of those words changes the gateway and the site together; `sources-agree.test.ts`
  (website) fails when either holds a copy.
- Every other word stays in `lib/vocabulary.ts`. A word the site needs is moved to the package
  only when it belongs to the risk model.

### Rejected alternatives

- **A copy in the site checked by a test**: two places to edit, and the test only catches drift
  after the fact.
- **`@vaubaan/shared`**: the trust level type is the policy engine's; the words key on it.

## Amendment 2026-11-13: the severity word is retired

### Context

A permission was printed with one severity word (low, medium, high, critical) summed from six
axes, while its gate came from a tier read otherwise: two measures of risk on one row, which
disagreed, and the word "medium" said nothing a person could act on.

### Decision

Risk is one concept in the interface: the **row** of the permission, named in words (Harmless,
Repairable, worth a look, Repairable, at a price, Cannot be repaired), and the **reason** that put
it there, in quiet type (personal data, costly to undo…), from the decision tree of
[macro-actions-and-trust-levels-prefill-the-policy](macro-actions-and-trust-levels-prefill-the-policy.md)
(amendment 2026-11-13). `SeverityChip` becomes `RowChip`; lists are ordered by row, the hardest to
repair first; "the most severe" becomes "the hardest to repair". The five facts stay behind
"why?" in the Reference only. The words live in `@vaubaan/policy-engine` as before.

### Consequences

- The site's plugin page and `/plugins.json` print the row and its reason; no page, twin or
  answer of the management door carries a severity word or the word "tier".
- Colour follows the row: Harmless plain, rows 2 and above in status colour, row 4 strong.

### Rejected alternatives

- **Keeping the word beside the row**: two measures of one risk, the one people read first being
  the one that decides nothing.
- **Printing the row number**: "row 3" asks the reader to learn a scale; the name says it.

## Amendment 2026-11-14: account, service and plugin are one word everywhere

For these three things the bridge is gone: the code, the store and the protocol say what the
interface says ([one-word-per-thing-account-service-plugin](one-word-per-thing-account-service-plugin.md)).
The other words (permission, key, Waiting for you…) keep their protocol names as above.
