---
title: Railway provider plugin
status: current
date: 2026-10-13
last_synced: 2026-10-14
tracks:
  - plugins/railway/src/token.ts
  - plugins/railway/src/user-agent.ts
  - plugins/railway/src/
  - plugins/railway/tests/
  - plugins/railway/README.md
---

# Railway — `@vaubaan/plugin-railway`

The Railway plugin on the v5 Plugin SDK (feature P1.2d). It rewraps the
official Railway MCP server (`mcp.railway.com`) and adds four GraphQL
variable tools, authenticates through the company's Railway Auth app
(OAuth2 + PKCE, refresh on the hot path), discovers projects as resources
and ships three presets. Plugin version 4.2.0. ADRs:
[[railway-rewrap-remote-mcp]] (why rewrap, audience binding, refresh),
[[plugin-contract-and-credential-spec]] (the contract) and
[`plugin-arguments-closed-surface-and-typed-refusals`](../../decisions/plugin-arguments-closed-surface-and-typed-refusals.md)
(undeclared arguments, services bound to their project, what the executor
declines). Contributor guide: [`plugins/railway/README.md`](../../../plugins/railway/README.md).

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
    plugin.test.ts           kit, classifier on Resource[], credential, execute, discover (31)
    classify.test.ts         per-tool slices of classifyRailway (22)
    risk-catalog.test.ts     catalog shape and risksTouchedBy (19)
    policy.test.ts           decisions of the gateway core, preset by preset (39)
    identifier-injection.test.ts  hostile ids and variable names on classify and execute (294)
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
[{ id, name }], services: [{ id, name }] } }`. Both lists are always
written, empty included. The owner labels each project with a Vaubaan
environment (`prod`, `staging`, `preview`, `dev`); Railway's own environment
names stay in `metadata` for display, and the environment and service ids
are what the classifier checks `environmentId` and `serviceId` against
(below).

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

`railway-agent` is also declared **unbound** (`unboundTools`): on an account that
can see the project hosting the gateway (`self_resources`, `RAILWAY_PROJECT_ID`) it
is unavailable whatever the mission — refused before the budget, left out of
`tools/list`, and the account page says so — since a free-text request to
Railway's agent cannot be held to the mission's projects (SEC 2026-10-15
re-check M-1).

The refusal is `risk-not-accepted`, its hint names the risk and says the
resource has no environment label (or which label it has). The remedy is
the owner's: label the project on the account's page (Accounts) with one of the four
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

**`environmentId` is bound to `P`.** The id is sent upstream
and the OAuth token reaches every project of the workspace, so whichever
way the project was resolved, an `environmentId` argument must be one of
the environments discovery stored on that project
(`metadata.environments`). Otherwise the call is denied: "not an
environment of railway project …" when the list does not contain it, "the
environments of railway project … are unknown" when the list is empty or
absent (refresh the connection's resources). `accept-deploy` has nothing
else to designate its target, so a missing `environmentId` is denied there.

**`serviceId` is bound to `P` the same way** (`readService`, `servicesOf`).
A service the project does not own would scope the call — a redeploy, a
variable write, the upstream agent's context — outside the mission while the
slice names the mission's project. A `serviceId` argument must therefore be
one of the services discovery stored on the project (`metadata.services`):

- not in the list → denied, "not a service of railway project … as last
  discovered" (a service created since then appears once the connection
  owner refreshes the resources);
- the resource carries no list at all → denied, "the services of railway
  project … are unknown". This is the state of a project discovered before
  services were recorded, and it is not the same as a project with no
  service, whose list is empty: **a connection made with an earlier plugin
  version must have its resources refreshed before a call can name a
  service**;
- no `serviceId` → nothing to bind; the slice carries a wildcard service.

**Only declared arguments.** The rewrapped tools forward their arguments
whole, so an argument the tool's schema does not declare is denied
(`undeclaredArgument`, over the SDK's `undeclaredArgumentDenial`):
`<name>: not an argument of '<tool>' — nothing classifies it, so it is not sent.`
`projectId` is the one routing argument: the classifier reads it for every
project-scoped tool whatever the schema declares, and `execute` writes it
again where the tool takes one and drops it elsewhere. The check comes right
after the unknown-tool check, before the target is resolved.

**Variable writes.** A write of named variables — `upsert-variable`,
`delete-variable`, `upsert-variables` listing its keys — emits
`service-var[NAME,…].W` and touches `upsert-variable` alone.
`bulk-variables-replace` matches one slice only, the
`service-var-replace.W` marker, which `upsert-variables` emits when
`replace` is anything but absent or `false` (a non-boolean is not trusted
to mean "no") and when `variables` is empty or not an object; the variable
leaf is then a wildcard. `railway-agent` always emits it. A missing or
empty `name` on `upsert-variable` / `delete-variable` is denied.

An unknown tool is denied (a name that is only an inherited property,
such as `constructor`, is unknown too).

### Identifiers

One grammar function per kind of identifier, exported from `classify.ts`;
a value outside its grammar is denied by `classify` and refused by
`execute` before any request, never escaped (ADR
[`plugin-identifiers-one-grammar-for-classify-and-execute`](../../decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md)).
No id reaches a URL: the rewrapped tools carry them as JSON-RPC arguments,
the variable tools as GraphQL variables of a constant document.

| Value                                 | Grammar                                                       | Bound to the mission                               | Where it lands                                           | Outside the grammar                                                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projectId`, the project resource ref | `railwayId` — `RAILWAY_ID = ^[A-Za-z0-9_-]{1,64}$`            | yes — a resource of the mission                    | JSON-RPC argument / GraphQL variable, slice `project[P]` | `projectId: malformed ref.` (the argument); `projectId: the project ref of this mission is not a Railway identifier.` (the resource)                              |
| `environmentId`                       | `railwayId`                                                   | yes — one of the project's discovered environments | JSON-RPC argument / GraphQL variable                     | `environmentId: malformed ref.`                                                                                                                                   |
| `serviceId`                           | `railwayId`                                                   | yes — one of the project's discovered services     | JSON-RPC argument / GraphQL variable, slice `service[S]` | `serviceId: malformed ref.`                                                                                                                                       |
| `deploymentId` (`get-logs`)           | **refused** — nothing can bind a deployment to the project    | —                                                  | never sent                                               | `deploymentId: not accepted by 'railway__get-logs' — it cannot be bound to the mission's project, so it is not sent. Give serviceId and environmentId instead: …` |
| `threadId` (`railway-agent`)          | **refused** — nothing can bind an agent thread to the project | —                                                  | never sent                                               | `threadId: not accepted by 'railway__railway-agent' — …. Every call starts a new conversation: …`                                                                 |
| `name`, the keys of `variables`       | `variableName` — `VARIABLE_NAME = ^[a-zA-Z0-9_./~-]{1,256}$`  | —                                                  | GraphQL variable, slice `service-var[NAME,…]`            | `name: malformed variable name.` / `variables: malformed variable name.`                                                                                          |

