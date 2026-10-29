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
