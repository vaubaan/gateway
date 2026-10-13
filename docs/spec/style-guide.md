---
title: Style guide — tokens and interface primitives
status: current
date: 2026-10-13
---

# Style guide — spec

> **Status:** current. Describes the visual vocabulary of the web
> interface ([vaubaan-gateway](./vaubaan-gateway.md) §4.2) and the rules
> a screen must follow. English rewrite of the draft of June 2026,
> checked against the tokens and primitives the interface actually uses;
> where the interface does not yet meet a rule, §8 says so.
>
> **Lineage.** The style follows the tenets of Geist, Vercel's open
> design system: black and white first, hairline borders, generous
> space, restrained typography, very little motion. It is an adoption of
> those tenets, not a copy.

## 0. Vocabulary

Seven terms, distinct and not interchangeable.

- **Token** — a named variable that carries one visual decision. Tokens
  are the only source of visual values.
- **Primitive token** — the lowest layer: a colour step, a size, a
  duration (`gray-200`, `space-4`, `radius-sm`). It says nothing about
  what it is for.
- **Semantic token** — the layer that prescribes a use (`surface-base`,
  `text-muted`, `border-subtle`). It points to a primitive token, and
  which one depends on the theme.
- **Interface primitive** — a shared, atomic component (button, input,
  card, badge, table, banner). Built from semantic tokens only. No screen
  rebuilds one.
- **Surface** — a visual plane, background plus border. Four exist: base
  (the page), raised (cards, panels), overlay (what floats above the
  flow), sunken (inset areas such as code).
- **Hairline** — a one-pixel border told apart only by its luminance.
  The preferred separator.
- **Theme** — one mapping of every semantic token to primitive tokens.
  Two exist: light and dark.

## 1. Vision

The style guide is the non-functional subsystem that:

1. **defines** a bounded visual vocabulary (colour, type, space, radius,
   motion, shadow) as named tokens;
2. **keeps every screen consistent**, by forbidding raw values in
   screens and components;
3. **supports two themes**, light and dark, with the same hierarchy,
   components and states in both;
4. **provides a bounded set of interface primitives** that no screen
   re-implements.

### 1.1 Explicitly out of scope

- **No theme customisation** per user or per instance: no brand colour
  picker.
- **No global density preference.** Density is a property of a
  component, not a user setting.
- **No illustrations or mascots.**
- **No choreographed animation.** Motion is limited to atomic
  transitions of 250 ms at most.
- **No design-tool source of truth.** The tokens in the code are the
  reference.
- **No local redefinition of a token.** If a need has no token, a token
  is added.
- **No separate high-contrast theme.** The AA ratios of §5 are the bar.

## 2. Domain

### 2.1 Layers

```
Primitive tokens          anonymous, no prescribed use
  gray                    14 steps, gray-0 (near white) to gray-1000 (near black)
  blue, green, amber, red 4 steps each: 50, 200, 600, 900
  space                   base 4 px
  radius                  none, xs, sm, md, lg, full
  font size, font weight
  duration, easing
  shadow                  none, sm, md
        │
        ▼
Semantic tokens           prescribe a use; mapped per theme
  surface-base, surface-raised, surface-overlay, surface-sunken
  text-foreground, text-muted, text-subtle, text-inverse
  border-subtle, border-strong
  accent-{info,success,warning,danger}-{bg,fg}
  primary-bg, primary-fg, primary-bg-hover
  focus-ring
        │
        ▼
Interface primitives      consume semantic tokens only
```

### 2.2 Colour

**Neutral scale.** Fourteen grays in a perceptually uniform colour space
(OKLCH), with no chroma: `gray-0`, `20`, `50`, `100` to `900` by
hundreds, `980`, `1000`. The extra steps at both ends give the surfaces
of each theme their small differences in lightness.

**Accents.** Four families, one per status, four steps each:

| Family  | Status  | Used for                                         |
| ------- | ------- | ------------------------------------------------ |
| `blue`  | info    | information, a neutral notice                    |
| `green` | success | a healthy state, a completed operation           |
| `amber` | warning | a degraded state, an action that needs attention |
| `red`   | danger  | an error, a destructive action                   |

