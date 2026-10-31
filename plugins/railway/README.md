# `@vaubaan/plugin-railway`

Vaubaan Gateway provider plugin for [Railway](https://railway.com). It
rewraps the official Railway MCP server (`https://mcp.railway.com/`, 10
tools) and adds four GraphQL-backed environment-variable tools, under the
`railway__` prefix. Written against `@vaubaan/plugin-sdk` only. Maintainer
handbook: [`docs/handbook/providers/railway.md`](../../docs/handbook/providers/railway.md);
decisions: [`rewrap-official-mcps`](../../docs/decisions/rewrap-official-mcps.md),
[`plugin-identifiers-one-grammar-for-classify-and-execute`](../../docs/decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md).

## Data model

One plane, `runtime`:

```
account → project → environment → service → deployment → {logs, status}
                                           └→ service-var   (service-scoped or project-shared)
                                           └→ service-var-replace (marker: "replace every variable")
account → agent-session                                     (the railway-agent meta-tool)
```

The **resource** a connection exposes is the Railway **project** (UUID).
`discoverResources` lists the projects the connected workspace member can
see, with their environments in `metadata.environments` and their services
in `metadata.services` (`[{ id, name }]` each, empty lists included).
The owner labels each project with an environment (`prod`, `staging`,
`preview`, `dev`); that label is what env-qualified risks resolve against.

**A project must be labelled to run env-scoped operations.** On a project
with no label, or a label outside those four, every call touching
`read-variables`, `deploy` or `upsert-variable` is refused whatever the
mission accepts: `list-variables`, `redeploy`, `accept-deploy`, the
variable writes and `railway-agent`. Account, runtime and log reads still
work. The owner fixes it by labelling the project.

## Tools

| Tool                                                                                | Backend | Risk(s)                                               |
| ----------------------------------------------------------------------------------- | ------- | ----------------------------------------------------- |
| `railway__whoami`, `railway__list-projects`                                         | MCP     | `railway.read-account`                                |
| `railway__create-project`                                                           | MCP     | `railway.create-project`                              |
| `railway__list-services`, `railway__list-deployments`, `railway__get-status`        | MCP     | `railway.read-runtime`                                |
| `railway__get-logs`                                                                 | MCP     | `railway.read-runtime`, `railway.read-logs`           |
| `railway__redeploy`, `railway__accept-deploy`                                       | MCP     | `railway[env].deploy`                                 |
| `railway__railway-agent`                                                            | MCP     | `railway.agent-action` + deploy and variable risks    |
| `railway__list-variables`                                                           | GraphQL | `railway.read-runtime`, `railway[env].read-variables` |
| `railway__upsert-variable`, `railway__delete-variable`, `railway__upsert-variables` | GraphQL | `railway[env].upsert-variable`                        |
| `railway__upsert-variables` with `replace: true`                                    | GraphQL | `…upsert-variable` + `railway.bulk-variables-replace` |

A write of named variables touches `upsert-variable` alone.
`bulk-variables-replace` is touched only when the call replaces every
variable: `upsert-variables` with `replace` set (or an empty or malformed
`variables`), and every `railway-agent` call.

Project-scoped tools take `projectId` (one of the mission's resources).
When omitted, the mission's single Railway project is used; `accept-deploy`
carries only `environmentId`, which the classifier maps back to the project
whose discovered environments contain it. In every case an `environmentId`
argument must be one of the discovered environments of the resolved
project, and a `serviceId` argument one of its discovered services, or the
call is refused — refresh the connection's resources after creating an
environment or a service. A project discovered before services were
recorded carries no service list and refuses every `serviceId` until its
resources are refreshed once.

A tool takes the arguments its schema declares and nothing else: the
rewrapped tools forward their arguments whole, so an undeclared argument is
denied by `classify` and refused by `execute` (`undeclaredArgument`).
`projectId` is the one exception — it is read for every project-scoped tool,
then written where the tool takes one and dropped where it does not.

`execute` resolves the call with the classifier's own `resolveTarget` and
`readVariableWrite` and writes `projectId`, `environmentId` and `serviceId`
from their answer : a Railway id is `[A-Za-z0-9_-]{1,64}`, anything else is
denied and refused before any request. No id reaches a URL (JSON-RPC
arguments, GraphQL variables of a constant document). Every id that is
forwarded is bound to the mission's project. Two arguments of the upstream
tools cannot be — `deploymentId` of `get-logs` and `threadId` of
`railway-agent` — and are refused, never forwarded (`UNBOUND_ARGUMENTS` in
`src/tools.ts` ; handbook, Invariants) : the declared schemas do not offer
them.

What `execute` declines — an unknown tool, an undeclared argument, a target
the mission cannot resolve, a malformed id or variable name — is an
`isError` result returned before any request. What Railway fails is thrown:
`UpstreamAuthError` on 401/403, `UpstreamHttpError` on another failed
status, an `Error` for a JSON-RPC error frame or GraphQL `errors`.

## Catalog and macro-actions

`src/risk-catalog.yaml` — nine risks plus the mandatory
`railway.uncategorized-write` fallback. Env-scoped
risks (`deploy`, `upsert-variable`, `read-variables`) accept `staging`,
`preview`, `dev`, `prod` and carry a stricter `prod` vector.

| Macro-action | What it covers                         | Risks                                                         |
| ------------ | -------------------------------------- | ------------------------------------------------------------- |
| `watch`      | Projects, services, deployments, logs. | `read-account`, `read-runtime`, `read-logs`                   |
| `deploy`     | Redeploy and apply staged changes.     | `deploy`                                                      |
| `configure`  | Read and write variables.              | `read-variables`, `upsert-variable`, `bulk-variables-replace` |
| `create`     | Projects and Railway's agent.          | `create-project`, `agent-action`                              |

A creator ticks macro-actions at a trust cran (Prudent / Confiant / Autonome,
risk model §4.6); the cran turns each risk's vector into a gate and scales its
base budget. The persisted policy is the explicit list.
`prod` deploys and variable writes ask first below Autonome;
`bulk-variables-replace` is left out at Prudent and always asks first;
`railway.agent-action` asks first below Autonome.

## Credential — a workspace token

`credential.kind: 'api-key'` (`railwayCredential`, `src/credential.ts`), the
one way of connecting (ADR
[`one-place-to-authorize-services-token-first`](../../docs/decisions/one-place-to-authorize-services-token-first.md)).
An account is connected with a Railway token pasted once, created under
railway.com/account/tokens. Railway tokens carry no permission choice, so
the token reaches everything its workspace allows and the missions narrow
what an agent may do. Every tool runs with it: discovery and the four
variable tools on the GraphQL API, the ten tools of Railway's MCP server with
the token sent as `Authorization: Bearer` to `https://mcp.railway.com/`.

| Token                                  | Reach                          | Offered                     | MCP server                                                |
| -------------------------------------- | ------------------------------ | --------------------------- | --------------------------------------------------------- |
| **workspace token** (workspace chosen) | that workspace only            | yes, recommended            | accepted — checked against the real service on 2026-10-14 |
| account token ("No workspace")         | every workspace of the account | yes, second choice          | not checked; Railway documents the server for OAuth only  |
| project token                          | one environment of one project | no: a resource is a project | —                                                         |

A shared service account that is a member of the workspace is fine: the
missions of this gateway decide what an agent may do.

**Check at paste** (`probeRailwayToken`): `query { me { name email } }`
answers for an account token only (named by its email). Otherwise the
projects the token reaches answer for a workspace token, named by its
workspace (`the vaubaan workspace`) or, when the workspace name is not
exposed, by its projects. Neither answers → the token is refused.

**Discovery**: the projects the token reaches, then — account token only —
each workspace of `me.workspaces`. A workspace token has no `me`; its refusal
ends the list.

**When the MCP server refuses a pasted token** (401 or 403), the plugin asks
the API about the same token (`explainMcpRefusal`): refused there too → a
rejected credential (401, the account "Needs reconnecting"); still accepted →
the MCP server does not take this kind of token: a 403 naming it ("refused
this account token … reconnect with a workspace token"), and the connection
stays usable for the variable tools. `railway__whoami` may say little with a
workspace token, which has no user behind it.

Removing the account tells the person to delete the token under Account
settings → Tokens. ADR
[`one-place-to-authorize-services-token-first`](../../docs/decisions/one-place-to-authorize-services-token-first.md).

## Development

```
npx vitest run plugins/railway     # 421 tests, no network
npx tsc -p plugins/railway/tsconfig.json --noEmit
```

Refreshing the upstream tool list: `POST tools/list` to
`https://mcp.railway.com/` with a Bearer scoped to the MCP resource, prefix
every name with `railway__`, commit `src/upstream-tools.json`, bump
`version` in `src/index.ts`.
