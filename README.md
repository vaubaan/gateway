# Vaubaan Gateway

Vaubaan Gateway is a server you install on your own network so that coding
agents can use your cloud services (GitHub, Supabase, Vercel, Stripe and
others) through MCP without being handed your credentials. A person creates a
**mission**: the accounts and resources the agent may touch, the permissions
it holds, the limits of each (how many times per day, how fast), and which
actions must ask them first. The agent gets a **key** for that mission. The
gateway checks every tool call against the mission, runs it with a credential
that stays on the instance, and records it in the activity, allowed or
refused.

## Status

**Pre-release.** No version of this code base is tagged, no image is published, and the
software has not yet been run in production; the first real deployment is
still to be done ([cutover handbook](docs/handbook/cutover-from-v4.md)).
Expect breaking changes until a `v2.0.0` tag exists. This code base is
called **v5** in its design documents and will be released as **v2**; it
replaces an earlier hosted product and shares no data with it.

What exists today: sign-in through your identity provider, GitHub, or both at
once, with invitations for people outside your directory; accounts at your
cloud services with their resources, and access given to a teammate or a
team; missions with limits per permission and "ask me first" where you want
it, worked on alone or as a team, each person with their own key; both MCP
doors; "Waiting for you", where a mission's creator answers what an agent
asks; the activity record; a per-service reference of every permission and
preset; a plugin per service (named in the diagram below); a Docker image
built from source, a release pipeline that has not yet produced a release,
and a demo that runs on a laptop.

What has not been done or is not there, one line each:
[known limitations](docs/handbook/known-limitations.md).

## Who it is for

- **A team that lets coding agents act on real infrastructure** and wants a
  boundary it can read: "write on feature branches, never merge; apply
  migrations on staging, ask me before production".
- **A company that will not hand its cloud tokens to a third party.** The
  instance runs on your network, behind your identity provider, with the
  apps your company registered at each service. There is no hosted service
  and no tenant.
- **Someone who must answer "what did the agent do?"** Every call is
  recorded with the permissions it needed, whose key made it and the
  decision taken.

It is not a secrets manager, not a proxy for CLIs or SDKs (only MCP is
intercepted), and not highly available: one process, one embedded database.

## Quick start

### A quick look

Needs Node.js 20 or later and npm 10. Nothing to register, nothing leaves
your machine: the identity provider and the cloud services are simulated.

```bash
git clone https://github.com/vaubaan/gateway.git
cd vaubaan-gateway
npm ci
npm run demo
```

The last command builds the application (on the first start, and again
only when the sources changed), then prints a URL
(`http://localhost:3210`), three people to sign in as without a password,
the keys of seeded missions and ready-made `curl` commands. Use Chrome or Firefox. `DEMO_PORT=4000
npm run demo` picks another port. The demo is a development tool, never an
instance: anybody who reaches it signs in as anybody. Details and a guided
tour: [demo mode](docs/handbook/demo-mode.md).

### Install an instance

Needs Docker with Compose v2, a DNS name pointing at the host, and ports 80
and 443 reachable (the bundled proxy obtains the TLS certificate), plus
Node.js on the host for the key-generation script. You also need a client at
a sign-in provider: OpenID Connect at your identity provider, or a GitHub
OAuth App. On Railway, follow [deploy/railway.md](deploy/railway.md).

```bash
cp deploy/config/.env.example deploy/config/.env
cp deploy/config/gateway.example.yaml deploy/config/gateway.yaml
npm run gen-master-key     # prints the value for VAUBAAN_MASTER_KEY
openssl rand -hex 24       # prints a value for VAUBAAN_BOOTSTRAP_TOKEN
docker compose --env-file deploy/config/.env -f deploy/compose.yaml up -d --build
```

Before the last command, edit `deploy/config/.env`: `GATEWAY_DOMAIN`,
`VAUBAAN_PUBLIC_URL` (https, same host), `VAUBAAN_ADMIN_EMAILS`, and the two
secrets above. Anything missing stops the container with a message naming
the key. Then open `https://<your domain>/login`, follow the bootstrap link,
and add your sign-in provider.

- Every step, running the image without Compose, operations, upgrades,
  and, once a release exists, pulling a published image by tag and
  verifying its provenance: [`deploy/README.md`](deploy/README.md).
- Which version runs: the footer of every page and `GET /healthz` show the
  version and the commit.
- Every configuration key:
  [configuration handbook](docs/handbook/configuration.md).
- Registering your identity provider and your company apps, creating the
  first missions, pointing an MCP client at the instance: the
  [cutover handbook](docs/handbook/cutover-from-v4.md) is the checklist
  (written for the move from the earlier hosted product; its preparation and
  verification steps apply to any first installation).

## How it works

```
  coding agent                agent acting for a person            human
  (Claude Code, Cursor,       (a connected app:                    (browser)
   a script)                   prepares missions)
       │ mission key                │ delegated token (OAuth)        │ session
       ▼                            ▼                                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ Vaubaan Gateway — one instance, one company, one process                 │
│                                                                          │
│  EXECUTION DOOR          MANAGEMENT DOOR           WEB INTERFACE         │
│  POST /mcp               POST /mcp/manage          / (Now)  /waiting     │
│  tools/list, tools/call  read what the person may  /missions  /accounts  │
│  GET /mcp/catalog        allow, preview, create a  /activity  /reference │
│                          mission, replace its key, /settings  /admin     │
│       │                  stop it; never executes,  sign-in through your  │
│       │                  never answers a request   identity provider     │
│       ▼                                                                  │
│  the call pipeline                                                       │
│   1 mission running?  resource in the mission?  account usable?          │
│   2 plugin classifies the call  →  slices                                │
│   3 catalog: slices → permissions needed  ⊆  permissions of the mission? │
│   4 limits (per period, per minute) and "runs freely / ask me first"     │
│   5 decrypt the credential in memory, call the service, release it       │
│   6 activity record, allowed or refused                                  │
│       │                                              │                   │
│       ▼                                              ▼                   │
│  PLUGINS (one per service)                  STORE (embedded database)    │
│  data model · classifier · catalog of       accounts, credentials        │
│  permissions with presets · executor        encrypted under your master  │
│  one folder of plugins/ per service         key, accesses, missions,     │
│  (GitHub, Stripe, Supabase…;                keys (as digests), counters, │
│  the list: plugins/README.md)               requests, activity           │
└──────────────────────────────────────────────────────────────────────────┘
       │ ephemeral or decrypted credential, used for the call
       ▼
   the services' APIs
```

