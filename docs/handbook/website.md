---
title: The public site — vaubaan.com, generated from the repository
status: current
date: 2026-10-16
last_synced: 2026-10-27
tracks:
  - apps/website/scripts/generate.ts
  - apps/website/src/content/
  - apps/website/src/site/
  - apps/website/src/app/page.tsx
  - apps/website/src/app/layout.tsx
  - apps/website/src/app/globals.css
  - apps/website/src/app/docs/
  - apps/website/src/app/plugins/
  - apps/website/src/app/trust/
  - apps/website/src/components/
  - apps/website/src/proxy.ts
  - apps/website/content/docs/
  - apps/website/source.config.ts
  - apps/website/next.config.ts
  - apps/website/package.json
  - apps/website/tests/unit/site/
---

# The public site — vaubaan.com, generated from the repository

How `apps/website` builds the site of spec [website](../spec/website.md) §2:
the landing, the user docs, the plugin pages with their health, the trust
center, and what it serves to language models and crawlers. The collector
that shares the app is in [`deploy/collector/README.md`](../../deploy/collector/README.md)
and [telemetry](telemetry.md). Decisions: ADRs
[website-nextjs-on-vercel](../decisions/website-nextjs-on-vercel.md) and
[website-generated-from-the-repository](../decisions/website-generated-from-the-repository.md).

## Layout

```
apps/website/
  scripts/generate.ts        build-time generator: reads the repository, writes the generated files
  source.config.ts           fumadocs-mdx: the docs collection (no syntax theme)
  content/docs/              user docs, hand-written MDX that is plain Markdown; meta.json orders the sidebar
    configuration/keys.mdx   generated (gitignored): every configuration key
    known-limitations.mdx    generated (gitignored): the repository's known limitations
    providers/<id>.mdx       generated (gitignored): "Connect <service>", one per plugin
  src/content/               build-time modules (Node, no Next): what the site says, as data
    repo.ts                  REPO_ROOT, readRepoFile()
    markdown.ts              frontmatter, sections, tables, relative links → GitHub, escapeMdx(), text()
    plugins.ts               discoverPluginDirs(), importPlugin(), pluginInfo(), loadPlugins()
    severity.ts              the severity word of a permission (the gateway's computation, restated)
    config-keys.ts           the handbook's key table → the "Configuration keys" page
    thresholds.ts            plugin_validation_thresholds() of deploy/collector/schema.sql
    health.ts                fetchHealth() (never throws), healthOf(), healthWords()
    plugin-pages.ts          Markdown of /plugins, /plugins/<id>, /plugins/health, /docs/providers/<id>
    trust.ts                 Markdown of /trust; accepted risks and out-of-scope read from the threat model
    docs.ts                  hand-written docs: loadHandwrittenDocs(), orderDocs(), withSectionLists()
    outputs.ts               llms.txt, llms-full.txt, plugins.json, sitemap.xml, robots.txt, twin paths
    build-site.ts            buildSite(): every page, the generated docs, the public files, site.json
  src/site/                  importable by pages
    constants.ts             SITE_ORIGIN, GITHUB_REPO, githubBlob(), PLUGIN_STATS_URL
    landing.ts               the landing's words and its questions and answers
    data.ts                  siteData(): reads .generated/site.json
    source.ts                the Fumadocs loader over the docs collection
    routing.ts               hostDecision(), wantsMarkdown(), markdownTwinOf()
  src/proxy.ts               collector host gate, Markdown negotiation
  src/app/                   page.tsx (landing), docs/[[...slug]], plugins, plugins/[id], plugins/health,
                             trust, layout.tsx, globals.css (the one token sheet), icon.svg;
                             v1/ (the collector, unchanged)
  src/components/            Shell (header, footer), DocsNav and Toc, MarkdownBody, GeneratedPage, JsonLd
  tests/unit/site/           plugins, site, sources-agree, units
```

Generated and gitignored: `.generated/`, `.source/` (fumadocs-mdx), `public/`,
and the three generated docs paths above.

## The build

`npm run build --workspace @vaubaan/website` runs `npm run generate`
(`tsx scripts/generate.ts && fumadocs-mdx`), then `next build`. `dev` and
`type-check` run the generator first too, so `npm run ci` (type-check before
lint and build) always finds the generated files.

