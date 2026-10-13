---
title: Railway provider plugin
status: current
date: 2026-10-13
tracks:
  - plugins/railway/src/
  - plugins/railway/tests/
  - plugins/railway/README.md
---

# Railway — `@vaubaan/plugin-railway`

The Railway plugin on the v5 Plugin SDK (feature P1.2d). It rewraps the
official Railway MCP server (`mcp.railway.com`) and adds four GraphQL
variable tools, authenticates through the company's Railway Auth app
(OAuth2 + PKCE, refresh on the hot path), discovers projects as resources
and ships three presets. ADRs: [[railway-rewrap-remote-mcp]] (why rewrap,
audience binding, refresh) and [[plugin-contract-and-credential-spec]]
(the contract). Contributor guide: [`plugins/railway/README.md`](../../../plugins/railway/README.md).

## Layout

```
plugins/railway/
  src/
    index.ts             definePlugin({...})
    risk-catalog.yaml    9 risks + fallback, 3 presets — the only catalog artefact
    data-model.ts        plane `runtime`, 9 entities
    tools.ts             railwayTools = upstream-tools.json (10) + custom-tools.ts (4)
    classify.ts          classifyRailway(tool, args, resources) — security-critical, pure
    credential.ts        railwayCredentialSpec
    execute.ts           executeRailway, discoverRailwayResources, callUpstream, callGraphql
  tests/unit/
    plugin.test.ts           kit, classifier on Resource[], credential, execute, discover (27)
    classify.test.ts         per-tool slices of classifyRailway (20)
    risk-catalog.test.ts     catalog shape and risksTouchedBy (15)
    data-model.test.ts       data-model integrity (1)
```

## Data model and resources

One plane, `runtime`: `account → project → environment → service →
deployment → {logs, status}`, `service-var` under `service` (service-scoped
and project-shared variables alike), `agent-session` under `account`.

The **resource is the Railway project** (UUID). `discoverResources` pages
the GraphQL `projects` connection (100 per page, 5 pages max) and returns
`{ ref: project.id, displayName: project.name, metadata: { environments:
[{ id, name }] } }`. The owner labels each project with a Vaubaan
environment (`prod`, `staging`, `preview`, `dev`); Railway's own environment
names stay in `metadata` for display and for the `environmentId` lookup
below.

## Classification

`classifyRailway(tool, args, resources)`:

| Tools                                                                 | Slice shape                                                       | Risks                                           |
| --------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------- |
| `whoami`, `list-projects`                                             | `account[*].R`, `account[*].project[*].R`                         | `read-account`                                  |
| `create-project`                                                      | `account[*].project.W`                                            | `create-project` (+ fallback)                   |
| `list-services`, `list-deployments`, `get-status`                     | `project[P].environment[*].service[…]….R`                         | `read-runtime`                                  |
| `get-logs`                                                            | `…service[S].deployment[*].logs.R`                                | `read-runtime` + `read-logs`                    |
| `redeploy`, `accept-deploy`                                           | `project[P].environment[E].service[S].deployment.W`               | `deploy` (env-scoped)                           |
| `list-variables`                                                      | `project[P].environment[E].service-var[*].R`                      | `read-runtime` + `read-variables` (env-scoped)  |
| `upsert-variable`, `delete-variable`, `upsert-variables` (no replace) | `…service[S].service-var[NAME,…].W`                               | `upsert-variable` (env-scoped)                  |
| `upsert-variables` with `replace: true` (or empty payload)            | `…service[S].service-var[*].W`                                    | `upsert-variable` + `bulk-variables-replace`    |
| `railway-agent`                                                       | `account[*].agent-session.W` + deployment and variable catch-alls | `agent-action` + `deploy` + both variable risks |

`P` is the project ref, `E` the **owner label** of that project (a wildcard
when unlabelled), `S` the `serviceId` or a wildcard. Resolution of `P`:
`args.projectId` must be one of the mission's Railway resources; when
absent, the single Railway resource of the mission; otherwise the project
whose discovered environments contain `args.environmentId` (the only way
for `accept-deploy`, whose upstream schema has no `projectId`); anything
else is `denied` ("ambiguous railway target"). Identifiers embedded in a
slice (`serviceId`, variable names) must match `[a-zA-Z0-9_./~-]+` or the
call is denied. An unknown tool is denied.

## Catalog and presets

`risk-catalog.yaml` (`catalog_version: 2`) keeps the nine v4 risk ids and
the fallback. Changes in v5: English labels; `read-variables` becomes
env-scoped (`acceptable_in_envs: [staging, preview, dev, prod]`), like
`deploy` and `upsert-variable`. Presets (default suggestions, the creator
adjusts):

