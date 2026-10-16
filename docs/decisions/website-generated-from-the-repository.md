---
title: The site is generated from the repository at build time, and every page has a Markdown twin
status: proposed
date: 2026-10-16
extends:
  - website-nextjs-on-vercel
---

# The site is generated from the repository at build time, and every page has a Markdown twin

> How the first version of vaubaan.com (spec [website](../spec/website.md)
> §2) gets its content without a second source of truth, within the stack of
> [[website-nextjs-on-vercel]]. Proposed by the coding agent on 2026-10-16,
> to be confirmed by the product owner.

## Context

Spec §1.1 forbids a second source of truth: what the site says about a
plugin, a configuration key or a limitation must come from the repository.
Spec §2.6 asks that every docs, plugin and trust page exist as Markdown at
the same path plus `.md`, and on `Accept: text/markdown`, with `llms.txt`,
`llms-full.txt` and `/plugins.json` generated from the same source.

Three facts constrain the how:

- a plugin's tools, version and experimental flag are TypeScript (its
  `definePlugin` declaration); only its catalog is YAML. Reading the plugins
  "the way the gateway does" means importing their entry modules;
- ADR [[website-nextjs-on-vercel]] D1 says the app imports nothing from
  `apps/gateway`, yet the configuration keys live in the gateway's `KEYS`
  table and the severity word of a permission in its `catalog-view.ts`;
- the collector routes need `COLLECTOR_HOST` at request time; the static
  pages must build without it.

## Decision

### D1 — A build-time generator, run before `next build`

`apps/website/scripts/generate.ts` (run by `npm run generate`, which `dev`,
`build` and `type-check` call first) imports every `plugins/<name>/` package
whose name does not start with `_` through its `exports` entry, reads the
configuration handbook's key table, the known limitations, the threat model,
the collector's `schema.sql`, and the collector's public aggregates (4 s
timeout; any failure reads "not enough reports yet"). It builds the whole
site as data (`src/content/build-site.ts`, pure but for reading files) and
writes three gitignored outputs: the generated docs pages under
`content/docs/` (marked `generated: true`), `public/` (twins, `llms.txt`,
`llms-full.txt`, `plugins.json`, `sitemap.xml`, `robots.txt`) and
`.generated/site.json`, which the pages read. Next.js pages never read the
repository themselves.

### D2 — One Markdown string per page, rendered as HTML and served as `.md`

- **Docs**: hand-written MDX under `content/docs` that is plain Markdown (no
  import, component or expression outside code, checked by the generator and
  a test), so a page's twin is its own source. Generated docs pages
  (configuration keys, known limitations, one "Connect <service>" page per
  plugin) keep their canonical Markdown in memory for the twin and are
  written to disk escaped for MDX.
- **Plugins, plugin health, trust center**: Markdown built by functions of
  `src/content/`, rendered on the server by Fumadocs' Markdown renderer
  (`fumadocs-core/content/md`) and written as the twin.
- The landing is a React page; its words and questions live in
  `src/site/landing.ts`, rendered by the page, put in the FAQPage JSON-LD and
  written as `/index.md`.

### D3 — Fumadocs headless: `fumadocs-core` and `fumadocs-mdx`, no `fumadocs-ui`

The docs use Fumadocs' MDX compiler, page tree, table of contents and
neighbours; the navigation and the layout are the site's own server
components on the site's one token sheet. `fumadocs-ui` would bring Tailwind
and a design of its own, against the style guide's tokens. Syntax
highlighting is off: code blocks are tokens, not a theme's colours. No search
box in the first version (it would need client JavaScript and an index).

### D4 — What the site copies from the gateway is compared, not imported

- **Configuration keys**: read from the handbook's key table, which the
  gateway's `keys-doc.test.ts` holds to `KEYS`; the site's
  `sources-agree.test.ts` compares the page with `KEYS` directly.
- **Thresholds**: read from `plugin_validation_thresholds()` in
  `deploy/collector/schema.sql`; a test pins 200 / 90 % / 90 days and the
  README's table.
- **Severity word**: `src/content/severity.ts` restates the gateway's
  computation; a test compares both over all 1 296 vectors.

### D5 — The proxy decides by host and by `Accept`, at request time

`src/proxy.ts`: on `COLLECTOR_HOST` only `/v1/*` exists (and a robots.txt
that disallows everything); elsewhere, a docs, plugin or trust page asked
with `Accept: text/markdown` (not ranked below `text/html`) is rewritten to
its twin. Without `COLLECTOR_HOST` the proxy changes nothing, so the static
build needs no collector variable.

## Consequences

Positive:

- Adding a plugin folder adds its plugin page, its connect page, its line in
  `llms.txt`, `plugins.json` and the sitemap, with no edit to the site.
- A change to a catalog, a key or the threat model that the site cannot read
  fails the site's build or its tests in the same pull request (ADR
  [[website-nextjs-on-vercel]] D5).
- Every page is readable without JavaScript, and by an agent as Markdown.

Negative:

- The build imports every plugin, so the site's build needs the plugins'
  dependencies installed; the Vercel project must include the files outside
  `apps/website`.
- The proxy runs on every request: each visit is a function invocation on
  Vercel, and Vercel logs it with the visitor's address for the plan's log
  window (stated on the trust center).
- `severity.ts` is a copy held by a test; moving `severityOf` into
  `@vaubaan/policy-engine` would remove it.
- Plugin health is as fresh as the last deployment, not hourly as spec §2.4
  says; a scheduled redeploy, or a dynamic health route, would close that.
- Sitemap dates come from `git log`; on a shallow clone the older files have
  no date and the sitemap omits it.

## Rejected alternatives

### Import the plugins from the Next.js pages

Turbopack would bundle every plugin and its dependencies into the site's
build graph, and the gateway-only constraints of the plugins (native addons,
YAML read next to the module) would become the site's problem.

### Twins as route handlers instead of files

A `/[...path].md` route conflicts with the docs' catch-all route; files in
`public/` are served before dynamic routes and cost no function.

### `fumadocs-ui`

Faster to start, but a second design system (Tailwind, its own colours and
fonts) beside the style guide.

### Read `COLLECTOR_HOST` in `next.config.ts` (rewrites with a `host` condition)

No function per request, but the host would be frozen at build time and a
build without the variable would serve the site on the collector's host.

## References

- Spec [website](../spec/website.md) §1.1, §2, §2.6.
- ADR [[website-nextjs-on-vercel]].
- Handbook [website](../handbook/website.md).
