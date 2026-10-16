---
title: The public site is a Next.js app of the monorepo, on a new Vercel project
status: accepted
date: 2026-10-16
extends:
  - repository-layout-and-contribution-workflow
---

# The public site is a Next.js app of the monorepo, on a new Vercel project

> Structural choices for the site of spec [website](../spec/website.md).
> Accepted by the product owner on 2026-10-16.

## Context

vaubaan.com is the domain of the retired v4 SaaS, whose Vercel project has
been paused since 2026-10-15. The domain is to carry the open source
project's landing, user docs, plugin pages with their health, a trust
center, and the telemetry collector
([[telemetry-two-levels-behind-a-vercel-collector]]).

The site is mostly static. Its plugin pages must come from `plugins/*/`, so
that the plugin list has one source. The product owner is reluctant to
start a stack the team does not already use (Astro Starlight was
considered), and wants the site, the docs and the collector on Vercel.

## Decision

### D1 — `apps/website`, a Next.js app of the workspace

Same framework, TypeScript settings, lint and test tooling as
`apps/gateway`. Pages are statically generated; the only server code is the
collector's route handlers (D4). The app may import `@vaubaan/telemetry`
and read the plugins' declarations and `risk-catalog.yaml` at build time; it
imports nothing from `apps/gateway`.

### D2 — User docs as MDX under `apps/website/content/docs`, rendered by Fumadocs

Fumadocs is a library for Next.js (MDX loading, sidebar, offline full-text
search, table of contents), not a separate framework. User docs live next to
the site, in English. The repository's handbooks stay where they are, for
contributors; a user doc links to them rather than copying them. Pages that
describe a plugin are generated from the plugin, then completed by hand
where a human step is needed (registering the company's app).

### D3 — A new Vercel project, the v4 project left paused

A new project rooted at `apps/website`, with `vaubaan.com` and
`telemetry.vaubaan.com` moved to it at launch (spec [website](../spec/website.md) §4).
The v4 project and its database backup are left as they are. No Log Drain
and no Observability Plus on this project
([[telemetry-two-levels-behind-a-vercel-collector]] D5). No analytics, no
cookie, no third-party script.

### D4 — The collector is a route of the same app, on its own host

`/v1/reports` and `/v1/plugin-stats` answer only on `telemetry.vaubaan.com`;
on `vaubaan.com` they are 404. One deployment, one set of dependencies; the
constraint of D3 on logs applies to the whole project.

### D5 — The site's CI is the repository's CI

`npm run ci` builds and tests the site like any workspace. A change to a
plugin's catalog that breaks the site's build fails the pull request that
made it.

## Consequences

Positive:

- No new stack: the people and tools that maintain the gateway maintain the
  site.
- One pull request can change a plugin, its user doc and its page.
- The collector needs no infrastructure beyond the site's.

Negative:

- Next.js is heavier than a static site generator for a mostly static site:
  more dependencies in the lockfile, which the dependency audit gate also
  covers.
- The collector shares a deployment with the site: a site deploy redeploys
  the collector, and a log setting meant for the site applies to it.
- User docs and handbooks can drift apart; the drift detector covers
  handbooks only today.

## Rejected alternatives

### Astro Starlight

Lighter and made for docs, but a new framework for the team, refused by the
product owner.

### Docusaurus

A docs standard, also a new framework, and less suited to a custom landing.

### Cloudflare Pages and a Worker for the collector

Would let the collector's logs be switched off. Refused for one vendor and
one stack ([[telemetry-two-levels-behind-a-vercel-collector]]).

### A separate repository for the site

Plugin pages would need the gateway's repository at build time anyway, and
a plugin change and its docs could no longer land together.

### Unpausing the v4 project

Its settings, environment and history belong to a retired product.

## References

- Spec: [website](../spec/website.md).
- Related: [[telemetry-two-levels-behind-a-vercel-collector]],
  [[repository-layout-and-contribution-workflow]].
