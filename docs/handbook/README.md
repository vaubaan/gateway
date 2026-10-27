---
title: Handbook — index
status: current
date: 2026-10-13
last_synced: 2026-10-27
tracks:
  - docs/handbook/
---

# Handbook — index

A handbook says **how the code actually works today**: the files, the
functions, the rules they enforce and the tests that hold them. It is the
third of three views of a subsystem. The spec ([`docs/spec/`](../spec/)) says
what the gateway does and why, without naming a technology; the ADRs
([`docs/decisions/`](../decisions/)) record the structuring choices and the
alternatives rejected; the handbook describes the implementation that
resulted. Each handbook declares the code it describes in the `tracks:` list
of its frontmatter, so a change to a tracked file that the handbook does not
follow can be detected as drift.

## Running an instance

| Handbook                                          | What it covers                                                                                                                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [configuration](configuration.md)                 | Instance configuration, crypto and the composition root: how the process starts from configuration alone.                                                                  |
| [oauth-broker-contract](oauth-broker-contract.md) | The four calls between an instance and an OAuth broker (requests, answers, errors, lifetimes, auth): what a broker implements.                                             |
| [store](store.md)                                 | The embedded SQLite store: one file on the mounted volume, schema and migrations applied at boot, repository interfaces.                                                   |
| [cutover-from-v4](cutover-from-v4.md)             | The procedure to move the one real user of the v4 SaaS onto a v5 instance and switch v4 off: what to prepare, the checklist, live checks.                                  |
| [import-from-v4](import-from-v4.md)               | The one-shot import of a v4 organization: the exporter, the importer in the image, the operator's procedure (dry run, apply, connect by hand, run again).                  |
| [demo-mode](demo-mode.md)                         | `npm run demo`: the real application in a browser with a simulated identity provider, simulated services and seeded data.                                                  |
| [threat-model](threat-model.md)                   | What the gateway defends, against whom, with which control, and which test proves the control is still there: the security reading of the spec and of the other handbooks. |
| [known-limitations](known-limitations.md)         | What a reader should know before relying on this version: what has not been done, and what is not there.                                                                   |
| [website](website.md)                             | The public site vaubaan.com (`apps/website`), generated from the repository at build time: user docs, plugin pages and health, trust center, Markdown twins, llms.txt.     |

Packaging and deployment (image, compose file, reverse proxy) are in
[`deploy/README.md`](../../deploy/README.md).

## Humans

| Handbook                            | What it covers                                                                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [authentication](authentication.md) | How a human gets a session: the sign-in providers (OIDC, GitHub), admission and invitations, the web session, the bootstrap token, and how "operator" is decided (the admin rule).                                  |
| [authority](authority.md)           | What a user may accept on a connection right now: owners, shares, local groups, and what follows when it changes (orphaned missions, unowned connections).                                                          |
| [connections](connections.md)       | Connect flows (one way per service: a pasted key, OAuth only for Miro), credential storage and refresh, resource discovery and curation, the OAuth clients the gateway registers.                                   |
| [missions](missions.md)             | How a connection owner issues a mission (a per-risk budget and gate on selected resources): authority, presets, resources, members and per-holder tokens, the bootstrap kit, the mission pages.                     |
| [requests](requests.md)             | Claims and approval requests once a refusal dropped them into the creator's inbox ("Waiting for you"): the request URL, who may open it, the decision, events, expiry.                                              |
| [audit](audit.md)                   | How what happened is made visible: the search of the Activity page, the activity of one mission, the retention sweeper, administrative entries.                                                                     |
| [web-app](web-app.md)               | The frame of the human surface: route map, layouts, the shell and its side navigation, session helpers, the words, the themes, the tokens and the design system; the home ("Now") and the reference (`/reference`). |

## Agents

| Handbook                                      | What it covers                                                                                                                                                         |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [execution-door](execution-door.md)           | How an agent holding a mission token lists and calls tools: `/mcp`, the bearer dispatch, the call pipeline's stages, the agent label, streaming, the catalog endpoint. |
| [git-remote](git-remote.md)                   | The instance as the agents' git remote: `/git/<owner>/<repo>.git`, fetch relayed, push decided ref by ref, temporary refs, the sweeper.                                |
| [management-door](management-door.md)         | How an agent acts on behalf of a user: the instance as OAuth authorization server, delegated tokens, admission, the tools of `/mcp/manage`.                            |
| [budget-and-sessions](budget-and-sessions.md) | How a call that passed the risk check is counted against its mission's budget: the decision core, the session service, rate windows, mission states.                   |

## Engine and plugins

| Handbook                                | What it covers                                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [gateway-core](gateway-core.md)         | `@vaubaan/gateway-core`, the decision core: typed refusals, the audit entry shape, the mission context, the skeleton of the call pipeline. |
| [policy-engine](policy-engine.md)       | `@vaubaan/policy-engine`: pure modules around slices and risk catalogs, with no IO and no state.                                           |
| [plugin-sdk](plugin-sdk.md)             | `@vaubaan/plugin-sdk`: the package a provider plugin is written against, and the single place the gateway learns which providers exist.    |
| [telemetry](telemetry.md)               | Community telemetry, off at installation: the report, the queue, the toggle, the validation tag.                                           |
| [providers/README](providers/README.md) | Index of the provider plugin handbooks and the structure they share.                                                                       |