**Two MCP doors.** The execution door runs the tools of your services for a
mission. The management door lets an agent a person authorized through OAuth
(a _connected app_) read what that person may allow and create missions under
their name; it executes nothing and answers nothing.

**Three credentials that never cross.** A _mission key_ opens the execution
door only. A _delegated token_ opens the management door only. A _browser
session_ opens the web interface only, and it is the only place a request is
answered. Each is refused by kind at the other two, so an agent can neither
widen its own mission nor approve its own action.

**Refusals are structured.** `risk-not-accepted`, `budget-exhausted`,
`approval-required` and the others tell the agent what happened and what to
do. A limit that was reached and an action that asks first carry the URL
where the mission's creator answers; the creator also finds it under
"Waiting for you". The gateway never holds a call waiting.

**One named exception to "no credential".** A few tools exist to hand the
agent a short-lived token, such as a GitHub installation token to clone or
push. Each is a permission of its own in the catalog, refused unless the
mission holds it.

**Permissions, not scopes.** Each plugin ships a catalog of named permissions
(`github.merge-protected`, `supabase[staging].migration-write`), each with
the reason it exists and how severe it is, and presets that pre-fill a
mission. A mission stores an explicit list; nothing is ever "all". Reference,
in the interface, shows every one of them, service by service.

### Words

The interface speaks to people; the protocol — MCP tool names, refusal codes,
ids, the API, the database, the configuration, and the specification of the
domain — keeps the names it had. The same things, under both:

| In the interface                | In the protocol, the code and the spec                |
| ------------------------------- | ----------------------------------------------------- |
| account                         | connection                                            |
| access (Give access)            | share                                                 |
| permission                      | risk, by its `RiskId` (`github.merge-protected`)      |
| limits (per day, per minute)    | budget: quota and rate limit                          |
| runs freely / ask me first      | gate: `auto` / `approval`                             |
| key, machine key                | mission token: member token, named token              |
| Replace key                     | rotate                                                |
| Waiting for you                 | request: a claim (limit reached), an approval request |
| connected app                   | delegation, OAuth client                              |
| Activity                        | audit, session                                        |
| teammate, team                  | mission member, group                                 |
| administrator                   | operator                                              |
| service, company app, Reference | provider, provider app, the provider pages            |
| mission, preset                 | mission, preset                                       |

## Documentation

| If you want to…                                    | Read                                                                                                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| understand what the product does and why           | [`docs/spec/vaubaan-gateway.md`](docs/spec/vaubaan-gateway.md)                                                                                 |
| understand how a call becomes a set of permissions | [`docs/spec/gateway-risk-model.md`](docs/spec/gateway-risk-model.md)                                                                           |
| run an instance                                    | [`deploy/README.md`](deploy/README.md), [configuration](docs/handbook/configuration.md)                                                        |
| know how a part of the code works today            | [`docs/handbook/`](docs/handbook/README.md), one handbook per subsystem and per service                                                        |
| know why something was decided                     | [`docs/decisions/`](docs/decisions/), starting with [the pivot to an on-prem gateway](docs/decisions/pivot-v4-to-v5-on-prem-mission-tokens.md) |
| see what is tested                                 | [`docs/tests/`](docs/tests/)                                                                                                                   |
| contribute, or write a plugin for another service  | [`CONTRIBUTING.md`](CONTRIBUTING.md), [`plugins/README.md`](plugins/README.md), [workflow](docs/workflow/coding-workflow.md)                   |
| work on the repository with a coding agent         | [`docs/AGENTS-guide.md`](docs/AGENTS-guide.md)                                                                                                 |
| report a vulnerability                             | [`SECURITY.md`](SECURITY.md)                                                                                                                   |
| see what changed                                   | [`CHANGELOG.md`](CHANGELOG.md)                                                                                                                 |

Documents written before the on-prem version are kept under `legacy/`
folders, or carry a banner saying so; several are in French and none is
maintained.

## Repository layout

```
apps/gateway/            the deployable: both doors, the web interface, the store
packages/shared/         domain and risk types
packages/policy-engine/  slices, matching, the risk decision, the validity rule of a budget (protocol names)
packages/gateway-core/   the call pipeline, refusals, the audit entry
packages/plugin-sdk/     the plugin contract, catalog loader, registry, test kit
packages/telemetry/      opt-in, anonymous plugin reports (off by default)
plugins/<provider>/      one plugin per service; plugins/_template to start one
deploy/                  Dockerfile, Compose file, example configuration
docs/                    spec, decisions, handbook, tests, workflow
```

For development: `npm ci`, then `npm run ci` (type-check, lint, format
check, build, tests). Contributions target the `v5` branch until the first
release; the process is in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Licence

[Apache-2.0](LICENSE). Copyright 2026 Vaubaan contributors.
