---
title: A service mark is drawn in the brand colour its plugin declares
status: accepted
date: 2026-10-27
amends:
  - service-icons-declared-by-the-plugin
---

# A service mark is drawn in the brand colour its plugin declares

> Product owner's decision of 2026-10-27 ("put all the provider icons back in
> colour rather than grey"). Amends
> [service-icons-declared-by-the-plugin](./service-icons-declared-by-the-plugin.md),
> whose point 3 ("the interface shows it monochrome") no longer holds. Spec:
> [style-guide §5 "Service mark"](../spec/style-guide.md). Handbooks:
> [plugin-sdk, "`ProviderPlugin`"](../handbook/plugin-sdk.md#providerplugin-plugints),
> [web-app, "Marks"](../handbook/web-app.md).

## Context

Since 2026-10-23 a service is shown by the brand icon its plugin declares,
drawn in the secondary ink on a neutral fill. The reasoning was the attention
budget: colour is reserved for the primary action and for a status that
differs from normal, and a page of accounts in six brand colours would shout.

Four days of use said otherwise. Grey marks all look alike at a glance; the
reader scans the Accounts page, the mission form and the connect picker by
the logo they know, and a logo is known in its colour. The icon is still
decoration (`aria-hidden`, the name always beside it), so nothing is lost for
assistive technology; what is gained is recognition. The two rules that
framed the previous decision stand: the plugin registry is the one source of
truth for what a provider is (no provider → colour list in the interface),
and a mark is never a status.

Two things make colour less simple than it looks. Several brands are black or
near black (GitHub `#181717`, Notion, Vercel and Resend `#000000`, Railway
`#0B0D0E`, Miro `#050038`, Fly.io `#24175B`): on the dark paper they vanish.
And two shipped services have no brand (Context7, SSH): their hand-drawn marks
need a colour chosen once.

## Decision

1. **The colour is a field of the plugin contract, beside the icon.**
   `ProviderPlugin.iconColor?: string` is one sRGB colour as `#RRGGBB`,
   validated by `definePlugin` (`HEX_COLOUR_PATTERN`) when present, optional
   in the type, and **required of every plugin the image ships** by the
   structural test `plugin-icons.test.ts`, next to the icon.
2. **Each plugin vendors its colour as it vendors its path.** A constant in
   `src/icon.ts` (`<PROVIDER>_ICON_COLOR`) with a one-line comment naming its
   source: Simple Icons' hex for the brands it publishes, a colour chosen
   here for the two services without a brand (Context7 a violet `#5B5BD6`,
   SSH a terminal green `#16A34A`). No runtime dependency on an icon package.
3. **The registry carries path and colour together.** `ServiceIcon`
   (`{ path, color }`) replaces the bare path wherever a view carried one
   (`ProviderLabel.icon`, `ProviderCard.icon`, `ConnectableProvider.icon`,
   `ConnectionView.providerIcon`, `ReceivedShare.providerIcon`), built by
   `serviceIconOf(plugin)`; a colour without an icon draws nothing. A page
   never looks a provider up to find its colour.
4. **The interface draws the icon in that colour on the neutral fill.**
   `ServiceMark` keeps the square of `--fill` and sets the glyph's colour from
   the mark (`--mark-color`); without a colour the glyph keeps the secondary
   ink, as before. The mark stays `aria-hidden` and is never a status.
5. **A near-black brand takes the ink in the dark theme.** `ServiceMark`
   computes the dark-theme colour once (`darkThemeMarkColor`): the brand
   colour when its relative luminance (WCAG 2) is 0.1 or more, `var(--ink)`
   below. The stylesheet reads `--mark-color-dark` under `[data-theme='dark']`
   and under the system's dark scheme when no theme is chosen, the same two
   selectors as the tokens. GitHub's `#181717` (luminance 0.006) and Fly.io's
   `#24175B` (0.017) turn to the ink; Stripe's `#635BFF` (0.17), the darkest
   colour kept, stays.
6. **A person keeps the lettered avatar on a hue; a service without an icon
   keeps two letters on a hue.** Unchanged. The hues still say "someone"; the
   brand colour says "this service".

## Consequences

- Every shipped plugin gains `iconColor` and a patch version (telemetry
  reports the plugin version; a published change bumps it).
- `ServiceIcon` is a type change for anything that read `ProviderCard.icon`
  or `ConnectionView.providerIcon` as a string; inside the repository the
  only readers are `ServiceMark` and the gallery page.
- The style guide's rule "colour only for the accent and for a status that
  differs from normal" gains one named exception: the brand colour of a
  service mark, which carries no meaning and is never read as a state.
- A third-party plugin with an icon and no colour is still shown, in the
  secondary ink. The structural test holds the plugins of this repository to
  the rule, not the contract.
- Attribution: Simple Icons publishes the hex beside each path under the same
  CC0 1.0; the brands remain the property of their owners, and drawing a
  logo in its own colour on a neutral fill is the use their brand pages allow
  for "integrates with" marks.

## Rejected alternatives

- **Keeping the marks monochrome** (the previous decision). Four days of use
  showed that grey logos are not recognised at a glance; the owner reversed
  it.
- **A provider → colour map in the interface.** The same second list the
  icon decision refused: it drifts from the registry the day a plugin is
  added.
- **Inverting near-black brands in the dark theme by CSS filter**
  (`filter: invert()`). Inverts every colour, so a coloured brand would come
  out wrong; and a filter is applied to all or none. Computing one dark
  colour from the luminance keeps the coloured brands as they are.
- **Dropping the neutral square behind the glyph.** The square gives every
  mark the same footprint and keeps a light brand (Supabase, Upstash) legible
  on the white paper. Kept.
- **Letting the plugin declare a second colour for the dark theme.** A field
  no plugin author would fill correctly; the luminance rule needs nothing
  from them and gives the same result for every near-black brand.