The generator:

1. `loadPlugins(REPO_ROOT)`: every `plugins/<name>/` with a `package.json`
   and a name not starting with `_`, imported through its `exports["."]` entry
   — the plugin's `definePlugin` validates the declaration and the SDK's
   loader reads its `risk-catalog.yaml`, as at gateway boot. Each is reduced to
   `PluginInfo`: id, name, version, description, summary,
   tools (with their titles), risks (label, reason, severity, kind, envs),
   presets, credentials (kind, fields, guide steps, permissions, scopes, whether
   the gateway registers its own OAuth client),
   token handouts, git remote.
2. `parseThresholds(schema.sql)`.
3. `fetchHealth(PLUGIN_STATS_URL)`: `GET https://telemetry.vaubaan.com/v1/plugin_stats?tool=is.null`,
   4 s, 512 KiB at most, rows checked one by one. Any failure gives no row.
   `VAUBAAN_SITE_OFFLINE=1` skips the request.
4. `buildSite()`, then writes: the generated MDX (after removing every file
   marked `generated: true`), `public/` (emptied first), `.generated/site.json`.
   It prints one line: plugins, docs pages, pages, public files, whether the
   health was read.

## Pages

| Path                                           | Source                                                                 | Twin                     |
| ---------------------------------------------- | ---------------------------------------------------------------------- | ------------------------ |
| `/`                                            | `src/app/page.tsx`, words in `src/site/landing.ts`                     | `/index.md`              |
| `/docs`, `/docs/…`                             | `content/docs/**/*.mdx` through Fumadocs                               | `/docs.md`, `/docs/….md` |
| `/docs/configuration/keys`                     | generated from the key table of [configuration](configuration.md)      | yes                      |
| `/docs/known-limitations`                      | generated from [known-limitations](known-limitations.md)               | yes                      |
| `/docs/providers/<id>`                         | generated from the plugin, plus its README's `## Credential…` sections | yes                      |
| `/plugins`, `/plugins/<id>`, `/plugins/health` | `plugin-pages.ts`                                                      | yes                      |
| `/trust`                                       | `trust.ts`, threat model, collector README facts                       | yes                      |

**Health on a page.** `healthOf()` takes the row of the plugin's own version.
Below `minReports`, or without a row, the page says "not enough reports yet"
and no rate; above, the rate, the count and "validated" or "not validated".
Only the plugin-version rows (`tool` is null) are read: per-tool health is
not shown yet.

**Docs rules.** A hand-written page has a `title` and a `description` in its
frontmatter, starts with a sentence that defines its subject, and is plain
Markdown: `loadHandwrittenDocs()` refuses an `import`/`export` line, a `<Tag`
or a `{` outside code. Write placeholders inside code (`your-domain` in prose,
`<your domain>` in a code span). A folder's `index.mdx` is its page; its
`meta.json` lists the other pages (`"..."` for the rest, alphabetically). A
folder's index ends with "In this section" on the HTML page and in the twin.
Every command is one the repository documents; a page that describes
something not built or not released says so.

**Plain text in generated Markdown.** Strings from a plugin declaration
(summary, reason, step, help) go through `text()`, which escapes Markdown
markup (`release-*` stays literal). README sections are Markdown already:
their relative links are pointed at GitHub by `rewriteRelativeLinks()`.

## For language models and crawlers

- `public/llms.txt`: a paragraph, then every docs, plugin and trust page as
  `- [title](https://vaubaan.com/<path>.md): description`.
- `public/llms-full.txt`: every one of those pages in full, each after a
  `Source:` line.
- `public/plugins.json`: every plugin with version, description,
  tools, risks, presets, health (`measured` or `not-enough-reports`), and the
  thresholds.
- `public/sitemap.xml`: every page, `lastmod` from `git log -1 --format=%cs`
  of its sources when git answers.
- `public/robots.txt`: `GPTBot`, `ClaudeBot`, `PerplexityBot`,
  `Google-Extended`, `CCBot` and `*`, each `Allow: /`; nothing disallowed.
- JSON-LD: `SoftwareApplication` and `FAQPage` on the landing, `TechArticle`
  on every docs page (`JsonLd`, `<` escaped). Canonical URLs on
  `https://vaubaan.com`, and `<link rel="alternate" type="text/markdown">` to
  the twin.

