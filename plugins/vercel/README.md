# `@vaubaan/plugin-vercel`

Vercel provider plugin for Vaubaan Gateway: projects, deployments, logs,
environment variables, custom domains, firewall (WAF) and toolbar comments.
Written against [`@vaubaan/plugin-sdk`](../../packages/plugin-sdk) only.

- Contract: ADR [`plugin-contract-and-credential-spec`](../../docs/decisions/plugin-contract-and-credential-spec.md),
  handbook [`plugin-sdk`](../../docs/handbook/plugin-sdk.md).
- Modelling: handbook [`providers/vercel`](../../docs/handbook/providers/vercel.md)
  (data model, tool → slice mapping, catalog, edge cases).
- Upstream: ADR [`rewrap-official-mcps`](../../docs/decisions/rewrap-official-mcps.md).
- Arguments and refusals: ADR [`plugin-identifiers-one-grammar-for-classify-and-execute`](../../docs/decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md).

## Layout

| File                    | Role                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`          | `definePlugin({...})` — default export `vercelPlugin`.                                                                                                        |
| `src/identity.ts`       | `PROVIDER_ID`, `TOOL` (the 31 tool names), the REST base and the MCP server: every name written once.                                                         |
| `src/risk-catalog.yaml` | 16 risks + fallback, five macro-actions. Loaded at boot by the SDK; the only catalog artefact.                                                                |
| `src/data-model.ts`     | One plane `runtime`, 17 entities; `env` is the env-scopable entity.                                                                                           |
| `src/tools.ts`          | 31 tools: 18 rewrapped from `mcp.vercel.com` (`upstream-tools.json`) + 13 custom REST (`custom-tools.ts`).                                                    |
| `src/classify.ts`       | `(tool, args, resources) → slices`. Pure. Project resolution against the mission's resources; denies the five thread-addressed tools (`UNBOUND_TOOLS`).       |
| `src/credential.ts`     | `api-key` spec: access token + team id; `vercelAuth()` narrows the secret.                                                                                    |
| `src/execute.ts`        | Team and project pinning, deployment binding, `tools/call` to the Vercel MCP server (SDK client), REST for custom tools, `discoverResources` (paged listing). |

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
emitted as the `env[<label>]` segment of the slice. It is read from `target`
for `upsert_env_var` (an unreadable `target` is refused); `deploy_to_vercel`
has no such argument upstream and is always classified on `prod`. The
deployment and env-var reads and the bypass-token mint name no environment
and sit under `env[*]` (`get_runtime_logs` names the one its `environment`
filter gives); no env-scoped risk matches them.

A second identifier is never trusted. A tool addressed by a deployment id or
URL is forwarded only after the deployment was resolved through the REST API
under the pinned team and found to belong to the mission's project ; a
deployment argument the tool does not declare is refused. The five tools
addressed by a toolbar thread id cannot be bound that way and are refused.
See the handbook.

An identifier that reaches a request path has one grammar, shared by the
classifier and the executor : `pathIdent` (`[A-Za-z0-9_-]{1,64}`) for the
project ref and the env var id, `domainName` (dot-separated labels, optional
leading `*.`) for a domain, `readDeploymentTargets` for a deployment id,
hostname or URL. A value outside its grammar — `..`, a separator, an encoded
form — is denied by `classify` and refused by `execute` before any request,
never escaped.

A tool takes the arguments its schema declares and nothing else. The
rewrapped tools forward their arguments whole, so an undeclared one —
another spelling (`project_id`), a `target` on `deploy_to_vercel`, a field
of Vercel's API — is denied by `classify` and refused by `execute`
(`undeclaredArgument` in `src/classify.ts`, over the SDK's
`undeclaredArgumentDenial`). `teamId` and `projectId` are the two routing
arguments: read for every tool, then dropped and written again from the
credential and the resolved project.

What `execute` declines itself is an `isError` result carrying the reason;
what Vercel fails is thrown (`UpstreamAuthError` on 401/403,
`UpstreamHttpError` on another failed status, `UpstreamProtocolError` for a
JSON-RPC error frame or an answer that is not JSON or not of the expected
shape). Vercel's own tool result is passed through, its `isError` included.

## Credential

`api-key` with two fields, collected by the host's generic form:

| Field     | Secret | Value                                                                                               |
| --------- | ------ | --------------------------------------------------------------------------------------------------- |
| `token`   | yes    | A Vercel access token (Account Settings → Tokens), Scope: the team, All Projects.                   |
| `team_id` | no     | The team id (`team_…`, Team Settings → General). Every call of the connection acts on behalf of it. |

There is no OAuth app to register: Vercel's REST API and MCP server are both
reached with a personal access token, which is what works. The guide asks for
the team with All Projects (the missions narrow it to their projects). The
Team ID stays a field: a wide token reaches every team of its owner, and the
host keeps only what the form gives. The check at paste (`verifyVercelToken`)
reads `GET /v5/user/tokens/current` for the expiry and `GET /v2/teams/{id}`
for the team's name; a token that cannot open the team is refused.
The token does not refresh (`refresh` is absent); the account page shows its
expiry and the person reconnects before it. The team is pinned to the
credential: a `teamId` argument that is not exactly the connection's team
(another string, or any non-string) is refused before any network call, and
the value sent to Vercel is always written from the credential. The four
rewrapped tools that cannot carry a team are listed with their reason in
`TEAMLESS_UPSTREAM_TOOLS` (`src/execute.ts`).

## Catalog and macro-actions

Risks (ids are stable, never renamed): `read-account`, `read-deployment`,
`read-env-var`, `read-env-var-plaintext`, `fetch-deployment-url`,
`mint-bypass-token`, `deploy`¹, `toolbar-write`, `env-var-write`¹,
`env-var-fan-out`, `project-settings-write`, `firewall-read`, `firewall-write`,
`firewall-rule-write`, `ip-rule-write`, `domain-write`, plus the fallback
`uncategorized-write`. ¹ env-scoped: `acceptable_in_envs: [preview, development, prod]`
with a `vector_overrides.prod` block, qualified as `vercel[prod].deploy` etc.

| Macro-action | What it covers                                                  | Risks                                                                  |
| ------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `watch`      | Projects, deployments, encrypted environment keys and firewall. | `read-account`, `read-deployment`, `read-env-var`, `firewall-read`     |
| `deploy`     | Deploy, open a preview and comment.                             | `deploy`, `fetch-deployment-url`, `mint-bypass-token`, `toolbar-write` |
| `configure`  | Environment variables, in clear and in writing.                 | `read-env-var-plaintext`, `env-var-write`, `env-var-fan-out`           |
| `protect`    | Firewall and IP rules.                                          | `firewall-write`, `firewall-rule-write`, `ip-rule-write`               |
| `own`        | Project settings and domains.                                   | `project-settings-write`, `domain-write`                               |

A creator ticks macro-actions at a trust cran (Prudent / Confiant / Autonome,
risk model §4.6); the cran turns each risk's vector into a gate and scales its
base budget. The persisted policy is the explicit list.
Budgets are per period; see the YAML for the base numbers. A mission with
no production configuration ticks `watch` and `deploy` on `preview` /
`development` only.

### Environment axis — note for the host

Env-qualified entries (`vercel[preview].deploy`) rely on the runtime knowing
which environment a call touched. For Vercel that is **not** the owner's
label on the project resource (a project spans all three environments) but
the `env[<label>]` segment the classifier emits. The plugin declares
`envOf` (`vercelEnvOf(slice)`), which the host's default resolver asks
before the resource label. A slice whose `env` segment is not one label of
the triad — a wildcard, a list, another label — answers `NO_SINGLE_ENV`: the
host then resolves no environment, does not fall back to the label, and
refuses every env-scoped risk the slice touches. See the handbook,
"Environment axis".

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
`assertNoWildcard`, `assertCatalogCoverage` with at
least one sample per tool, `assertSlicesOnDataModel`, `catalogPathIssues`), the classifier conventions, the credential spec,
and `execute` / `discoverResources` against `mockFetch` (including the request
shapes of the custom REST tools). `classify.test.ts` pins the slices of each
tool; `risk-catalog.test.ts` lints the YAML catalog against the classifier.
`team-pin.test.ts` proves, over every declared tool, that each request
carries the credential's team and that no team id comes from the arguments;
`binding.test.ts` covers the deployment binding and the refused thread tools;
`identifier-injection.test.ts` feeds dot segments, separators and encoded
forms to every identifier position of `classify` and `execute`;
`firewall.test.ts` covers the five firewall tools (slices, risks, request
shapes). 653 tests; none reaches the network.
