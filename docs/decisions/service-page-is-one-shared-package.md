---
title: A service's page is one shared package, drawn by the site and by the gateway's Reference
status: accepted
date: 2026-11-15
---

# A service's page is one shared package, drawn by the site and by the gateway's Reference

## Context

The public site drew each plugin's page (`/plugins/<id>`, the Atlas layout) from the plugin; the
gateway drew its own Reference (`/reference/<id>`) from the same plugin with other code, other
sections and other words. Two pages told the same story differently and drifted. The owner,
2026-11-15: "In the gateway, Reference must show exactly the doc page of that plugin." An instance
may run offline or on-prem, and may run a pinned plugin older or newer than the site's.

## Decision

- **One package, `packages/plugin-page` (`@vaubaan/plugin-page`)**: the data builder
  (`pluginInfo(plugin, context)` over the object `definePlugin` returns), the page data, the React
  view (`ServicePage`) and its style sheet. Both apps render it; neither forks it.
- **Each app hands in what only it knows**, through the context and the props: where a screenshot
  and a link go (the site's paths, or the gateway's `docs.url`), the source link, the heading
  level, the crumbs, an aside to the title, more of the counts line, its own sections after
  connecting, its foot. Nothing of either app is written in the package.
- **The gateway builds the page at run time from its registry**, so the page is the one of the
  plugin version the instance runs, bundled or pinned; its own facts stay in a strip above.
- **The sheet reads `--pp-*` custom properties only**, every rule scoped under `.plugin-page`;
  each app maps them to its tokens, light and dark. The toggles stay CSS-only.

## Consequences

- A section or a word changed in the package changes both pages; the site's twin reads the same
  page data. The gateway's Reference loses its tabs, filters and per-permission unfolding: what
  the page does not show is not shown.
- The package's main entry imports no plugin SDK at run time (the site renders saved data);
  `/info` and `/load` do.
- The gateway's other pages keep linking `#risk-<id>` and `#macro-<id>`: the page gives each one.

## Rejected alternatives

- **An iframe of vaubaan.com**: breaks offline and on-prem instances, shows the site's version of
  the plugin rather than the pinned one, and mixes origins in the interface.
- **Shared MDX content**: the page is built from the catalog and the policy engine, not prose; MDX
  would still need the same components on both sides, and a second renderer for the site's twin.
- **Keeping two pages, tested for agreement**: the drift the owner asked to end, with a test that
  could only compare what both chose to show.