## The proxy

`src/proxy.ts` runs on every request but `/_next/static` and `/_next/image`:

| Request                                                                            | Answer                           |
| ---------------------------------------------------------------------------------- | -------------------------------- |
| host is `COLLECTOR_HOST`, path `/v1/…`                                             | passed to the collector's routes |
| host is `COLLECTOR_HOST`, `/robots.txt`                                            | `User-agent: *` / `Disallow: /`  |
| host is `COLLECTOR_HOST`, anything else                                            | 404                              |
| a docs, plugin or trust path with `Accept: text/markdown` ranked above `text/html` | rewritten to its `.md` twin      |
| anything else                                                                      | passed through                   |

Without `COLLECTOR_HOST` every host is the site's; the collector's routes
then refuse by themselves. `next.config.ts` sets `Content-Type:
text/markdown; charset=utf-8` on `*.md` and `Vary: Accept` on the docs,
plugin and trust paths.

## Look

One style sheet, `src/app/globals.css`: tokens on `:root` with the values of
the gateway's light and dark themes (style guide §3), the dark ones under
`prefers-color-scheme: dark`; system fonts only; hairlines, no cards, one
accent. No theme toggle (it would need script and storage). The docs grid is
navigation, page, table of contents; under 1100 px the table of contents
goes, under 760 px the navigation becomes a `<details>` "Docs menu" above the
page. Tables scroll sideways inside `.table-wrap`; identifiers in a table do
not wrap.

## Tests

`apps/website/tests/unit/site/`:

- `plugins.test.ts` — every plugin folder listed, `_template` left out, each
  plugin loaded with risks, presets and credentials, preset entries naming
  risks of the same catalog, no plugin carrying an experimental state.
- `site.test.ts` — `buildSite()` offline: every hand-written, generated and
  plugin page present; each with its twin in `files`, starting with its
  title, and reachable by `markdownTwinOf()`; a defining first sentence;
  `llms.txt` lists every page with its `.md` URL and description;
  `llms-full.txt` carries every page whole; robots.txt allows the five named
  crawlers and `*` and disallows nothing; the sitemap lists every page;
  `plugins.json` never shows a rate offline; every GitHub link names an
  existing file; every site link names an existing page or file.
- `sources-agree.test.ts` — the key page against `KEYS`; the thresholds
  200 / 0.9 / 90 and the collector README; the severity word against the
  gateway's over all 1 296 vectors.
- `units.test.ts` — `escapeMdx`, `rewriteRelativeLinks`, `sectionsOf`,
  `text`, `splitFrontmatter`; health below and above the threshold and on a
  failing collector; the host gate, `wantsMarkdown`, `markdownTwinOf`; the
  plain-Markdown rule; the accepted risks and out-of-scope items read from
  the threat model.

## Deploying

A new Vercel project (ADR [website-nextjs-on-vercel](../decisions/website-nextjs-on-vercel.md) D3):
root directory `apps/website`, Node 22, framework Next.js, the build command
of `package.json` (`npm run build`), with "Include files outside the root
directory in the Build Step" on (the generator reads `plugins/`, `docs/`,
`deploy/` and the workspace packages). Variables: `COLLECTOR_HOST`,
`COLLECTOR_SUPABASE_URL`, `COLLECTOR_SUPABASE_PUBLISHABLE_KEY` (the
collector's, read at request time); none is needed by the build. No log
drain, no Observability Plus, no analytics.

## How to debug

- **`site.json is missing`** → run `npm run generate --workspace @vaubaan/website`.
- **A docs page fails the build with "not plain Markdown"** → a `<`, `{` or a
  component in prose: put it in a code span.
- **MDX error in a generated page** → `escapeMdx()` missed a construct of the
  source (a README, the handbook): add the case to `markdown.ts` and to
  `units.test.ts`.
- **"plugin health not read"** in the build log → the collector did not
  answer (expected until it is deployed); the pages say "not enough reports
  yet".

## References

- Spec [website](../spec/website.md); ADRs above.
- Handbooks: [telemetry](telemetry.md), [configuration](configuration.md),
  [threat-model](threat-model.md), [known-limitations](known-limitations.md),
  [plugin-sdk](plugin-sdk.md).