`classify` and `execute` share the readers, not only the grammars:
`resolveTarget(tool, args, resources)` is the only place that decides the
project, environment and service of a project-scoped call, and
`readVariableWrite` the only reading of a variable write. `execute`
(`pinTarget`) calls both with the same inputs and writes `projectId`,
`environmentId` and `serviceId` from their answer, never from the arguments.

**Every id that is forwarded is bound to the mission's project; an id that
cannot be bound is refused.** The OAuth token reaches every project of the
workspace, so an id the gateway forwards without checking would be served on
the mission's name: `get-logs` with the `deploymentId` of another project,
`railway-agent` continuing a thread started on another project. Discovery
stores the environments and the services of a project — no deployment, no
thread — and the classifier is pure, so neither can be checked. Both
arguments are therefore **refused**, by `classify` and by `execute`
(`UNBOUND_ARGUMENTS` in `tools.ts`, `unboundArgument` in `classify.ts`),
whatever their value, with what to do instead:

- `get-logs`: give `serviceId` and `environmentId` — both bound — and the
  logs of the latest deployment of that service are read. The logs of an
  older, named deployment cannot be read through the gateway.
- `railway-agent`: every call starts a new conversation; the message carries
  the context it needs. A conversation cannot be continued.

The schema the agent reads (`tools/list`) does not offer the two arguments,
and the description of each tool says so (`withoutUnboundArguments`). A test
checks that no other declared argument named like an id is left unbound
(`workspaceId` of `create-project` is account-level and names no resource of
a mission). This closes accepted risk A18 of the
[threat model](../threat-model.md); what stays open about Railway is the
agent tool itself, which cannot be bound at all (below, and
[known limitations](../known-limitations.md)).

