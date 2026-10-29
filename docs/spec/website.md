---
title: vaubaan.com — the project's public site and its telemetry collector
status: draft
---

# vaubaan.com — spec

> **Status:** draft, to be validated by the product owner. What an instance sends is
> [vaubaan-gateway](./vaubaan-gateway.md) §9; this spec covers the side that receives and publishes
> it. Build: [website handbook](../handbook/website.md).

## 0. Vocabulary

- **Site** — everything served at `vaubaan.com`. Public, read-only, no account.
- **Collector** — the endpoint at `telemetry.vaubaan.com` receiving opted-in instances' reports, and
  its store.
- **Plugin health** — per plugin, version and tool: calls reported, calls that worked, and whether
  the plugin is **deemed validated**.
- **Trust center** — what the project does for security, what it does not, and what leaves an
  instance.
- **User docs** — for people who install, run and use an instance; distinct from the contributor
  handbooks.

## 1. Vision

A visitor, without signing up, can answer: what does it do and is it for me; how do I install it;
can I trust it with my cloud credentials; does the plugin for my provider work.

- Readers, by priority: the **evaluator** (pitch, a five-minute demo), the **operator** (commands
  that work as written), the **security reviewer** (threat model, what is not covered, exact
  telemetry, no marketing), the **plugin contributor**, and an **assistant or agent** reading for
  one of them (§2.6).
- The site is honest: pre-release, no third-party audit, no certification.

### 1.1 Explicitly out of scope

- **No account, sign-up or sign-in**; the site collects nothing; no cookie, tracker or analytics
  script.
- **No instance data** beyond the public aggregates of §2.4; raw reports are never published.
- **No second source of truth**: what the site says about a plugin is generated from the plugin's
  folder at build time.
- **No blog, no pricing page** in the first version.

## 2. Content

### 2.1 Landing — `/`

The pitch for a reader new to MCP gateways: the problem, missions as the answer, the shape (on-prem,
your identity provider), supported providers from the plugin list, the licence, two calls to action
(**try the demo**, **install**), links to the trust center and the repository.

### 2.2 User docs — `/docs`

In English; every command works on the released image. Concepts in the interface's words, quick look
(the demo), install, configuration (every key of gateway §4.3), one page per plugin to connect it,
missions and agents (clients, management door, git remote), operations (backup, key rotation,
upgrade, retention, telemetry), known limitations.

### 2.3 Plugins — `/plugins`, `/plugins/<id>`

Each shipped plugin with description, version, tools, risks, presets, how to connect and its health,
generated from its folder; a plugin is listed because it exists in the repository.

### 2.4 Plugin health — `/plugins/health` and on each plugin page

- Per `(plugin, version)` and tool: reports over the window, success rate, **validated** against
  published thresholds. Below the report threshold: "not enough reports yet", never a rate.
- Read from the collector's public aggregates, refreshed at most hourly; instances read the same
  aggregates for their badge. `usage-stats` aggregates are **not** published (§5).

### 2.5 Trust center — `/trust`

Each claim in the reader's words, linked to the document or code behind it: the trust proposition
(the agent never holds a provider credential), the controls, the supply chain, **what leaves an
instance** (nothing by default; with telemetry, the exact fields per level, what is never sent, how
the collector handles addresses), what is not covered, how to report a vulnerability. Only what the
code does today; a planned control is marked planned.

### 2.6 Readable by language models and agents

A model must find the site, quote it correctly and act on it without a browser.

- **Static, semantic HTML**, complete without scripts.
- **Markdown beside every page** at its path + `.md` and on `Accept: text/markdown`, from the same
  source; `/llms.txt` (index) and `/llms-full.txt` (user docs, plugins, trust center), built at
  build time; `/plugins.json` with the plugin pages' data.
- **Answers first**: each page opens with a quotable defining sentence; a "How Vaubaan compares"
  page and a Q&A block on the landing.
- **Structured data** on the landing, docs pages and Q&A; a sitemap with real dates; canonical URLs.
- **Crawlers welcome**, AI ones named, everywhere except the collector's host.
- **An agent can install it**: one block to paste (what to install, commands, what to ask the human,
  how to verify).
- **Stable URLs**: a moved page leaves a permanent redirect. Citation frequency cannot be measured
  (§1.1); accepted.

## 3. The collector

- **Receives** reports checked against their level's shapes and closed vocabularies; a report that
  does not fit is dropped, a request carrying one refused whole.
- **Stores** one row per accepted report, arrival truncated to the UTC hour; no address, header or
  undefined field.
- **Never stores or forwards a network address**; how long the hosting platform keeps it in request
  logs is bounded and published on the trust center.
- **Limits** ingestion against flooding, without identifying any party.
- **Publishes** the §2.4 aggregates read-only to anyone; raw rows to the maintainers only.
- **Is optional**: a dead collector costs an instance only its badge.

## 4. Release

- The site is public before the repository and publishes nothing not meant to be public; until the
  repository and an image are public, the pages say the project is pre-release.
- The collector is served from the same deployment, and its URL is the gateway's default telemetry
  endpoint.

## 5. Open questions

1. **Publishing usage statistics** (`usage-stats` aggregates) or keeping them for maintainers. Not
   in the first version.
2. **Languages**: English only; French for landing and trust center is a candidate.
3. **Versioned docs**: the latest release only, until a second release line.
4. **A docs MCP server**, if `llms.txt` and the Markdown pages prove insufficient.
