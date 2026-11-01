---
title: The public site — vaubaan.com, generated from the repository
tracks:
  - apps/website/scripts/generate.ts
  - apps/website/src/content/
  - apps/website/src/site/
  - apps/website/src/app/
  - apps/website/src/proxy.ts
  - apps/website/content/docs/
  - apps/website/next.config.ts
  - apps/website/package.json
  - apps/website/tests/unit/site/
last_reviewed: 2026-11-01
---

# The public site — handbook

How `apps/website` builds vaubaan.com from the repository at build time, and reads plugin health when a page is served. Spec: [website](../spec/website.md) §2; ADR [website-nextjs-on-vercel](../decisions/website-nextjs-on-vercel.md); the collector sharing the app: [telemetry](telemetry.md).

## Start here

- [`scripts/generate.ts`](../../apps/website/scripts/generate.ts) — the build-time generator; `npm run build`, `dev` and `type-check` all run it first. It reads no network.
- [`src/content/build-site.ts`](../../apps/website/src/content/build-site.ts) — `buildSite()`, every page and public file from what `src/content/` reads in the repository.
- [`src/site/live.ts`](../../apps/website/src/site/live.ts) — what is rendered at request time: the pages under `/plugins`, every Markdown twin (`app/twins`), `plugins.json` and `llms-full.txt`, with the collector read and cached an hour.
- [`src/proxy.ts`](../../apps/website/src/proxy.ts) — the collector host gate and the rewrite of `.md` addresses and `Accept: text/markdown` to the twins route.
- [`content/docs/`](../../apps/website/content/docs/) — the hand-written docs; `meta.json` orders the sidebar.

## Invariants

- **The site reads the repository, not a copy.** Plugins are loaded through their `exports["."]` and validated by `definePlugin` and the catalog loader as at gateway boot; the configuration key table, [known-limitations](known-limitations.md), the [threat model](threat-model.md) (`trust.ts`) and the thresholds of `deploy/collector/schema.sql` are parsed from their files. Reshaping one of those docs can break the site: grep `apps/website/src/content/` first.
- **`sources-agree.test.ts`** checks the key page against `KEYS`, the thresholds against the collector README, and the severity word against the gateway's over every vector.
- **Every page has a Markdown twin** (`/index.md`, `/docs/….md`), listed in `llms.txt`; the proxy serves the twin when `Accept` ranks `text/markdown` above `text/html`.
- **Health is never invented, and never a rate below the threshold**: a failed or skipped collector read (`VAUBAAN_SITE_OFFLINE=1`) gives no row and the pages say "not read"; below `min_reports` they show the count and the minimum; the "all versions" figure is a sum of reports, never a verdict. `healthOf()` is the one place that decides.
- **Health is read when a page is served, once an hour for the whole site**: every route that imports `src/site/live.ts` exports `revalidate = 3600` (`live.test.ts` keeps the literal equal to `HEALTH_REVALIDATE_SECONDS`), and the collector fetch sits in the Next.js data cache for the same hour. What repeats a plugin page (its twin, `plugins.json`, `llms-full.txt`) is rendered by the same functions, so it shows the same figures.

## Traps

- **Generated and gitignored** — never edit by hand: `.generated/`, `.source/`, `public/`, `content/docs/configuration/keys.mdx`, `content/docs/known-limitations.mdx`, `content/docs/providers/<id>.mdx`. The generator empties `public/` and removes every file marked `generated: true` on each run. `public/` holds `llms.txt`, `sitemap.xml` and `robots.txt` only: the Markdown twins, `plugins.json` and `llms-full.txt` are routes.
- **`revalidate` must be a literal** in a page or route file: Next.js reads it statically, so `export const revalidate = HEALTH_REVALIDATE_SECONDS` silently gives no caching. Write `3600` and let `live.test.ts` catch a drift.
- **`/twins/…` is reachable directly** (the proxy rewrites to it); it is not listed anywhere and serves the same text as the `.md` address.
- **Hand-written docs are plain Markdown in `.mdx`**: `loadHandwrittenDocs()` refuses an `import`/`export` line, a `<Tag` or a `{` outside code (write `your-domain` in prose, `<your domain>` in a code span).
- **Plugin strings go through `text()`**, which escapes Markdown; README sections stay Markdown and `rewriteRelativeLinks()` points their relative links at GitHub.
- **Without `COLLECTOR_HOST`** every host is the site's and the collector routes refuse by themselves; with it, that host answers only `/v1/…` and a `Disallow: /` robots file.
- **No theme toggle on purpose**: it would need script and storage; dark follows `prefers-color-scheme`.

## Outside the repo — Vercel project

- Root `apps/website`, Node 22, framework Next.js, build `npm run build`, and **"Include files outside the root directory in the Build Step" on**: the generator reads `plugins/`, `docs/`, `deploy/` and workspace packages.
- Request-time variables: `COLLECTOR_HOST`, `COLLECTOR_SUPABASE_URL`, `COLLECTOR_SUPABASE_PUBLISHABLE_KEY`; the build needs none. No log drain, no Observability Plus, no analytics.
- The pages under `/plugins` and the twins route run as functions once an hour (ISR); nothing to configure, Vercel's defaults carry it.

## Debug

- **`site.json is missing`** → `npm run generate --workspace @vaubaan/website`.
- **"not plain Markdown"** → a `<`, `{` or component in prose: use a code span.
- **MDX error in a generated page** → `escapeMdx()` missed a construct: add it to `markdown.ts` and `units.test.ts`.
- **Every plugin reads "not read"** → the collector did not answer within 4 s when the page was last rendered (`https://telemetry.vaubaan.com/v1/plugin_stats?tool=is.null`); the next render, within the hour, tries again. `/plugins/health` names the time of the last successful read.
- **A new plugin version reads "no report yet"** while the old one had hundreds → expected: the rate is per exact version; "all versions" keeps the history.
