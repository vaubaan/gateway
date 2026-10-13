# Vaubaan Gateway

> Open source, on-prem **MCP gateway** for coding agents. Agents never hold a
> cloud credential: they hold a **mission token** with a **risk budget**, and
> the gateway executes each tool call upstream only if the mission's policy,
> budget and approval rules allow it, then writes an immutable audit row.

**v5 (public product name: v2) is in pre-release on the `v5` integration
branch.** That branch builds a runnable image, and
[`deploy/README.md`](deploy/README.md) documents running it. No v2 release is
tagged yet and no image is published; moving an existing v4 deployment over
is a separate step. The last v4 SaaS release is tag
[`v4-final`](https://github.com/sbw-vaubaan/vaubaan-gateway/releases/tag/v4-final).

## What v5 is

- **One instance per company**, run on your own network as a single process
  with an embedded store. No tenant, no org, no SaaS.
- **Humans sign in through your identity provider** (OpenID Connect).
  Connections to providers (GitHub, Vercel, Supabase, Railway, Stripe,
  Resend, Cloudflare DNS, Upstash Redis, Gmail, SSH) belong to users or
  groups and can be shared with restrictions.
- **Missions, not tokens with scopes.** A mission selects connections and
  resources, and gives each risk of the provider catalogs a budget
  (quota, rate, period) and a gate (`auto` or `approval`). Orchestrator and
  sub-agents share one mission token and one budget.
- **Structured refusals** tell the agent why a call was refused and where a
  human can grant more; the human answers from an inbox, never from the
  agent's terminal.
- **Two doors for agents, three credentials that never cross.** The
  execution door, `POST /mcp` (MCP Streamable HTTP, stateless) with
  `Authorization: Bearer <mission token>`: `tools/list`, `tools/call`, and
  `GET /mcp/catalog` for the resources and the remaining budget. The
  management door, `POST /mcp/manage`, for an agent a user authorized
  through OAuth (the instance is its own authorization server): it lists the
  user's connections and missions, previews a policy and issues, rotates or
  revokes a mission within the user's authority — it executes nothing and
  grants nothing. The human interface (`/connections`, `/shares`,
  `/missions`, `/requests`, `/audit`, `/delegations`, `/admin`) opens with a
  browser session only. A mission token, a delegated token and a session
  each open their own surface and are refused by kind on the others.

The full picture is in the spec; the reasoning is in the pivot ADR.

## Layout

```
apps/gateway/        the deployable: server + Next.js UI       @vaubaan/gateway-app
packages/shared/     risk types, api-key, data-model            @vaubaan/shared
packages/policy-engine/  slice DSL, matcher, evaluator, runtime @vaubaan/policy-engine
packages/gateway-core/   pipeline, decisions, refusals, audit   @vaubaan/gateway-core
packages/plugin-sdk/     the plugin contract, registry, test kit @vaubaan/plugin-sdk
packages/telemetry/      opt-in report, queue, client (off by default) @vaubaan/telemetry
plugins/<provider>/  one provider plugin per folder             @vaubaan/plugin-<provider>
plugins/_template/   scaffold for a new plugin                  @vaubaan/plugin-template
deploy/              Dockerfile, compose, example configuration
scripts/             gen-master-key.mjs (npm run gen-master-key)
docs/                spec, decisions (ADRs), handbook, tests, workflow
```

Workspaces: `apps/*`, `packages/*`, `plugins/*` (npm). Node >= 20.

```bash
npm ci
npm run ci        # type-check, lint, format check, build, tests
npm run demo      # the whole interface on http://localhost:3210, simulated IdP and providers (docs/handbook/demo-mode.md)
```

Running an instance (Docker image, Compose with TLS proxy, every
configuration key): [`deploy/README.md`](deploy/README.md).

## Documentation

| Pillar    | Where                                                                                                                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spec      | [`docs/spec/vaubaan-gateway.md`](docs/spec/vaubaan-gateway.md) (v5), [`docs/spec/gateway-risk-model.md`](docs/spec/gateway-risk-model.md)                                                                                 |
| Decisions | [`docs/decisions/`](docs/decisions/) — start with [the v4 → v5 pivot](docs/decisions/pivot-v4-to-v5-on-prem-mission-tokens.md) and [the repository layout](docs/decisions/repository-layout-and-contribution-workflow.md) |
| Handbook  | [`docs/handbook/`](docs/handbook/) — how things actually work, listed below (pre-v5 handbooks are kept under [`docs/handbook/legacy/`](docs/handbook/legacy/))                                                            |
| Tests     | [`docs/tests/`](docs/tests/)                                                                                                                                                                                              |
| Workflow  | [`docs/workflow/coding-workflow.md`](docs/workflow/coding-workflow.md)                                                                                                                                                    |

Handbooks: [configuration](docs/handbook/configuration.md), [store](docs/handbook/store.md), [authentication](docs/handbook/authentication.md), [connections](docs/handbook/connections.md), [missions](docs/handbook/missions.md), [authority](docs/handbook/authority.md), [budget-and-sessions](docs/handbook/budget-and-sessions.md), [execution-door](docs/handbook/execution-door.md), [management-door](docs/handbook/management-door.md), [requests](docs/handbook/requests.md), [audit](docs/handbook/audit.md), [web-app](docs/handbook/web-app.md), [gateway-core](docs/handbook/gateway-core.md), [policy-engine](docs/handbook/policy-engine.md), [plugin-sdk](docs/handbook/plugin-sdk.md), [telemetry](docs/handbook/telemetry.md), [cutover-from-v4](docs/handbook/cutover-from-v4.md), and one per provider under [providers](docs/handbook/providers/README.md). Writing a plugin: [`plugins/README.md`](plugins/README.md).

Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md). Security:
[`SECURITY.md`](SECURITY.md). Changes: [`CHANGELOG.md`](CHANGELOG.md).

## Licence

[Apache-2.0](LICENSE). Copyright 2026 Vaubaan contributors.
