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

Each shipped plugin has a page generated from its folder; a plugin is listed because it exists in
the repository. The page shows how the service is modelled, in the gateway's own words and display
codes ([style guide](./style-guide.md) §5: gate mark, risk word, the six facts, identifier, tag),
along three dimensions: **risk** (six facts per permission, summed into one word), the
**macro-actions** (the verbs of the service) and **trust** (the three levels). In order:

1. **Opening** — the service, its version, the counts (permissions, macro-actions, tools, gateways
   running it), the verbs in one sentence built from the macro-action labels, and the three
   dimensions in a few lines.
2. **The map** — every permission placed by macro-action (columns) and by its undo fact (rows:
   impossible, costly, easy but sensitive, easy), tinted by its risk word; each row says what the
   trust levels do with it. A reading sentence is computed from the counts. The page never says
   "tier": the undo words carry that meaning.
3. **One section per macro-action**, in catalog order: its narrative
   ([gateway-risk-model](./gateway-risk-model.md) §4.6), then a table of its permissions against
   the trust levels — label, id, reason, the six facts in the gateway's words with the fact that
   moves the gate tinted, the risk word, and per trust level the gate and the quota, written for a
   day, the default period; the page says a mission's period may differ. Rate ceilings are a note.
   An environment-scoped permission is one line per environment, tagged. Beside the table, the
   macro-action's own column of the map.
4. **Worked examples** — the plugin's declared examples
   ([ADR](../decisions/plugin-contract-and-credential-spec.md), amendment 2026-11-05) run through
   `classify` when the site is built: the call, the slices it yields, the permissions they touch,
   and what a Careful mission does with it. The site never writes a slice by hand.
5. **Anything else** (the fallback) and the tools the plugin **deliberately leaves out**
   (`excludedTools`), each with its reason.
6. **A mission, worked out** — the first two macro-actions at Careful, expanded by the policy engine
   into Can / Asks first / Cannot, as the gateway shows a mission.
7. **Connecting an account** — the way, one of three: a key the person creates at the service and
   pastes (`api-key`, `ssh-key`); a client the gateway registers itself at the service (`oauth2`
   with `clientRegistration`); **a broker's client** (`oauth2` with `broker`). For the third the page
   says that the instance must be enrolled with an OAuth broker serving that provider, names the
   provider and the exact scopes asked, says that the person signs in at the service and that the
   gateway's pages tell whether the broker is attested, and gives the two ways to get one: enrol
   with a broker someone else operates, or run the published image with one's own client
   ([oauth-broker](./oauth-broker.md)). A brokered way is never described as a client the gateway
   registers.
8. The retired permissions, the tools (count, link to the list with what each usually touches),
   health (§2.4), the links: connect, handbook, catalog as code, Markdown twin.

Everything on the page comes from the plugin's declaration, its catalog, `@vaubaan/policy-engine`
(tier, gates, budgets, severity) and the collector; the site restates nothing of the gateway by
hand (§1.1, no second source of truth; the [website handbook](../handbook/website.md) names the
imports). The Markdown twin keeps the same order; the map becomes a list by undo row.

### 2.4 Plugin health — `/plugins/health` and on each plugin page

- Every version with data shows its figures, whatever their number: **gateways** (distinct
  instances running it), **calls** and **success rate**; **validated** (the published thresholds,
  which drive the gateway's badge) is a plain mark when true, never a gate on what is shown.
- `/plugins`: `Plugin | Version | Gateways | Calls | Success`, two rows per plugin: the minor
  (`major.minor`) of the version in the repository, then the most recent other minor the collector
  knows, if any. A minor adds up its patch versions; its gateways are counted distinct over the
  minor. A minor with no call reads "no call yet".
- `/plugins/<id>`: "N gateways run this plugin" over the window, and the last ten versions the
  collector knows, newest first: `Version | Gateways | Calls | Success | Validated`.
- `/plugins/health`: what calls, gateways, success rate and validated mean, the hourly refresh, and
  "not read" when the collector does not answer.
- A footnote on the three pages: calls are counted over the window from instances sharing plugin
  health; gateways among instances that also share usage statistics, over the same window, so a
  lower bound; the success rate leaves out calls refused for a rejected credential.
- Read from the collector's public aggregates when a page is served, refreshed at most hourly; a
  collector that does not answer leaves the pages up and says the figures were not read, each
  figure on its own. Instances read the same aggregates for their badge. Of the `usage-stats`
  aggregates only gateways per plugin version are published (§5).

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
  source; `/llms.txt` (index) and `/llms-full.txt` (user docs, plugins, trust center);
  `/plugins.json` with the plugin pages' data. Whatever repeats a plugin page carries the same
  health figures as the page, refreshed with it (§2.4).
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

1. **Publishing more usage statistics** (`usage-stats` aggregates beyond gateways per plugin
   version) or keeping them for maintainers.
2. **Languages**: English only; French for landing and trust center is a candidate.
3. **Versioned docs**: the latest release only, until a second release line.
4. **A docs MCP server**, if `llms.txt` and the Markdown pages prove insufficient.