A status is always used as a **pair** of semantic tokens, background and
foreground: `accent-warning-bg` with `accent-warning-fg`. In the light
theme the pair is the lightest step under the darkest; in the dark theme
the reverse. No component references a family step directly.

**Primary action.** The primary button is the inverse of the page, not
an accent: near black on a light page, near white on a dark one
(`primary-bg`, `primary-fg`, `primary-bg-hover`).

### 2.3 The two themes

| Semantic token    | Light       | Dark        |
| ----------------- | ----------- | ----------- |
| `surface-base`    | `gray-0`    | `gray-1000` |
| `surface-raised`  | `gray-20`   | `gray-980`  |
| `surface-overlay` | `gray-0`    | `gray-900`  |
| `surface-sunken`  | `gray-50`   | `gray-1000` |
| `text-foreground` | `gray-1000` | `gray-0`    |
| `text-muted`      | `gray-600`  | `gray-300`  |
| `text-subtle`     | `gray-400`  | `gray-500`  |
| `text-inverse`    | `gray-0`    | `gray-1000` |
| `border-subtle`   | `gray-100`  | `gray-800`  |
| `border-strong`   | `gray-300`  | `gray-600`  |

The theme is selected by one attribute on the root of the document. No
component declares its own colours per theme. **The interface is served
in the light theme**; the dark mapping is defined and complete, and is
what applies when the attribute is absent. There is no switch (§7.2).

### 2.4 Typography

| Token       | Family     | Use                                                          |
| ----------- | ---------- | ------------------------------------------------------------ |
| `font-sans` | Geist Sans | all interface text                                           |
| `font-mono` | Geist Mono | technical identifiers: refs, `RiskId`s, slices, tokens, code |

Both families are bundled with the application; the system fonts are the
fallback.

Scale, relative to the root size:

| Token       | Size   | Token      | Size  |
| ----------- | ------ | ---------- | ----- |
| `text-xs`   | 0.75   | `text-lg`  | 1.125 |
| `text-sm`   | 0.8125 | `text-xl`  | 1.5   |
| `text-base` | 0.875  | `text-2xl` | 2     |
| `text-md`   | 1      | `text-3xl` | 2.5   |

The root size is 125 % of the browser default, so the whole scale renders
a quarter larger than its nominal values. Body text is `text-base`.
Weights: regular 400, medium 500, semibold 600, bold 700.

**At most three sizes on one screen.** The usual hierarchy is a title, a
body and a meta line. Contrast comes from weight and colour before size.

### 2.5 Space

A scale on a 4 px base: `space-0` (0), `1` (4), `2` (8), `3` (12), `4`
(16), `5` (20), `6` (24), `8` (32), `10` (40), `12` (48), `16` (64),
`24` (96).

Three densities, chosen per component:

| Density       | Inner padding | Gap between fields | Where                           |
| ------------- | ------------- | ------------------ | ------------------------------- |
| _comfortable_ | `space-6`     | `space-4`          | first-run screens, single forms |
| _default_     | `space-4`     | `space-3`          | most screens                    |
| _compact_     | `space-2`     | `space-1`          | tables, dense lists             |

### 2.6 Radius and borders

| Token         | Value  | Use                               |
| ------------- | ------ | --------------------------------- |
| `radius-none` | 0      | full-width tables, inset sections |
| `radius-xs`   | 2 px   | narrow inline elements            |
| `radius-sm`   | 4 px   | badges                            |
| `radius-md`   | 6 px   | buttons, inputs, banners          |
| `radius-lg`   | 10 px  | cards, dialogs                    |
| `radius-full` | 999 px | pills, avatars                    |

**Borders before shadows.** A hairline in `border-subtle` separates;
`border-strong` marks hover and emphasis. Shadows (`shadow-sm`,
`shadow-md`) are allowed only on overlay surfaces.

### 2.7 Motion

Three durations: `duration-fast` (100 ms), `duration-base` (150 ms),
`duration-slow` (250 ms). One easing, ease-out, with no bounce and no
spring. Transitions apply to colour, background, border colour, opacity
and transform only, never to width or height.

### 2.8 Focus