- `read-only` — `read-account`, `read-runtime`, `read-logs`. No variable
  values, no write.
- `developer` — reads, `read-variables`, `deploy` and `upsert-variable` on
  `dev` / `preview` / `staging` with `auto`; `railway[prod].deploy` and
  `railway[prod].upsert-variable` with `approval` and small quotas.
- `operator` — everything above plus `railway[prod].read-variables`,
  `bulk-variables-replace` and `create-project` under `approval`.

`agent-action` is in no preset: explicit opt-in only.

## Credential and refresh

`railwayCredentialSpec` is `oauth2`: `authorizationUrl`
`https://backboard.railway.com/oauth/auth`, `tokenUrl`
`https://backboard.railway.com/oauth/token`, scopes `openid offline_access
workspace:member`, `pkce: true`, `clientAuthMethod: client_secret_basic`,
`resourceIndicator: https://mcp.railway.com` (RFC 8707 — without it the
MCP server refuses the token), `extraAuthorizationParams: { prompt:
consent }` (otherwise no refresh token), `refreshable: true`. The host runs
the flow with the company's Auth app (`client_id` / `client_secret` from
the instance configuration) and stores `{ accessToken, refreshToken,
expiresAt, scopes }`.

Access tokens last one hour, so refresh is on the hot path — and it is the
standard RFC 6749 `refresh_token` grant with Basic client authentication
plus the same `resource=https://mcp.railway.com` indicator, which the host
performs from `tokenUrl`, `clientAuthMethod` and `resourceIndicator`. The
plugin therefore declares `refreshable: true` and implements no `refresh`
(P1.2-align removed `refreshRailwayCredential` and `railwayNeedsRefresh`).
The plugin never persists: the host refreshes and stores the result.

## Execution

`executeRailway(ctx, tool, args)` narrows the secret with
`expectCredentialKind('railway', …, 'oauth2')`, fills `projectId` from the
single mission project when the tool's schema takes one and the argument is
absent (throws when several projects), then:

- upstream tools → JSON-RPC `tools/call` to `https://mcp.railway.com/` with
  the `railway__` prefix stripped, headers `Authorization: Bearer`,
  `Accept: application/json, text/event-stream`, `MCP-Protocol-Version:
2025-06-18`; the SSE frame (or bare JSON) is parsed and the MCP result
  passed through. `railway-agent` answers get `RAILWAY_AGENT_HINT` appended
  (the agent stages, `accept-deploy` commits);
- variable tools → GraphQL `variables` / `variableUpsert` /
  `variableCollectionUpsert` / `variableDelete` on
  `https://backboard.railway.com/graphql/v2`, returned as JSON text.

401/403 from either upstream → `UpstreamAuthError`. Whether backboard
accepts the MCP-audience token is still empirical (same assumption as v4);
a refusal surfaces as `UpstreamAuthError` with the upstream message.

## How to debug

- **Boot fails with `Invalid risk catalog`** — the YAML lost its v5 shape
  (`provider`, `risks`, `presets`); the message lists the exact paths.
- **`ambiguous railway target: specify projectId.`** — the mission has
  several Railway projects and the call named neither `projectId` nor an
  `environmentId` found in one project's discovered environments. Refresh
  the connection's resources if the environment was created after
  discovery.
- **`railway project '…' is not a resource of this mission.`** — the agent
  cited a project the mission does not select.
- **`UpstreamAuthError` on every call** — token expired and the host did
  not refresh, or the token lacks the MCP audience (`resource=` missing on
  the authorize or token request). Check the stored `expiresAt` and that the
  host sends `resourceIndicator` on the refresh request.
- **`Railway GraphQL 401`** on variable tools or discovery — backboard
  refused the MCP-audience token; see the empirical caveat above.

## Tests

`npx vitest run plugins/railway` — 63 tests. `plugin.test.ts` (27)
runs the kit (`assertPluginWellFormed`, `assertPresetsValid`,
`assertNoWildcard`, `assertCatalogCoverage` with every risk touched),
classifier branches on `Resource[]`, the credential spec, `execute` and
`discoverResources` against `mockFetch`. `classify.test.ts` (20) pins the
slices of each tool, `risk-catalog.test.ts` (15) the catalog shape and
`risksTouchedBy`, `data-model.test.ts` (1) the data model. No test reaches
Railway.

## References

- Spec: [`vaubaan-gateway.md`](../../spec/vaubaan-gateway.md) §0, §3.2, §5;
  [`gateway-risk-model.md`](../../spec/gateway-risk-model.md) §2, §4, §7.
- Handbooks: [[plugin-sdk]], [[policy-engine]]. Previous modelling notes
  (v4, French): [`railway-ssh.md`](./railway-ssh.md) §2 now covers SSH only.
