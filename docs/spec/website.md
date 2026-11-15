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
can I trust it with my cloud credentials; does the plugin for my service work.

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
your identity provider), supported services from the plugin list, the licence, two calls to action
(**try the demo**, **install**), links to the trust center and the repository.

### 2.2 User docs — `/docs`

In English; every command works on the released image. Concepts in the interface's words, quick look
(the demo), the interface page by page, install, configuration (every key of gateway §4.3), connecting a service (the three
ways; each service's guide is on its plugin page, §2.3 item 9, and the former per-service pages
redirect there), missions and agents (clients, platform management, git remote), operations (backup, key rotation,
upgrade, retention, telemetry), accounts, administration, known limitations. Every page of the
gateway's interface links to one of these pages.

### 2.3 Plugins — `/plugins`, `/plugins/<id>`

Each shipped plugin has a page generated from its folder; a plugin is listed because it exists in
the repository. The page (the "Atlas" layout, decided 2026-11-13) shows how the service is
modelled, in the gateway's own words: **every word comes from a plugin field or a fixed
template** over one — the plugin's declaration, data model, catalog, examples and credential, the
policy engine (rows, reasons, gate sentences, trust levels, budgets) and the collector. Each
section opens with a numbered kicker ("3 · The map"), in order:

1. **Header** — the service mark, name, version, the plugin's description, and the counts line:
   permissions, macro-actions, tools (and the git remote), gateways running it.
