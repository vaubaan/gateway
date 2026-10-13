# Vaubaan Gateway

Vaubaan Gateway is a server you install on your own network so that coding
agents can use your cloud services (GitHub, Supabase, Vercel, Stripe and
others) through MCP without being handed your credentials. A person issues a
**mission**: the resources the agent may touch, the risks they accept, how
many times and how fast each may be taken, and which actions they want to
approve one by one. The gateway checks every tool call against the mission,
runs it with a credential that stays on the instance, and writes an audit
entry, allowed or refused.

## Status

**Pre-release.** No version of this code base is tagged, no image is published, and the
software has not yet been run in production; the first real deployment is
still to be done ([cutover handbook](docs/handbook/cutover-from-v4.md)).
Expect breaking changes until a `v2.0.0` tag exists. This code base is
called **v5** in its design documents and will be released as **v2**; it
replaces an earlier hosted product and shares no data with it.

What exists today: sign-in through your identity provider, connections with
resources, shares and groups, missions with a budget and a gate per risk,
both MCP doors, requests and approvals, the audit, a plugin per provider
(named in the diagram below), a Docker image built from source, a release
pipeline that has not yet produced a release, and a demo that runs on a
laptop.

## Who it is for

- **A team that lets coding agents act on real infrastructure** and wants a
  boundary it can read: "write on feature branches, never merge; apply
  migrations on staging, ask me before production".
- **A company that will not hand its cloud tokens to a third party.** The
  instance runs on your network, behind your identity provider, with your
  own provider apps. There is no hosted service and no tenant.
- **Someone who must answer "what did the agent do?"** Every call is
  recorded with the risks it touched and the decision taken.

It is not a secrets manager, not a proxy for CLIs or SDKs (only MCP is
intercepted), and not highly available: one process, one embedded database.

## Quick start

### A quick look

Needs Node.js 20 or later and npm 10. Nothing to register, nothing leaves
your machine: the identity provider and the providers are simulated.

```bash
git clone https://github.com/sbw-vaubaan/vaubaan-gateway.git
cd vaubaan-gateway
npm ci
npm run demo
```

The last command builds the application, then prints a URL
(`http://localhost:3210`), three demo accounts without passwords, mission
tokens and ready-made `curl` commands. Use Chrome or Firefox. `DEMO_PORT=4000
npm run demo` picks another port. The demo is a development tool, never an
instance: anybody who reaches it signs in as anybody. Details and a guided
tour: [demo mode](docs/handbook/demo-mode.md).

### Install an instance

Needs Docker with Compose v2, a DNS name pointing at the host, and ports 80
and 443 reachable (the bundled proxy obtains the TLS certificate), plus
Node.js on the host for the key-generation script. You also need an OpenID
Connect client at your identity provider.

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
and configure your identity provider.

- Every step, running the image without Compose, operations, upgrades,
  and, once a release exists, pulling a published image by tag and
  verifying its provenance: [`deploy/README.md`](deploy/README.md).
- Which version runs: the footer of every page and `GET /healthz` show the
  version and the commit.
- Every configuration key:
  [configuration handbook](docs/handbook/configuration.md).
- Registering your identity provider and provider apps, issuing the first
  missions, pointing an MCP client at the instance: the
  [cutover handbook](docs/handbook/cutover-from-v4.md) is the checklist
  (written for the move from the earlier hosted product; its preparation and
  verification steps apply to any first installation).

## How it works

