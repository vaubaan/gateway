# `@vaubaan/plugin-vercel`

Vercel provider plugin for Vaubaan Gateway: projects, deployments, logs,
environment variables, custom domains, firewall (WAF) and toolbar comments.
Written against [`@vaubaan/plugin-sdk`](../../packages/plugin-sdk) only.

- Contract: ADR [`plugin-contract-and-credential-spec`](../../docs/decisions/plugin-contract-and-credential-spec.md),
  handbook [`plugin-sdk`](../../docs/handbook/plugin-sdk.md).
- Modelling: handbook [`providers/vercel`](../../docs/handbook/providers/vercel.md)
  (data model, tool → slice mapping, catalog, edge cases).
- Upstream: ADRs [`rewrap-official-mcps`](../../docs/decisions/rewrap-official-mcps.md)
  and [`vercel-augment-with-rest-tools`](../../docs/decisions/vercel-augment-with-rest-tools.md).

## Layout

| File                                              | Role                                                                                                           |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                    | `definePlugin({...})` — default export `vercelPlugin`, plus the `@deprecated` v4 exports (deleted in P1.6).    |
| `src/risk-catalog.yaml`                           | 16 risks + fallback, three presets. Loaded at boot by the SDK; the only catalog artefact.                      |
| `src/data-model.ts`                               | One plane `runtime`, 17 entities; `env` is the env-scopable entity.                                            |
| `src/tools.ts`                                    | 31 tools: 18 rewrapped from `mcp.vercel.com` (`upstream-tools.json`) + 13 custom REST (`custom-tools.ts`).     |
| `src/classify.ts`                                 | `(tool, args, resources) → slices`. Pure. Project resolution against the mission's resources.                  |
| `src/credential.ts`                               | `api-key` spec: access token + team id; `vercelAuth()` narrows the secret.                                     |
| `src/execute.ts`                                  | JSON-RPC forward to the Vercel MCP server, REST for custom tools, `discoverResources` (paged project listing). |
| `src/risk-classifier.ts`, `src/vercel-adapter.ts` | Legacy v4 shells over the modules above. `// legacy v4, deleted in P1.6`.                                      |

`src/index.ts` resolves the YAML path from `import.meta.url` as a **string**
(`VERCEL_CATALOG_PATH`), not with `new URL('./risk-catalog.yaml', import.meta.url)`:
Turbopack, which bundles the plugin into `apps/gateway`, rewrites that pattern
into an asset URL that Node's `fileURLToPath` rejects at build time.

## Data model

```
account ─ team ─ project ─┬─ project-settings
                          ├─ domain[*]
                          ├─ firewall ─┬─ firewall-rule[*]
                          │            └─ ip-rule[*]
                          ├─ env-var-fan-out              (synthetic marker)
                          └─ env[prod|preview|development] ─┬─ env-var[*]
                                                            └─ deployment[*] ─┬─ build-log
                                                                              ├─ runtime-log
                                                                              ├─ bypass-token[*]
                                                                              └─ toolbar-thread[*] ─ toolbar-message[*]
```

The **project** (`prj_xxx`) is the resource a connection exposes and a mission
selects. The **environment** is not a resource: it is the closed Vercel triad,
derived from the call arguments (`target: production | preview | development`)
and emitted as the `env[<label>]` segment of the slice.

## Credential

`api-key` with two fields, collected by the host's generic form:

| Field     | Secret | Value                                                                                                    |
| --------- | ------ | -------------------------------------------------------------------------------------------------------- |
| `token`   | yes    | A Vercel access token (Account Settings → Tokens), created with a scope limited to the team you connect. |
| `team_id` | no     | The team id (`team_…`, Team Settings → General). Every call of the connection acts on behalf of it.      |

There is no OAuth app to register: Vercel's REST API and MCP server are both
reached with a personal access token, which is what v4 did and what works.
The token does not refresh (`refresh` is absent); pick an expiration when
creating it and reconnect when it expires. An explicit `teamId` argument that
differs from the connection's team is refused before any network call.

## Catalog and presets

Risks (ids are stable, never renamed): `read-account`, `read-deployment`,
`read-env-var`, `read-env-var-plaintext`, `fetch-deployment-url`,
`mint-bypass-token`, `deploy`¹, `toolbar-write`, `env-var-write`¹,
`env-var-fan-out`, `project-settings-write`, `firewall-read`, `firewall-write`,
`firewall-rule-write`, `ip-rule-write`, `domain-write`, plus the fallback
`uncategorized-write`. ¹ env-scoped: `acceptable_in_envs: [preview, development, prod]`
with a `vector_overrides.prod` block, qualified as `vercel[prod].deploy` etc.

| Preset      | Intent                                                                                                               | Approval-gated by default                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `read-only` | Inspect projects, deployments, logs, env-var keys, firewall.                                                         | —                                                                                                             |
| `developer` | One token per code project: preview/development deploys and env vars, logs, toolbar comments, bypass tokens.         | — (no production configuration at all)                                                                        |
| `operator`  | Developer plus production deploys and env vars, fan-out writes, project settings, domains, firewall, plaintext read. | prod deploy, prod env var, fan-out, project settings, domains, firewall toggle/rules/IP rules, plaintext read |

Budgets are per period; see the YAML for the numbers. Presets are UI sugar;
the persisted mission policy is always the explicit enumeration.

### Environment axis — note for the host

Env-qualified entries (`vercel[preview].deploy`) rely on the runtime knowing
which environment a call touched. For Vercel that is **not** the owner's
label on the project resource (a project spans all three environments) but
the `env[<label>]` segment the classifier emits. The plugin exports a pure
helper, `vercelEnvOf(slice)`, that reads it; the default
`resourceEnvResolver` of `@vaubaan/policy-engine` does not. Until the host
wires a slice-aware resolver, the env-qualified preset entries may not match
at runtime — see the handbook, "Environment axis".

## Resources

`discoverResources` reads `GET /v2/teams/{team_id}` (validates the token and
names the team), then pages `GET /v10/projects?teamId=…&limit=100` through
`pagination.next` / `until`, at most 10 pages (1 000 projects). Each project
becomes `{ provider: 'vercel', ref: project.id, displayName: project.name,
metadata: { team_id, team_slug, team_name, framework, environments } }`.

## Tests

```
npx vitest run plugins/vercel
```

`tests/unit/plugin.test.ts` runs the SDK kit (`assertPluginWellFormed`,
`assertPresetsValid`, `assertNoWildcard`, `assertCatalogCoverage` with one
sample per tool), the v5 classifier conventions, the credential spec, and
`execute` / `discoverResources` against `mockFetch`. `risk-classifier.test.ts`
(31 v4 cases), `risk-catalog.test.ts` and `adapter.test.ts` are the v4
suites, kept unchanged until P1.6. No test reaches the network.

## Removed from v4

- `vercel__upsert_env_from_venv` and the venv store: no v5 counterpart
  (plan §8-Q5).
- `risk-catalog.ts` (TypeScript twin) and its sync test: the YAML is the
  only catalog artefact.
- `teamId` override from the arguments: the connection's team always applies
  on the v5 path.
