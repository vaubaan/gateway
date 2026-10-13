# Vaubaan Gateway

> Open source, on-prem **MCP gateway** for coding agents. Agents never hold a
> cloud credential: they hold a **mission token** with a **risk budget**, and
> the gateway executes each tool call upstream only if the mission's policy,
> budget and approval rules allow it, then writes an immutable audit row.

**v5 is under construction on the `v5` integration branch (public product
name: v2).** The last v4 SaaS release is tag
[`v4-final`](https://github.com/sbw-vaubaan/vaubaan-gateway/releases/tag/v4-final).
Nothing on `main` or `v5` is deployable yet.

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

- **One door for agents.** `POST /mcp` (MCP Streamable HTTP, stateless)
  with `Authorization: Bearer <mission token>`: `tools/list`, `tools/call`,
  and `GET /mcp/catalog` for the resources and the remaining budget. The
  human interface (`/connections`, `/missions`, `/requests`, `/admin`) opens
  with a browser session only; neither credential opens the other surface.

The full picture is in the spec; the reasoning is in the pivot ADR.

## Layout

```
apps/gateway/        the deployable: server + Next.js UI       @vaubaan/gateway-app
packages/shared/     risk types, api-key, data-model            @vaubaan/shared
packages/policy-engine/  slice DSL, matcher, evaluator, runtime @vaubaan/policy-engine
packages/gateway-core/   pipeline, decisions, refusals, audit   @vaubaan/gateway-core
packages/plugin-sdk/     the plugin contract, registry, test kit @vaubaan/plugin-sdk
plugins/<provider>/  one provider plugin per folder             @vaubaan/plugin-<provider>
deploy/              Dockerfile, compose, example configuration
docs/                spec, decisions (ADRs), handbook, tests, workflow
```

Workspaces: `apps/*`, `packages/*`, `plugins/*` (npm). Node >= 20.

```bash
npm ci
npm run ci        # type-check, lint, format check, tests, build
```

Running an instance (Docker image, Compose with TLS proxy, every
configuration key): [`deploy/README.md`](deploy/README.md).

## Documentation

| Pillar    | Where                                                                                                                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spec      | [`docs/spec/vaubaan-gateway.md`](docs/spec/vaubaan-gateway.md) (v5), [`docs/spec/gateway-risk-model.md`](docs/spec/gateway-risk-model.md)                                                                                 |
| Decisions | [`docs/decisions/`](docs/decisions/) — start with [the v4 → v5 pivot](docs/decisions/pivot-v4-to-v5-on-prem-mission-tokens.md) and [the repository layout](docs/decisions/repository-layout-and-contribution-workflow.md) |
| Handbook  | [`docs/handbook/`](docs/handbook/) — how things actually work (v4 documents carry a legacy banner until rewritten)                                                                                                        |
| Tests     | [`docs/tests/`](docs/tests/)                                                                                                                                                                                              |
| Workflow  | [`docs/workflow/coding-workflow.md`](docs/workflow/coding-workflow.md)                                                                                                                                                    |

Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md). Security:
[`SECURITY.md`](SECURITY.md). Changes: [`CHANGELOG.md`](CHANGELOG.md).

## Licence

[Apache-2.0](LICENSE). Copyright 2026 Vaubaan contributors.