One handbook per provider plugin (`plugins/<id>`):

| Handbook                                                  | What it covers                                                                                                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| -------------------------------------------------------   | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [providers/github](providers/github.md)                   | `@vaubaan/plugin-github`.                                                                                                                                                       |
| [providers/vercel](providers/vercel.md)                   | `@vaubaan/plugin-vercel`: plugin and risk model.                                                                                                                                |
| [providers/supabase](providers/supabase.md)               | `@vaubaan/plugin-supabase`.                                                                                                                                                     |
| [providers/railway](providers/railway.md)                 | `@vaubaan/plugin-railway`: rewraps the official Railway MCP server and adds four GraphQL variable tools.                                                                        |
| [providers/stripe](providers/stripe.md)                   | `@vaubaan/plugin-stripe`: modelling and runtime.                                                                                                                                |
| [providers/resend](providers/resend.md)                   | `@vaubaan/plugin-resend`: modelling and runtime.                                                                                                                                |
| [providers/cloudflare-dns](providers/cloudflare-dns.md)   | `@vaubaan/plugin-cloudflare-dns`: modelling and runtime.                                                                                                                        |
| [providers/context7](providers/context7.md)               | `@vaubaan/plugin-context7`: rewraps the official Context7 MCP server (library documentation).                                                                                   |
| [providers/upstash-redis](providers/upstash-redis.md)     | `@vaubaan/plugin-upstash-redis`: plugin and risk model.                                                                                                                         |
| [providers/ssh](providers/ssh.md)                         | `@vaubaan/plugin-ssh`: bash over SSH.                                                                                                                                           |
| [providers/gmail](providers/gmail.md)                     | `@vaubaan/plugin-gmail`: an app password, twelve tools over IMAP (search, read with HTML and attachments, draft, label, create labels), never sends.                            |
| [providers/fly](providers/fly.md)                         | `@vaubaan/plugin-fly`: the apps of one Fly organization, their machines, volumes, secrets, IPs and certificates.                                                                |
| [providers/miro](providers/miro.md)                       | `@vaubaan/plugin-miro`: Miro's MCP server rewrapped, OAuth with a client the gateway registers.                                                                                 |
| [providers/notion](providers/notion.md)                   | `@vaubaan/plugin-notion`: pages, content, databases and comments under shared roots, proven by an ancestry walk.                                                                |
| [providers/google-calendar](providers/google-calendar.md) | `@vaubaan/plugin-google-calendar`: Google's Calendar MCP server rewrapped, with an access token from an OAuth broker; invited people zoned inside or outside.                   |
| [providers/caldav](providers/caldav.md)                   | `@vaubaan/plugin-caldav`, "CalDAV Calendar": any CalDAV server (iCloud, Fastmail, Nextcloud) with an app password; calendars and events, writes zoned by who the attendees are. |

## Legacy

[`legacy/`](legacy/) holds the handbooks written before v5 (v4, mostly in
French). They are kept for history and are not maintained: each is
`status: legacy`, has no `tracks:` and opens with a legacy banner. The mapping
below is the first amendment of ADR
[legacy-status-of-v4-adrs-and-handbooks](../decisions/legacy-status-of-v4-adrs-and-handbooks.md).

| Legacy file                                                                                              | Replaced by                                                                                           |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [legacy/auth-github-sso.md](legacy/auth-github-sso.md)                                                   | [authentication](authentication.md)                                                                   |
| [legacy/mcp-gateway.md](legacy/mcp-gateway.md)                                                           | [execution-door](execution-door.md) and [gateway-core](gateway-core.md)                               |
| [legacy/escalation.md](legacy/escalation.md)                                                             | [requests](requests.md), the closest successor (the escalation concept itself is dropped in v5)       |
| [legacy/github-provider.md](legacy/github-provider.md)                                                   | [providers/github](providers/github.md)                                                               |
| [legacy/vercel-provider.md](legacy/vercel-provider.md)                                                   | [providers/vercel](providers/vercel.md)                                                               |
| [legacy/railway-provider.md](legacy/railway-provider.md)                                                 | [providers/railway](providers/railway.md)                                                             |
| [legacy/bash-provider.md](legacy/bash-provider.md)                                                       | [providers/ssh](providers/ssh.md)                                                                     |
| [legacy/railway-ssh.md](legacy/railway-ssh.md)                                                           | [providers/ssh](providers/ssh.md), and [providers/railway](providers/railway.md) for the Railway half |
| [legacy/web-app.md](legacy/web-app.md)                                                                   | [web-app](web-app.md)                                                                                 |
| [legacy/integrations-submission-kit.md](legacy/integrations-submission-kit.md)                           | [`CONTRIBUTING.md`](../../CONTRIBUTING.md) and [`plugins/README.md`](../../plugins/README.md)         |
| [legacy/permission-threat-model-state-of-the-art.md](legacy/permission-threat-model-state-of-the-art.md) | None: a research note, moved with the others.                                                         |