```
  coding agent                agent acting for a user              human
  (Claude Code, Cursor,       (prepares missions)                  (browser)
   a script)
       │ mission token              │ delegated token (OAuth)        │ session
       ▼                            ▼                                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ Vaubaan Gateway — one instance, one company, one process                 │
│                                                                          │
│  EXECUTION DOOR          MANAGEMENT DOOR           WEB INTERFACE         │
│  POST /mcp               POST /mcp/manage          /connections /shares  │
│  tools/list, tools/call  read authority, preview,  /missions /requests   │
│  GET /mcp/catalog        issue / rotate / revoke   /audit /delegations   │
│                          a mission                 /admin                │
│       │                  never executes,           sign-in through your  │
│       │                  never approves            identity provider     │
│       ▼                                                                  │
│  the call pipeline                                                       │
│   1 mission active?  resource in the mission?  connection usable?        │
│   2 plugin classifies the call  →  slices                                │
│   3 catalog: slices → risks touched  ⊆  risks the mission accepts?       │
│   4 budget (quota, rate limit) and gate (auto / approval)                │
│   5 decrypt the credential in memory, call the provider, release it      │
│   6 audit entry, allowed or refused                                      │
│       │                                              │                   │
│       ▼                                              ▼                   │
│  PLUGINS (one per provider)                 STORE (embedded database)    │
│  data model · classifier · risk catalog     connections, credentials     │
│  with presets · executor                    encrypted under your master  │
│  github, vercel, supabase, railway,         key, shares, missions,       │
│  stripe, resend, cloudflare-dns,            sessions and counters,       │
│  upstash-redis, ssh, gmail (experimental)   requests, audit              │
└──────────────────────────────────────────────────────────────────────────┘
       │ ephemeral or decrypted credential, used for the call
       ▼
   provider APIs
```

**Two MCP doors.** The execution door runs provider tools for a mission.
The management door lets an agent a user authorized through OAuth read that
user's authority and issue missions under their name; it executes nothing
and grants nothing.

**Three credentials that never cross.** A _mission token_ opens the
execution door only. A _delegated token_ opens the management door only. A
_browser session_ opens the web interface only, and it is the only place a
request is answered. Each is refused by kind at the other two, so an agent
can neither widen its own mission nor approve its own action.

**Refusals are structured.** `risk-not-accepted`, `budget-exhausted`,
`approval-required` and the others tell the agent what happened and what to
do. An exhausted budget and an action to approve carry the URL where the
mission's creator decides. The gateway never holds a call waiting.

**One named exception to "no credential".** A few tools exist to hand the
agent a short-lived token, such as a GitHub installation token to clone or
push. Each is a risk of its own in the catalog, refused unless the mission
accepts it.

**Risks, not scopes.** Each plugin ships a catalog of named risks
(`github.merge-protected`, `supabase[staging].migration-write`) and presets
that pre-fill a mission. A mission stores an explicit list; nothing is ever
"all".

## Documentation

| If you want to…                                    | Read                                                                                                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| understand what the product does and why           | [`docs/spec/vaubaan-gateway.md`](docs/spec/vaubaan-gateway.md)                                                                                 |
| understand how a call becomes a set of risks       | [`docs/spec/gateway-risk-model.md`](docs/spec/gateway-risk-model.md)                                                                           |
| run an instance                                    | [`deploy/README.md`](deploy/README.md), [configuration](docs/handbook/configuration.md)                                                        |
| know how a part of the code works today            | [`docs/handbook/`](docs/handbook/README.md), one handbook per subsystem and per provider                                                       |
| know why something was decided                     | [`docs/decisions/`](docs/decisions/), starting with [the pivot to an on-prem gateway](docs/decisions/pivot-v4-to-v5-on-prem-mission-tokens.md) |
| see what is tested                                 | [`docs/tests/`](docs/tests/)                                                                                                                   |
| contribute, or write a plugin for another provider | [`CONTRIBUTING.md`](CONTRIBUTING.md), [`plugins/README.md`](plugins/README.md), [workflow](docs/workflow/coding-workflow.md)                   |
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
packages/policy-engine/  slices, matching, the risk decision
packages/gateway-core/   the call pipeline, refusals, the audit entry
packages/plugin-sdk/     the plugin contract, catalog loader, registry, test kit
packages/telemetry/      opt-in, anonymous plugin reports (off by default)
plugins/<provider>/      one provider plugin per folder; plugins/_template to start one
deploy/                  Dockerfile, Compose file, example configuration
docs/                    spec, decisions, handbook, tests, workflow
```

For development: `npm ci`, then `npm run ci` (type-check, lint, format
check, build, tests). Contributions target the `v5` branch until the first
release; the process is in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Licence

[Apache-2.0](LICENSE). Copyright 2026 Vaubaan contributors.
