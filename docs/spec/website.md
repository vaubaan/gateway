---
title: vaubaan.com — the project's public site and its telemetry collector
status: draft
date: 2026-10-16
---

# vaubaan.com — spec

> **Status:** draft, to be validated by the product owner. Describes the
> public site of the open source project: what it is for, what it contains,
> what it never does. The telemetry an instance sends is specified in
> [vaubaan-gateway](./vaubaan-gateway.md) §9; this spec covers the side that
> receives and publishes it. Structural choices (stack, hosting, collector
> shape): ADRs [website-nextjs-on-vercel](../decisions/website-nextjs-on-vercel.md)
> and [telemetry-two-levels-behind-a-vercel-collector](../decisions/telemetry-two-levels-behind-a-vercel-collector.md).

## 0. Vocabulary

- **Site** — everything served at `vaubaan.com`. Public, read-only, no account.
- **Collector** — the endpoint at `telemetry.vaubaan.com` that receives the
  reports of the instances whose operator opted in (gateway spec §9), and the
  store behind it.
- **Plugin health** — per plugin, version and tool: how many calls were
  reported and how many worked, and whether the plugin is **deemed
  validated** (gateway spec §9).
- **Trust center** — the part of the site that says what the project does for
  security, what it does not do, and what leaves an instance.
- **User docs** — documentation for people who install, run and use an
  instance. Distinct from the repository's handbooks, which describe how the
  code works for its contributors.

## 1. Vision

A person who hears of Vaubaan Gateway lands on vaubaan.com and, without
signing up for anything, can answer four questions: what does it do and is it
for me; how do I install it; can I trust it with my cloud credentials; does
the plugin for my provider actually work.

Five readers, in order of priority:

1. **The evaluator** (a tech lead, a CTO) — wants the pitch, the boundary it
   draws around agents, and a demo in five minutes.
2. **The operator** (a devops) — wants the install, the configuration, the
   upgrade and backup procedures, with commands that work as written.
3. **The security reviewer** (a CISO, a security engineer at a customer) —
   wants the threat model, the controls, what is not covered, the disclosure
   process and the exact telemetry content, without marketing.
4. **The plugin contributor** — wants the plugin kit and the health of the
   existing plugins.
5. **The assistant or agent** reading on behalf of one of the four — wants
   text it can quote and act on (§2.6).

The site is honest about the state of the project: pre-release, no third
party audit, no certification. Saying what is not done is part of the trust
proposition (gateway threat model, "Accepted risks").

### 1.1 Explicitly out of scope

- **No account, no sign-up, no sign-in.** The managed offer is not open yet;
  the site may announce it and collect nothing.
- **No cookie, no third-party tracker, no analytics script.** A site that
  asks to be trusted with telemetry does not track its visitors.
- **No instance data on the site** beyond the public aggregates of §2.4.
  Raw reports are never published.
- **No second source of truth.** What the site says about a plugin (tools,
  risks, presets, version) is generated from the plugin's folder in the
  repository at build time, never typed again.
- **No blog, no pricing page** in the first version.

## 2. Content

### 2.1 Landing — `/`

The pitch of the README, for a reader who has never heard of MCP gateways:
the problem (agents need cloud credentials), the answer (missions: resources,
permissions, limits, "ask me first"; a key per mission; credentials stay on
the instance; everything recorded), the shape (on-prem, your identity
provider, your apps), the supported providers (from the plugin list), the
open source licence, and two calls to action: **try the demo** and
**install**. A link to the trust center and to GitHub.

### 2.2 User docs — `/docs`

Written for the operator and the user of an instance, in English. Every
command is one that works on the released image. Minimum content of the
first version:

- **Concepts** — instance, account, resource, mission, key, permission
  (risk), preset, limit, "ask me first", activity. Words of the interface
  (gateway style guide), not of the code.
- **Quick look** — the demo on a laptop.
- **Install** — Docker Compose with the bundled proxy; Railway; requirements
  (DNS, ports, Node for the key script); first sign-in with the bootstrap
  token.
- **Configuration** — every key of the instance configuration (gateway spec
  §4.3) with its default, sign-in providers (OpenID Connect, GitHub), the
  admin rule, provider apps.
