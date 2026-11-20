---
title: The app and the site share one design system built on shadcn/ui, its tokens in one package
status: accepted
date: 2026-11-20
author: Renaud Pelissier (product owner), drafted with Claude
---

# The app and the site share one design system built on shadcn/ui, its tokens in one package

## Context

The app's components were written by hand on CSS modules, and the site kept its own stylesheet:
two accents in production (`#2F55C7` on the site, a sky blue in the app), no shared component, and
dialogs, menus and tabs carrying hand-written accessibility. The brand moved to "Trace" with one
accent, and the site will grow pages (tutorials, references, the author guide) that need the same
parts as the app.

## Decision

Both apps build on shadcn/ui: its primitives (Radix underneath) are copied into the repository and
owned, styled by one token sheet published from a shared package and read by Tailwind v4. Domain
components (the row of a permission, the gate, the trust level picker, the approval, the refusal,
the mission, the service mark, the meter) are written for Vaubaan on those primitives; the style
guide's rules stay the reference over shadcn's defaults.

## Consequences

- A colour, size or radius has one source, the shared token package; neither app defines its own.
- The app migrates component by component behind the same exports of `components/ui`, its former
  token names aliased onto the new ones; the `/design` gallery and its browser test guard each
  step. The site moves first.
- The style guide's token test reads the shared sheet (OKLCH included) and its contrast pairs come
  from the same generated list.
- An upstream shadcn change reaches us only when we copy it; nothing is imported at run time from
  a third party.

## Rejected alternatives

### Keep hand-written components and adopt only shadcn's token names

One palette in both apps, but no shared component, no Radix accessibility, and the site still
rebuilds what the app has.

### Rewrite every component in one change

Touches a hundred importing files at once, blocks other interface work, and makes a visual
regression hard to bisect.