2. **The model** — "How <Service> is modelled": "<N> planes, <M> things." and a fixed sentence;
   the data model as nested boxes: the account (the summary's account sentence), each plane
   (slug and description), its entities nested by containment with their cardinality marks
   (1 / n / \*), the entity a resource is (named by the plugin's resource noun) highlighted, the
   entity carrying the environment marked (with the known environments, or dashed "in the
   model only" when the catalog names none), entities no classified example touches dashed,
   each entity's description behind an (i); a legend; then the **Account**, **Resource** and
   **Environment** callouts (the summary's sentences; the environment's rule as the gateway's
   service reference says it — read from each call, the label on the resource, or none —, the
   known environments, what carries them).
3. **Macro-actions** — "What an agent does at <Service>: <N> macro-actions", a fixed sentence,
   one card per macro-action in catalog order: number, label, description, narrative
   ([gateway-risk-model](./gateway-risk-model.md) §4.6), its count of permissions.
4. **The map** — every permission placed by macro-action (columns) and by its row of the tree,
   worst first (Cannot be repaired, Repairable at a price, Repairable worth a look, Harmless),
   each row tinted with its glyph and the sentence of what the trust levels do with it. A chip
   is a permission: its label, its reason (rows 2–4), the catalog's reason behind an (i), and
   for the chosen trust level "yes / ask me / no · <quota> a day" (the base budget ×1, ×3, ×10),
   written for a day, the default period; a sum line per level and the period note. Two
   **toggles**: the trust level (Careful ×1 default, Trusting ×3, Autonomous ×10, each with its
   one-line description), and — only when the data model carries an environment the catalog
   names — the environment (the known ones, the catalog's production first). A permission
   accepted per environment takes the vector of the chosen one; one the catalog does not accept
   there reads "no · never on <env>", dashed. The fallback is not on the map. The page never
   says "tier", and prints no severity word.
5. **A few calls** — the plugin's declared examples
   ([ADR](../decisions/plugin-contract-and-credential-spec.md), amendment 2026-11-05) run
   through `classify` when the site is built; shown: for each macro-action, the first example
   whose permissions all belong to it, then the first one Careful leaves out — the call, the
   slices, the permissions they touch, what a Careful mission does —, with a link to all of them
   as code. The site never writes a slice by hand.
6. **Anything else** — the fallback, its row and reason and the three levels' gates and quotas;
   then the tools the plugin **deliberately leaves out** (`excludedTools`), each with its reason.
7. **Tools** — the count, why a mission is made of macro-actions and not tools, and the list (what
   each does, what it usually touches) in a scrolling box; the git remote when the plugin is one.
8. **Retired permissions**, when there are some.
9. **Connecting an account** — the whole guide, inline (anchor `#connect`), from the plugin's
   declaration alone, the same the gateway's connect screen shows. It opens with the **kind
   badge**, numbered so a reader learns there are only three: "1 of 3 · a key you create and
   paste" (`api-key`, and `ssh-key` with its key-pair sentence), "2 of 3 · you sign in and allow
   the gateway (its own client)" (`oauth2` with `clientRegistration`), "3 of 3 · you sign in
   through an OAuth broker" (`oauth2` with `broker`). For a pasted key: "A <label> the person
   creates at <service> and pastes once"; the reach (what, how wide, why); when the key has
   **alternatives** (two to four shapes), a toggle like the trust level's, "Choose one", each
   shape showing its help line and one numbered list — its own steps, then the shared steps;
   each step with the **application path** at the service (the service's own menu labels,
   highlighted), its page, its command, and a **screenshot** under the step whose screen is the
   hard part, when declared, with its provenance line ("GitHub docs, 2026-11 · from
   docs.github.com (CC BY 4.0)", or taken by the Vaubaan team); the grants as "Permission at
   <service> · Access"; then where, the expiry, what the connect page asks, the service's
   documentation and how to disconnect. A brokered way starts with an administrator's block,
   **Before anyone connects**: the instance must be enrolled with an OAuth broker serving its
   OAuth provider, that OAuth provider and the exact scopes asked, the two ways to get one (enrol with a
   broker someone else operates, or run the published image with one's own client,
   [oauth-broker](./oauth-broker.md)), and that the gateway's pages tell whether the broker is
   attested; then what the person does. A brokered way is never described as a client the
   gateway registers. A way with the gateway's own client gives what the person does and the
   scopes. A screenshot ships only under a licence that allows redistribution with attribution
   ([ADR](../decisions/plugin-contract-and-credential-spec.md), amendment 2026-11-13); the
   plugin list's foot credits the documentation they come from.
10. **Health** (§2.4) and **Links**: connect, handbook, catalog as code, source, Markdown twin.

Sections 1–8 are **one implementation shared with the gateway**, whose Reference shows exactly
this page for the plugin version an instance runs ([vaubaan-gateway](./vaubaan-gateway.md) §4.2):
the page data and the view are built from a loaded plugin, and what is the site's alone — the
crumbs, the gateways on the counts line, health, links, the foot naming the twin, where a link
or a screenshot goes — is handed in by the site. Nothing of either app is written in the shared
page.

Static HTML (§2.6): each toggle is a CSS-only radio group; every state is in the HTML and the style
sheet shows one. At phone width the model's boxes stack and the map scrolls sideways in its own
box, the row column pinned; the page never scrolls sideways. Light and dark themes, both AA.

The site restates nothing of the gateway by hand (§1.1, no second source of truth; the [website
handbook](../handbook/website.md) names the imports and the two sentences it must mirror). The
Markdown twin keeps the same order: the model as an outline, the map as one list per row with
each permission's reason and its gates and quotas at every level and in every environment.

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

### 2.4 bis Versions feed — `/versions.json`

What an instance reads to know whether it is behind, with nothing installed by the gateway
([ADR](../decisions/plugins-bundled-or-pinned-by-the-operator.md)). One static JSON document:
the released gateway version and whether it is a pre-release, the released version of every
bundled plugin, and the **advisories**: each with an id, its subject (the gateway or one plugin),
the affected version range, the version that fixes it, one sentence and a link. The versions come
from the repository at the last release (written by the release preparation, never read from the
collector); the advisories are a committed file written in the fixing pull request. The feed is
served to anyone, cacheable, and reading it tells the site nothing about the instance: the
instance compares on its side. The trust center names it among what leaves an instance: a
request, no payload.

### 2.5 Trust center — `/trust`

Each claim in the reader's words, linked to the document or code behind it: the trust proposition
(the agent never holds a service credential), the controls, the supply chain, **what leaves an
instance** (nothing by default; with telemetry, the exact fields per level, what is never sent, how
the collector handles addresses), what is not covered, how to report a vulnerability. Only what the
code does today; a planned control is marked planned.

### 2.6 Readable by language models and agents

A model must find the site, quote it correctly and act on it without a browser.

- **Static, semantic HTML**, complete without scripts.
- **Markdown beside every page** at its path + `.md` and on `Accept: text/markdown`, from the same
  source; `/llms.txt` (index) and `/llms-full.txt` (user docs, plugins, trust center);
  `/plugins.json` with the plugin pages' data. Whatever repeats a plugin page carries the same
  health figures as the page, refreshed with it (§2.4). Each permission of `/plugins.json` carries
  its `row` (1 to 4, [gateway-risk-model](./gateway-risk-model.md) §4.6) and `row_reason` (the
  branch of the tree, `null` in row 1), per environment too (`env_variants`); its `vector` has the
  five facts. Since 2026-11-13 there is no `severity` and no `tier` field, and the worked mission's
  lines and left-out risks carry `row` instead of `tier`. Each plugin carries its
  `data_model` (planes, entities, cardinalities, descriptions, the environment carrier, whether
  an example touches it) and its `environment` (where it comes from, the known ones, the
  carriers); a way of connecting carries its `alternatives`, each with its own steps, its
  `steps` being the shared ones.
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
