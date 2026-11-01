---
title: The public site is a Next.js app of the monorepo on Vercel, generated from the repository at build time
status: accepted
date: 2026-10-16
---

# The public site is a Next.js app of the monorepo on Vercel, generated from the repository at build time

## Context

vaubaan.com carries the landing, user docs, plugin pages with their health, a trust center and the
telemetry collector. What it says about a plugin, a configuration key or a limitation must come
from the repository, with no second source of truth (spec [website](../spec/website.md) §1.1), and
every page must exist as Markdown too. The owner wants no new stack. Handbook
[website](../handbook/website.md).

## Decision

The site is `apps/website`, a Next.js app of the workspace deployed on its own Vercel project. A
build-time generator (`apps/website/scripts/generate.ts`) reads the plugins, handbook tables and
collector schema and writes the pages and their Markdown twins; pages never read the repository
and the site imports nothing from `apps/gateway`.

## Consequences

- A new plugin folder adds its pages and listings with no site edit; a repository change the site
  cannot read fails its build or tests in the same pull request.
- What the site restates from the gateway is compared by a test, not imported.
- `npm run ci` builds and tests the site; a site deploy also redeploys the collector.
- User docs link to the handbooks rather than copying them.

## Rejected alternatives

### Astro Starlight or Docusaurus

A new framework for a team that already runs Next.js.

### A separate repository for the site

A plugin change and its page could not land together.

### Import the plugins from the Next.js pages

The bundler would pull every plugin and its gateway-only constraints (native addons, YAML beside
the module).

## Amendment 2026-11-01 — plugin health is read when a page is served

Reading the collector at build time left the plugin pages at the figures of the last deploy: on
2026-11-01 the site read "not enough reports yet" on all sixteen plugins while the collector held
274 reports, because the pages were built once and every report sat on versions older than the
ones displayed. The generator now reads no network. The pages under `/plugins`, every Markdown
twin, `plugins.json` and `llms-full.txt` are rendered by Next.js with the collector read at
request time and cached for an hour (`apps/website/src/site/live.ts`); a collector that does not
answer gives "not read", never an error page. Everything else stays generated at build time from
the repository. Below the report threshold the pages show the count and the minimum, and beside
the version the plugin's reports over every version, as history (spec §2.4).

Rejected: an hourly redeploy through a deploy hook. It rebuilds the whole site to refresh one
number, and the Vercel plan of the project allows a cron once a day.