## Catalog and presets

`risk-catalog.yaml` (`catalog_version: 4`) keeps the nine v4 risk ids and
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
(the alignment on the v5 SDK removed `refreshRailwayCredential` and `railwayNeedsRefresh`).
The plugin never persists: the host refreshes and stores the result.

## Connecting with a workspace token

Beside the OAuth app, `src/token.ts` declares a Railway token pasted by hand
(`api-key`, label "workspace token"), the way offered when no Railway app is
registered (ADR [token-connections-beside-the-integration-app](../../decisions/token-connections-beside-the-integration-app.md),
amendment of 2026-10-14). One form takes either kind of token, both created
under Account settings → Tokens; `railwayBearerOf` returns it or the OAuth
access token.

- **Kinds**: the **workspace token** (a workspace selected) is recommended —
  one workspace, least privilege, fit for a shared service account; the
  **account token** ("No workspace") is the second choice — every workspace
  of the account. A **project token** is not accepted: it reaches one
  environment of one project (sent as `Project-Access-Token`), while the
  plugin's resource is a project. The guide's steps say all three.
- **What runs**: every tool. Discovery and the four variable tools go to the
  GraphQL API; the ten rewrapped tools go to `https://mcp.railway.com/` with
  the token as `Authorization: Bearer`. Empirical check of 2026-10-14
  (orchestrator, dogfood workspace `vaubaan`, workspace token): `initialize`
  200, `tools/call list-projects` 200 with the workspace's project, a bogus
  Bearer 401 on `tools/call`; `tools/list` answers without a token (69 tools
  that day). Railway's docs describe the server for OAuth and CLI sign-in
  only, so the account token is enabled on the MCP server without having been
  checked.
- **Check at paste** (`verifyRailwayToken` → `probeRailwayToken`):
  `query vaubaanTokenOwner { me { name email } }` → an account token, named
  by its email (else its name). Otherwise `projects(first: 100)` → a
  workspace token, named `the <workspace> workspace` from a separate
  `projects { workspace { name } }` query, else `the workspace of <first
three projects>`, else unnamed. Neither answers (GraphQL `errors`, no
  `data`, 401 or 403) → `UpstreamAuthError`, nothing stored. Another failed
  status is a plain `Error`: Railway did not answer, which says nothing of
  the token. No expiry is exposed.
- **Discovery with a token**: the projects the token reaches (`projects`),
  then, when `me.workspaces` answers (an account token), each workspace's
  projects (`projects(workspaceId:)`) without duplicates. A workspace token's
  refused `me` ends the list (`askRailwayGraphql` returns refusals as
  answers).