`focus-ring` is a double ring: a gap in the colour of the page, then a
neutral ring that contrasts with it in each theme. It is neutral on
purpose, so that it is never mistaken for a status. Focus is never
removed, only replaced by the ring; it shows on keyboard focus for
buttons, links, inputs, selects and text areas.

## 3. Format / Layout

### 3.1 Where tokens live

Tokens live in **one root style sheet**, exposed as custom properties
resolved at run time. Components are styled in files scoped to the
component, which reference tokens and nothing else.

### 3.2 Page frame

Every page sits in one container, centred, with a fixed maximum width
and the same outer padding. Headings have three levels, set once
globally.

### 3.3 Interface primitives

| Primitive               | Variants and parts                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Button**              | `primary`, `secondary` (default), `ghost`, `danger`; sizes `sm`, `md`; states hover, focus, disabled, loading |
| **Input**               | text input, text area, select, and a **field** wrapper that carries the label, a hint and the error           |
| **Card**                | raised surface with a hairline; optional header with a title, and a body                                      |
| **Badge**               | tones `neutral`, `info`, `success`, `warning`, `danger`; an optional monospace form for identifiers           |
| **Banner**              | same five tones; optional title; in the flow of the page, not dismissible                                     |
| **Table**               | head on a sunken surface, hairline between rows, row highlight on hover                                       |
| **Code**                | inline technical text in the monospace family                                                                 |
| **Layout**              | the page container, and a vertical stack with a gap taken from the space scale                                |
| **Danger confirmation** | a modal for terminal actions: the user types a given phrase before the action is enabled; Escape cancels      |

There is no link-styled button: a link is a link. An input has no
success state: the absence of an error is enough.

### 3.4 Not provided

Generic dialog, tooltip, dropdown menu, tabs, toast. Errors and results
are shown inline, in a banner or beside the field.

## 4. Composition

A feature screen uses **only** semantic tokens and interface primitives.
When a screen needs something neither provides, the order is:

1. state the need;
2. extend this guide (a token, a variant, a primitive);
3. then build the screen.

Not "hard-code it now and factor it later".

## 5. Accessibility

- **AA contrast at least** between `text-foreground` and `surface-base`
  in both themes. `text-muted` may fall to AA for large text, not below.
- **Focus always visible** (§2.8).
- **Never colour alone** for a status: a badge or a banner carries its
  text.
- **Reduced motion is respected**: when the user asks for it,
  transitions take no time and the end state is the same.
- **Click targets of 32 px at least**, in every density.
- **Modals** take focus when they open, are labelled, and close on
  Escape.

## 6. Tests

Tokens are the specification; tests check what emerges from them, not
"this button is black":

- a **contrast probe** over the documented text and surface pairs, in
  both themes;
- a **gallery** rendering each primitive in each variant, state and
  theme, compared visually on change.

Neither exists yet (§8).

## 7. Decisions and open questions

### 7.1 Settled

- Two themes, light and dark, defined with strict parity.
- Geist Sans and Geist Mono, bundled.
- Four statuses: info, success, warning, danger; plus neutral.
- OKLCH as the colour space of the primitive scales.
- Hairline before shadow.
- A neutral focus ring.
- Primitives written for this interface, styled per component, with no
  component library.

### 7.2 Open

- **Theme selection.** Follow the system preference, offer a switch that
  is remembered, or both. Today the light theme is fixed.
- **Icons.** None is used. If a set is introduced it must be a single,
  neutral one.
- **The primitives of §3.4.** When, and triggered by which screen.

## 8. Known gaps between this guide and the interface

Stated so that nobody takes a rule for a fact:

- **Reduced motion** (§5) is not handled.
- **The small button** is 26 px high, under the 32 px target (§5).
- **Raw values remain** in component styles: paddings and heights of
  buttons, badges and table cells are written in pixels rather than with
  space tokens; the backdrop of the danger confirmation is a raw
  translucent black; text selection uses primitive grays directly.
- **The danger confirmation** takes focus and closes on Escape, but does
  not trap focus inside itself.
- **No contrast probe and no gallery** (§6).
- **The dark theme** is defined but not reachable from the interface
  (§2.3).
