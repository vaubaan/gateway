---
title: The design tokens — one sheet for the app and the site
tracks:
  - packages/design-tokens/
last_reviewed: 2026-11-22
---

# The design tokens — handbook

How `packages/design-tokens` (`@vaubaan/design-tokens`) produces the token sheet both apps read. Spec: [style guide](../spec/style-guide.md) §3, §6, §7; ADR [design-system-on-shadcn-shared-by-the-app-and-the-site](../decisions/design-system-on-shadcn-shared-by-the-app-and-the-site.md); intent [recognise Vaubaan at a glance](../intents/recognise-vaubaan-at-a-glance.md).

## Start here

- [`src/palette.ts`](../../packages/design-tokens/src/palette.ts) — the one source of every colour (light and dark, as hex) and `CONTRAST_PAIRS`, the documented pairs with their target.
- [`src/render.ts`](../../packages/design-tokens/src/render.ts) — writes `tokens.css` (the variable blocks, plain CSS) and `theme.css` (Tailwind v4: the `dark` variant, `@theme inline`, the base layer, the `row-1…4` utilities).
- [`tests/unit/contrast.test.ts`](../../packages/design-tokens/tests/unit/contrast.test.ts) — the contrast probe: it parses the shipped `tokens.css` and converts its OKLCH back to sRGB itself.

## Invariants

- **The two CSS files are generated and committed**: change `palette.ts`, run `npm run generate --workspace @vaubaan/design-tokens`, commit the three. `sheets.test.ts` fails while a sheet differs from its render; Prettier ignores them (`.prettierignore`).
- **Values are chosen in hex, shipped in OKLCH** (shadcn's and Tailwind v4's form), the hex in a comment; contrast is computed on the rounded OKLCH, so a ratio describes what ships. A test holds the round trip within one step of 255.
- **Themes**: light on `:root`, `.light`, `[data-theme='light']`; dark on `.dark`, `[data-theme='dark']`, and on the system preference when no `data-theme` is set — the app's System/Light/Dark switch before first paint (`apps/gateway/src/lib/theme.ts`). The two dark blocks are identical (a test).
- **A consumer imports, in this order**: `tailwindcss`, `@vaubaan/design-tokens/tokens.css`, `@vaubaan/design-tokens/theme.css`. The fonts are the consumer's: `theme.css` reads `--font-geist-sans` and `--font-geist-mono`, which `geist`'s `next/font` classes set on `<html>`.
- **shadcn's `accent` is a hover fill, not the brand accent**: the brand accent is `primary` (`#2F55C7`), its tinted forms `primary-soft` and `primary-ink`.

## Traps

- **Tailwind's `dark:` variant does not follow the system preference**: it matches `.dark` or `[data-theme='dark']` only. A page without a chosen theme (the site) never writes `dark:`; the tokens change by themselves.
- **A pair added to the interface is added to `CONTRAST_PAIRS`**, never tested elsewhere: a target of `0` is a documented exception (the placeholder ink), not a skipped check.
- **The app imports `theme.css` with `theme(static)`**: Tailwind otherwise emits a theme variable only when a utility or a rule of the same compilation reads it, and the app's CSS modules (compiled apart) read `--text-body`, `--radius-md`… directly. The site needs no such thing.
- **Some shared names were the app's former names with another meaning**: `--accent` is shadcn's hover fill (the brand accent is `--primary`), `--text-xs/sm/base` are Tailwind's own scale. The app renamed where it read them instead of aliasing them (`apps/gateway/src/styles/tokens.css` header).
