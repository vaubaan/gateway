---
title: A service's icon and brand colour are fields of its plugin, never a map in the interface
status: accepted
date: 2026-10-27
---

# A service's icon and brand colour are fields of its plugin, never a map in the interface

## Context

People know cloud services by their logo, in its colour, and public-domain brand paths and hex
colours (Simple Icons, CC0, 24×24) exist for most shipped plugins. The provider list has one
source, the plugin registry, and third-party plugins must be able to bring their own mark. How the
mark is drawn: spec [style-guide](../spec/style-guide.md).

## Decision

`ProviderPlugin.icon?` (the `d` of one SVG path on a 24×24 grid) and `iconColor?` (`#RRGGBB`) are
validated by `definePlugin` and required of every shipped plugin (`plugin-icons.test.ts`). Each
plugin vendors both in `src/icon.ts` with a comment naming the source; the registry carries them
together as a `ServiceIcon` to every provider view model.

## Consequences

- A page never looks a provider up for its icon or colour; it reads the view model.
- A third-party plugin without an icon still registers and shows a lettered fallback; one without
  a colour is drawn in the secondary ink.
- No icon package is a dependency; a service without a public brand gets a hand-drawn mark and a
  colour chosen once (Context7, SSH).
- The dark-theme colour is derived by the interface from the declared one (a near-black brand
  takes the ink); a plugin declares one colour.

## Rejected alternatives

### A provider → icon or colour map in the interface

A second provider list that drifts from the registry.

### A runtime dependency on `simple-icons`

Thousands of icons in the image for a dozen paths, nothing for the services it lacks.

### Monochrome marks in the secondary ink

Tried first (2026-10-23): grey logos all look alike and are not recognised at a glance.

### A second, plugin-declared colour for the dark theme

A field no plugin author would fill correctly; the luminance rule gives the same result for every
near-black brand.