- **MCP refusal of a pasted token** (`explainMcpRefusal`, called by
  `executeRailway` on an `UpstreamAuthError` from an MCP-server tool on an
  `api-key` connection): the token is probed again. Refused by the API too →
  `UpstreamAuthError` 401 ("deleted or has expired; reconnect with a new
  workspace token"), the host's rejected-credential path. Accepted by the
  API → `UpstreamAuthError` 403 naming the kind ("refused this account
  token … reconnect with a workspace token"): the host treats 403 as "not
  permitted", so a healthy connection is not expired for the variable tools.
  A probe that cannot reach Railway rethrows the original refusal. An OAuth
  connection is never probed.
- **User-Agent**: every request carries `User-Agent: vaubaan-gateway`
  (`src/user-agent.ts`); Cloudflare in front of the MCP server refuses some
  default user agents (error 1010).
- **Guide**: no permission choice exists on a Railway token; the steps say so.
- **Removal**: no deletion endpoint was found; the person deletes the token
  under Account settings, Tokens.

## Execution

`executeRailway(ctx, tool, args)` first answers a tool the plugin does not
declare with an `isError` result, then reads the bearer with
`railwayBearerOf` (the OAuth access token or the pasted token), then pins the target
(`pinTarget`):

1. an argument the tool does not declare is refused, by the classifier's own
   `undeclaredArgument` — the second lock, for a caller that did not go
   through `classify`;
2. an account-level tool is forwarded as received;
3. a project-scoped call is resolved by the classifier's own `resolveTarget`
   and `readVariableWrite` (see "Identifiers"). The caller's `projectId` is
   dropped and written again from the resolved project **only where the
   tool's schema takes one** (the upstream schema of `accept-deploy` is
   closed and has no such property); `environmentId`, `serviceId` and
   `deploymentId` are written from the resolved target.

Everything `pinTarget` declines is an `isError` result carrying the reason,
returned before any request — a call that names no project the mission can
resolve included (`projectId: argument required (…)`, for no Railway project
or an ambiguous target): nothing was sent, so nothing failed upstream. Then:

- upstream tools → JSON-RPC `tools/call` to `https://mcp.railway.com/` with
  the `railway__` prefix stripped, headers `Authorization: Bearer`,
  `Accept: application/json, text/event-stream`, `MCP-Protocol-Version:
2025-06-18`; the SSE frame (or bare JSON) is parsed and the MCP result
  passed through. `railway-agent` answers get `RAILWAY_AGENT_HINT` appended
  (the agent stages, `accept-deploy` commits);
- variable tools → GraphQL `variables` / `variableUpsert` /
  `variableCollectionUpsert` / `variableDelete` on
  `https://backboard.railway.com/graphql/v2`, returned as JSON text.

What the provider fails is thrown: 401/403 from either upstream →
`UpstreamAuthError`; any other failed status → `UpstreamHttpError` (with the
status); a JSON-RPC error frame, GraphQL `errors` or an empty `data` → a
plain `Error`. Whether backboard accepts the MCP-audience token is still
empirical (same assumption as v4); a refusal surfaces as `UpstreamAuthError`
with the upstream message.

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
- **`serviceId: not a service of railway project '…' as last discovered`** —
  the service belongs to another project, or was created after discovery; in
  the second case the connection owner refreshes the resources.
- **`serviceId: the services of railway project '…' are unknown`** — the
  stored resource carries no `metadata.services`: it was discovered before
  services were recorded. Refresh the connection's resources once.
- **`<name>: not an argument of 'railway__…'`** — the call carries an
  argument the tool's schema does not declare. Remove it.
- **`projectId: argument required (…)` as an `isError` result** — the mission
  has no Railway project, or several and the call names none; nothing was
  sent.
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

`npx vitest run plugins/railway` — 406 tests. `plugin.test.ts` (31)
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
`environmentId` binding. `identifier-injection.test.ts` (294) feeds
malformed ids and variable names to `classify` and to `execute`, checks
that `execute` runs on the target the classifier resolved, that a
`serviceId` is bound to its project (a foreign one, an unknown list, a
project with no service), that undeclared arguments are refused on both
sides, that `deploymentId` and `threadId` are refused whatever their value
with nothing sent, that the declared schema does not offer them and that no
other id-like argument is left unbound, and that discovery refuses a project id that is not a `railwayId`. No test reaches
Railway.

## References

- Spec: [`vaubaan-gateway.md`](../../spec/vaubaan-gateway.md) §0, §3.2, §5;
  [`gateway-risk-model.md`](../../spec/gateway-risk-model.md) §2, §4, §7.
- Handbooks: [[plugin-sdk]], [[policy-engine]]. Previous modelling notes
  (v4, French, archived as legacy): [`railway-ssh.md`](../legacy/railway-ssh.md).
