---
title: Railway provider plugin
status: current
date: 2026-10-13
last_synced: 2026-10-13
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
    data-model.ts        plane `runtime`, 10 entities (one virtual marker)
    tools.ts             railwayTools = upstream-tools.json (10) + custom-tools.ts (4)
    upstream-tools.json  the 10 frozen upstream declarations
    custom-tools.ts      the 4 GraphQL variable tools
    classify.ts          classifyRailway(tool, args, resources) — security-critical, pure
    credential.ts        railwayCredentialSpec
    execute.ts           executeRailway, discoverRailwayResources, executeCall, callUpstream,
                         callGraphql, parseFirstJsonRpcFrame
  tests/unit/
    plugin.test.ts           kit, classifier on Resource[], credential, execute, discover (30)
    classify.test.ts         per-tool slices of classifyRailway (22)
    risk-catalog.test.ts     catalog shape and risksTouchedBy (19)
    policy.test.ts           decisions of the gateway core, preset by preset (39)
    data-model.test.ts       data-model integrity (1)
```

## Data model and resources

One plane, `runtime`: `account → project → environment → service →
deployment → {logs, status}`, `service-var` under `service` (service-scoped
and project-shared variables alike), `agent-session` under `account`.
`service-var-replace`, also under `service`, is not a Railway object: it is
the marker the classifier writes when a call replaces every variable of its
scope, so the destructive case has a slice of its own.

The **resource is the Railway project** (UUID). `discoverResources` pages
the GraphQL `projects` connection (100 per page, 5 pages max) and returns
`{ ref: project.id, displayName: project.name, metadata: { environments:
[{ id, name }] } }`. The owner labels each project with a Vaubaan
environment (`prod`, `staging`, `preview`, `dev`); Railway's own environment
names stay in `metadata` for display, and the environment ids are what the
classifier checks `environmentId` against (below).

### An unlabelled project cannot run env-scoped operations

`read-variables`, `deploy` and `upsert-variable` are env-scoped
(`acceptable_in_envs: [staging, preview, dev, prod]`). The policy engine
refuses a call that touches an env-scoped risk on a resource whose label is
absent or outside that list — the risk is never dropped from the set, so no
broader risk carries the call alone and no accepted risk opens it. On a
Railway project this means:

- **no label** — `list-variables`, `redeploy`, `accept-deploy`, the three
  variable writes and `railway-agent` are refused for every mission. Reads
  of the account, services, deployments, status and logs still work;
- **a label outside the list** (`production`, `prd`, `test`…) — same
  refusals. The four labels above are the only ones the catalog knows.

The refusal is `risk-not-accepted`, its hint names the risk and says the
resource has no environment label (or which label it has). The remedy is
the owner's: label the project on the connection page with one of the four
environments. Re-issuing the mission does not help.

One label covers the whole project, whichever Railway environment
`environmentId` names: a project labelled `staging` whose Railway
`production` environment is targeted classifies as `railway[staging].…`.
Label a project by its most sensitive environment, or keep production in a
project of its own.

## Classification

`classifyRailway(tool, args, resources)`:

| Tools                                                                 | Slice shape                                                                | Risks                                           |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------- |
| `whoami`, `list-projects`                                             | `account[*].R`, `account[*].project[*].R`                                  | `read-account`                                  |
| `create-project`                                                      | `account[*].project.W`                                                     | `create-project`                                |
| `list-services`, `list-deployments`, `get-status`                     | `project[P].environment[*].service[…]….R`                                  | `read-runtime`                                  |
| `get-logs`                                                            | `…service[S].deployment[*].logs.R`                                         | `read-runtime` + `read-logs`                    |
| `redeploy`, `accept-deploy`                                           | `project[P].environment[E].service[S].deployment.W`                        | `deploy` (env-scoped)                           |
| `list-variables`                                                      | `project[P].environment[E].service-var[*].R`                               | `read-runtime` + `read-variables` (env-scoped)  |
| `upsert-variable`, `delete-variable`, `upsert-variables` (no replace) | `…service[S].service-var[NAME,…].W`                                        | `upsert-variable` (env-scoped)                  |
| `upsert-variables` with `replace` set (or empty payload)              | `…service[S].service-var[*].W` + `…service[S].service-var-replace.W`       | `upsert-variable` + `bulk-variables-replace`    |
| `railway-agent`                                                       | `account[*].agent-session.W` + deployment, variable and replace catch-alls | `agent-action` + `deploy` + both variable risks |

`P` is the project ref, `E` the **owner label** of that project (a wildcard
when unlabelled — see above for what that refuses), `S` the `serviceId` or
a wildcard. Resolution of `P`: `args.projectId` must be one of the
mission's Railway resources; when absent, the single Railway resource of
the mission; otherwise the project whose discovered environments contain
`args.environmentId` (the only way for `accept-deploy`, whose upstream
schema has no `projectId`); anything else is `denied` ("ambiguous railway
target").

**`environmentId` is bound to `P`.** The id is forwarded upstream as given
and the OAuth token reaches every project of the workspace, so whichever
way the project was resolved, an `environmentId` argument must be one of
the environments discovery stored on that project
(`metadata.environments`). Otherwise the call is denied: "not an
environment of railway project …" when the list does not contain it, "the
environments of railway project … are unknown" when the list is empty or
absent (refresh the connection's resources). `accept-deploy` has nothing
else to designate its target, so a missing `environmentId` is denied there.

**Variable writes.** A write of named variables — `upsert-variable`,
`delete-variable`, `upsert-variables` listing its keys — emits
`service-var[NAME,…].W` and touches `upsert-variable` alone.
`bulk-variables-replace` matches one slice only, the
`service-var-replace.W` marker, which `upsert-variables` emits when
`replace` is anything but absent or `false` (a non-boolean is not trusted
to mean "no") and when `variables` is empty or not an object; the variable
leaf is then a wildcard. `railway-agent` always emits it. A missing or
empty `name` on `upsert-variable` / `delete-variable` is denied.

Identifiers embedded in a slice (`serviceId`, variable names) must match
`[a-zA-Z0-9_./~-]+` or the call is denied. An unknown tool is denied.

## Catalog and presets

`risk-catalog.yaml` (`catalog_version: 3`) keeps the nine v4 risk ids and
the fallback. Changes in v5: English labels; `read-variables` becomes
env-scoped (`acceptable_in_envs: [staging, preview, dev, prod]`), like
`deploy` and `upsert-variable`; version 3 repoints the pattern of
`bulk-variables-replace` from `…service-var[*].W` — which every variable
write intersected, so the `developer` preset could write no variable — to
the `…service-var-replace.W` marker. No risk id changed. Presets (default
suggestions, the creator adjusts):

- `read-only` — `read-account`, `read-runtime`, `read-logs`. No variable
  values, no write.
- `developer` — reads, `read-variables`, `deploy` and `upsert-variable` on
  `dev` / `preview` / `staging` with `auto`; `railway[prod].deploy` and
  `railway[prod].upsert-variable` with `approval` and small quotas.
- `operator` — everything above with larger quotas, plus
  `railway[prod].read-variables` (`auto`, small quota), and
  `bulk-variables-replace` and `create-project` under `approval`.

`agent-action` is in no preset: explicit opt-in only, and the agent also
needs `deploy`, `upsert-variable` and `bulk-variables-replace` — so
`developer` plus `agent-action` is still refused.

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
- **`environmentId: not an environment of railway project '…'.`** — the
  environment belongs to another project, or was created after discovery;
  in the second case refresh the connection's resources.
- **`environmentId: the environments of railway project '…' are unknown`** —
  the stored resource carries no `metadata.environments` (discovered before
  the field existed, or the project has no environment). Refresh the
  connection's resources.
- **`risk-not-accepted` whose hint says "a resource with no environment
  label"** (or "labelled '…'") — the project is unlabelled, or labelled
  outside `staging` / `preview` / `dev` / `prod`. The owner labels the
  project; no mission policy can lift this.
- **`risk-not-accepted` naming `railway.bulk-variables-replace`** on a
  variable write — the call set `replace`, sent an empty `variables`, or is
  a `railway-agent` call. Send the named variables without `replace`.
- **`UpstreamAuthError` on every call** — token expired and the host did
  not refresh, or the token lacks the MCP audience (`resource=` missing on
  the authorize or token request). Check the stored `expiresAt` and that the
  host sends `resourceIndicator` on the refresh request.
- **`Railway GraphQL 401`** on variable tools or discovery — backboard
  refused the MCP-audience token; see the empirical caveat above.

## Tests

`npx vitest run plugins/railway` — 111 tests. `plugin.test.ts` (30)
runs the kit (`assertPluginWellFormed`, `assertPresetsValid`,
`assertNoWildcard`, `assertCatalogCoverage` with every risk touched),
classifier branches on `Resource[]` (including the `environmentId`
binding), the credential spec, `execute` and `discoverResources` against
`mockFetch`. `classify.test.ts` (22) pins the slices of each tool,
`risk-catalog.test.ts` (19) the catalog shape and `risksTouchedBy`,
`data-model.test.ts` (1) the data model. `policy.test.ts` (39) runs the
real classifier and catalog through the gateway decision core
(`evaluateCallForToken`) with the accepted risks of each shipped preset: a
decision per sample call for `read-only`, `developer` and `operator` on
each environment, the risks each variable write touches, the refusal of
env-scoped operations on an unlabelled or mislabelled project, and the
`environmentId` binding. No test reaches Railway.

## References

- Spec: [`vaubaan-gateway.md`](../../spec/vaubaan-gateway.md) §0, §3.2, §5;
  [`gateway-risk-model.md`](../../spec/gateway-risk-model.md) §2, §4, §7.
- Handbooks: [[plugin-sdk]], [[policy-engine]]. Previous modelling notes
  (v4, French, archived as legacy): [`railway-ssh.md`](../legacy/railway-ssh.md).
