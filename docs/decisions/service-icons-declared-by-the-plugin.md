---
title: A service is shown by the brand icon its plugin declares, monochrome
status: accepted
date: 2026-10-23
amends:
  - plugin-contract-and-credential-spec
---

# A service is shown by the brand icon its plugin declares, monochrome

> Product owner's decision of 2026-10-23 ("replace the cloud service icons by
> the real icons, but monochrome"). Spec:
> [style-guide §3.1, §5](../spec/style-guide.md). Handbooks:
> [plugin-sdk, "`ProviderPlugin`"](../handbook/plugin-sdk.md#providerplugin-plugints),
> [web-app, "Marks"](../handbook/web-app.md).

## Context

The web interface marks a service — on Accounts, in the connect picker, in
Reference, on an account's page — with `ServiceMark`: two letters taken from
the plugin's display name (GitHub → GH, Upstash Redis → UR) on one of the five
hues the name hashes to, the same device as a person's avatar. Two letters on
a hue read as a person, not as a service; two services can land on the same
hue; and the letters are a code the reader has to learn ("UR"?). People know
the cloud services they use by their logo.

The brand icons exist as public-domain vector paths (Simple Icons, CC0 1.0,
24×24 grid) for twelve of the fourteen shipped plugins. Two plugins have no
such icon (Context7, SSH). The owner's rule on provider lists stands: there is
one source of truth for what a provider is, the plugin registry — never a
second list kept in the interface (ADR
[plugin-contract-and-credential-spec](./plugin-contract-and-credential-spec.md),
D6).

## Decision

1. **The icon is a field of the plugin contract.** `ProviderPlugin.icon?:
string` is the `d` attribute of one SVG path on a 24×24 grid, drawn to be
   filled with `currentColor`. It is optional in the type (a plugin written by
   someone else still registers and shows without one), validated by
   `definePlugin` as a non-empty string when present, and **required of every
   plugin the image ships** by a structural test (`plugin-icons.test.ts`).
2. **Each plugin vendors its path.** The path is a string constant in the
   plugin (`src/icon.ts`), with a one-line comment naming its source ("Simple
   Icons, CC0 1.0, `<slug>`"). No runtime dependency on an icon package: a
   plugin stays self-contained and imports `@vaubaan/plugin-sdk` only. The
   two services without a public icon carry a mark drawn by hand on the same
   grid (Context7: a 7 in a frame; SSH: a terminal prompt `>_`).
3. **The interface shows it monochrome.** `ServiceMark` renders the path
   inside a square of the neutral fill (`--fill`) in the secondary ink
   (`--ink-2`); no brand colour, no hue. The icon is decoration and carries
   no meaning: it is never a status, and `aria-hidden` — the service's name
   is always printed beside it. Without an icon, the two lettered letters on a
   hue remain as the fallback.
4. **The registry carries it to every page.** `ProviderLabel.icon`,
   `ProviderCard.icon` (so `ProviderReference`), `ConnectableProvider.icon`,
   and `ConnectionView.providerIcon` / `ReceivedShare.providerIcon` are
   built where the label already is, from the registry; a page never looks a
   provider up to find its icon.
5. **A person keeps the lettered avatar on a hue.** The hues now say
   "someone", the monochrome icon says "a service"; the shape and the colour
   together tell them apart.

## Consequences

- Every shipped plugin gains `icon` and a patch version (telemetry reports the
  plugin version; a published change bumps it).
- The `--hue-*` tokens are read by person avatars and the fallback mark only.
- The gallery (`/design`) receives the shipped icons from the server page and
  shows a few real ones beside the fallback.
- A third-party plugin without an icon is not refused: it shows two letters.
  The structural test holds the plugins of this repository to the rule, not
  the contract.
- Attribution: Simple Icons is CC0 1.0 (no attribution required); the comment
  on each path keeps the provenance for the next person. The brands remain the
  property of their owners; drawing them in one colour on a neutral fill is
  the use their brand pages allow for "integrates with" marks.

## Rejected alternatives

- **A provider → icon map in the interface** (`components/ui/service-icons.ts`).
  A second list of providers that drifts from the registry the day a plugin is
  added; the owner's rule forbids it.
- **A runtime dependency on `simple-icons`** (import `siGithub.path` in the
  plugin or in the app). Pulls ~3,000 icons into the image for 12 paths, ties
  every plugin's build to a package release, and gives nothing for the two
  services the set does not have.
- **Coloured brand icons.** The brand colours (GitHub black, Stripe purple,
  Supabase green) are the one thing the style guide reserves colour for: an
  exception that needs the reader. A page of accounts in six brand colours
  would shout; and two of the five hues of the palette are near a status
  colour. Monochrome keeps the icon a mark.
- **Keeping the two letters.** The reason for the change.