- **Connect a provider** — one page per plugin, generated in part from the
  plugin (§2.3) and completed by hand (registering the company's app).
- **Missions and agents** — create a mission, give its key to an agent,
  configure MCP clients (Claude Code, Cursor, others), the management door,
  the git remote.
- **Operations** — backup and restore, master key rotation, upgrade, audit
  retention, telemetry levels.
- **Known limitations** — the same list as the repository's.

### 2.3 Plugins — `/plugins`, `/plugins/<id>`

The list of plugins shipped with the gateway, and per plugin: description,
version, status (stable / experimental), tools, risks with their labels,
presets, how to connect (app, token), and its **health** (§2.4). Generated
from `plugins/<id>/` (its declaration and `risk-catalog.yaml`) at build time.
A plugin is listed because it exists in the repository, nowhere else.

### 2.4 Plugin health — `/plugins/health` and on each plugin page

Per `(plugin, version)` and per tool: reports over the window, success rate,
**validated** or not, against thresholds the page publishes (today 200
reports, 90 % success, 90 days). Read from the collector's public aggregates,
refreshed at most every hour. While a plugin has fewer reports than the
threshold, the page says "not enough reports yet", never a rate.

The same aggregates are what an instance reads to show the badge on its
accounts (gateway spec §9). The site and the instances read one source.

The usage statistics of gateway spec §9 (level `usage-stats`) are **not**
published on the site in the first version; see §5.

### 2.5 Trust center — `/trust`

What the project does for security, in the reader's words, each claim
linked to the document or code that backs it:

- **The trust proposition** — the agent never holds a provider credential;
  the three credentials and why none crosses (from the threat model).
- **Controls** — encryption at rest and master key rotation, credential
  separation between doors, budgets and approvals, self resources never
  reachable, sign-in hardening (rate limits, verified email, session
  limits), security headers, audit of every call.
- **Supply chain** — dependency audit gate, CI security checks, image build
  from source; signed images and provenance once releases exist.
- **What leaves an instance** — nothing by default; with telemetry enabled,
  the exact fields of each level (gateway spec §9), what is never sent, how
  the collector handles addresses (§3), how to check it (the structural test,
  the client code).
- **What is not covered** — the accepted risks and out-of-scope items of the
  threat model; pre-release status; no third-party audit or certification.
- **Report a vulnerability** — the process of `SECURITY.md`.

The trust center states only what the code does today. A control that is
planned is marked as planned.

### 2.6 Readable by language models and agents

Many readers arrive through an assistant: a person asks an LLM "how do I let
an agent use my Supabase without giving it the key", or a coding agent is told
"install Vaubaan Gateway and give yourself a mission". The site is written so
that a model finds it, quotes it correctly and can act on it, without a
browser.

- **Static, semantic HTML.** Every page is complete without JavaScript: one
  `h1`, headings in order, code in `pre`/`code`, tables as tables. Nothing a
  crawler needs is rendered on the client.
- **Markdown beside every page.** Each docs, plugin and trust center page is
  also served as Markdown at the same path with `.md` appended, and when the
  request asks for `text/markdown`. Generated from the same source as the
  HTML.
- **`/llms.txt` and `/llms-full.txt`** (the llms.txt convention): the first
  is the index — a one-paragraph description of the project, then every page
  with a one-line summary and its `.md` link; the second is the whole user
  docs, the plugin list and the trust center in one Markdown file. Both are
  generated at build time.
- **Machine-readable catalog.** `/plugins.json`: every plugin with its
  version, status, tools, risks, presets and health, generated from the
  repository and the collector's aggregates (§2.3, §2.4). The same data the
  plugin pages show.
- **Answers first.** Each page opens with a sentence that defines its subject
  in plain words ("A mission is…", "Vaubaan Gateway is…"), so the first
  sentence is quotable on its own. A page "How Vaubaan compares" says
  honestly how the gateway differs from handing an agent a token, from a
  secrets manager and from other MCP gateways. A questions-and-answers block
  on the landing covers what people ask an assistant.
- **Structured data.** JSON-LD on the landing (`SoftwareApplication`, with
  licence, repository, operating system "Docker"), on docs pages
  (`TechArticle`) and on the questions block (`FAQPage`). A `sitemap.xml`
  with real modification dates; canonical URLs.
- **Crawlers welcome.** `robots.txt` allows every crawler, the AI ones named
  explicitly (`GPTBot`, `ClaudeBot`, `PerplexityBot`, `Google-Extended`,
  `CCBot`), on the whole site except the collector's host.
- **An agent can install it.** A page "Install with your coding agent" gives
  one block to paste into an agent: what to install, the commands, what to
  ask the human (DNS name, sign-in provider), and how to verify. The README
  of the repository links to it, and the repository keeps its `AGENTS.md`
  for contributors.
- **Stable URLs.** A page that moves leaves a permanent redirect: models
  remember links.

The site cannot measure how often it is cited (no analytics, §1.1); this is
accepted.

## 3. The collector

- **Receives** the reports of opted-in instances (gateway spec §9) at
  `telemetry.vaubaan.com`. Each report is checked against the shapes and
  closed vocabularies of its level; a report that does not fit is dropped, a
  request that carries one is refused whole.
- **Stores** each accepted report as one row, with the arrival time
  truncated to the UTC hour set by the collector. No address, no header, no
  field the report does not define.
- **Never stores or forwards a network address.** The instance's address is
  seen by the hosting platform and by the collector's code and goes no
  further: the store sees the collector's address only. The time the hosting
  platform keeps it in its own request logs is bounded and published on the
  trust center.
- **Limits** ingestion so that one party cannot flood it, without
  identifying any party.
- **Publishes** the plugin health aggregates of §2.4 to anyone, read-only.
  Raw rows are readable by the project's maintainers only.
- **Is optional.** A dead collector costs an instance nothing but its badge
  (gateway telemetry handbook).

## 4. Release

- The site is public at vaubaan.com since 2026-10-16, before the repository
  is (product owner's decision of that day: the site publishes nothing of
  the code that is not already meant to be public). Until the repository is
  public and a first image is published, its GitHub links answer 404 to a
  visitor and the install commands cannot be run as written; the pages say
  the project is pre-release.
- `telemetry.vaubaan.com` serves the collector from the same deployment.
- The collector's URL becomes the gateway's default in the same release
  (gateway telemetry ADR D4: one line).

## 5. Open questions

1. **Publishing usage statistics.** Aggregates of the `usage-stats` level
   (providers and risks most used, refusal codes, instance profiles) could
   be published for transparency, or kept for the maintainers. Not in the
   first version.
2. **Languages.** English only in the first version; French for the landing
   and the trust center is a candidate (pilot customers). The framework's
   i18n is set up from the start.
3. **Versioned docs.** One version (the latest release) until a second
   release line exists.
4. **A docs MCP server.** A read-only MCP endpoint on the site
   (`search_docs`, `get_page`, `list_plugins`, `get_plugin`) would let an agent
   that configures an instance query the docs as tools. After the first
   version, if `llms.txt` and the Markdown pages prove insufficient.
5. **Managed offer.** When it opens, sign-up lives elsewhere
   (`console.vaubaan.com`), not on this site; customer instances are on
   `<slug>.vaubaan.app`.
