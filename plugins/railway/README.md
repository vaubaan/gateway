# `@vaubaan/plugin-railway`

Vaubaan Gateway provider plugin for [Railway](https://railway.com). It
rewraps the official Railway MCP server (`https://mcp.railway.com/`, 10
tools) and adds four GraphQL-backed environment-variable tools, under the
`railway__` prefix. Written against `@vaubaan/plugin-sdk` only. Maintainer
handbook: [`docs/handbook/providers/railway.md`](../../docs/handbook/providers/railway.md);
decisions: [`railway-rewrap-remote-mcp`](../../docs/decisions/railway-rewrap-remote-mcp.md).

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
see, with their environments in `metadata.environments` (`[{ id, name }]`).
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
project, or the call is refused — refresh the connection's resources after
creating an environment.

## Catalog and presets

`src/risk-catalog.yaml` — nine risks plus the mandatory
`railway.uncategorized-write` fallback, `catalog_version: 3`. Env-scoped
risks (`deploy`, `upsert-variable`, `read-variables`) accept `staging`,
`preview`, `dev`, `prod` and carry a stricter `prod` vector.

| Preset      | Grants                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `read-only` | Account, runtime and logs reads. No variable values, no write.                                                                        |
| `developer` | Reads + variables, deploys and variable writes on `dev` / `preview` / `staging` (`auto`); `prod` deploys and writes under `approval`. |
| `operator`  | Developer + `prod` variable reads; `bulk-variables-replace` and `create-project` under `approval`.                                    |

Presets are default suggestions copied into a mission policy at issuance;
`railway.agent-action` is in none of them and must be accepted explicitly.

## Credential — how the company registers its app

1. Railway → Workspace → **Developer → Auth apps → New app**
   (`https://railway.com/workspace/developer/apps/new`). Name it after your
   gateway instance. Leave **Device Flow off**.
2. Redirect URI: the instance callback the gateway shows on the Connect
   page (Railway requires `https://`; for loopback use `https://127.0.0.1`,
   never `localhost`).
3. Copy `client_id` and `client_secret` into the instance configuration
   under the Railway provider app (Admin → Provider apps, or the mounted
   config file). The plugin reads them as `appConfig.client_id` /
   `appConfig.client_secret` for refresh and fails fast naming the missing
   key.

The gateway then runs the authorization-code flow declared by
`railwayCredentialSpec`: scopes `openid offline_access workspace:member`,
PKCE S256, `prompt=consent` (needed for a refresh token) and the RFC 8707
resource indicator `https://mcp.railway.com` on both the authorization and
token requests — the MCP server refuses tokens minted without it. Access
tokens last one hour; the host refreshes them with the standard
`refresh_token` grant declared by the spec (`refreshable: true`), including
after an `UpstreamAuthError`.

## Development

```
npx vitest run plugins/railway     # 111 tests, no network
npx tsc -p plugins/railway/tsconfig.json --noEmit
```

Refreshing the upstream tool list: `POST tools/list` to
`https://mcp.railway.com/` with a Bearer scoped to the MCP resource, prefix
every name with `railway__`, commit `src/upstream-tools.json`, bump
`version` in `src/index.ts`.
