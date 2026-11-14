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
| `src/identity.ts`       | `PROVIDER_ID`, `TOOL` (the 32 tool names), the REST base and the MCP server: every name written once.                                                         |
| `src/risk-catalog.yaml` | 16 risks + fallback, five macro-actions. Loaded at boot by the SDK; the only catalog artefact.                                                                |
| `src/data-model.ts`     | One plane `runtime`, 17 entities; `env` is the env-scopable entity.                                                                                           |
| `src/tools.ts`          | 32 tools: 18 rewrapped from `mcp.vercel.com` (`upstream-tools.json`) + 14 custom REST (`custom-tools.ts`).                                                    |
| `src/classify.ts`       | `(tool, args, resources) → slices`. Pure. Project resolution against the mission's resources; denies the five thread-addressed tools (`UNBOUND_TOOLS`).       |
| `src/credential.ts`     | `api-key` spec: access token + team id or project id (two alternatives); `vercelAuth()` narrows the secret to its mode.                                       |
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

The **project** (`prj_xxx`) is the resource an account exposes and a mission
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

`api-key` with three fields and two alternatives (`CredentialAlternative`),
collected by the host's generic form: a radio "One project" or "Team", then the
token and the chosen alternative's ID. The host keeps only that one.

| Field        | Secret | Alternative | Value                                                                                                 |
| ------------ | ------ | ----------- | ----------------------------------------------------------------------------------------------------- |
| `token`      | yes    | both        | A Vercel access token (Account Settings → Tokens), Scope: one project, or the team with All Projects. |
| `project_id` | no     | One project | The project id (`prj_…`, Project Settings → General). The account reaches that project only.          |
| `team_id`    | no     | Team        | The team id (`team_…`, Team Settings → General). Every call of the account acts on behalf of it.      |

There is no OAuth app to register: Vercel's REST API and MCP server are both
reached with a personal access token, which is what works. The guide lists
first, and checks, a token scoped to one project: a key per project keeps a
leak or a mistake inside that project, while one key for the whole team makes
every mission depend on it; the team with All Projects comes second, for
missions that span its projects (ADR `one-place-to-authorize-services-token-first`,
amendments 2026-11-11 and 2026-11-14).
`vercelAuth` reads the mode from the field there, so an account made with
`team_id` before the alternatives keeps working.

The check at paste (`verifyVercelToken`) reads `GET /v5/user/tokens/current`
for the expiry, then `GET /v2/teams/{id}` for the team's name (403: the token
does not cover the whole team, choose One project; 404: no such team) or
`GET /v9/projects/{id}` without `teamId` for the project's name (403/404: the
token does not open that project). The token does not refresh (`refresh` is
absent); the account page shows its expiry and the person reconnects before
it.

Team mode pins the team to the credential: a `teamId` argument that is not
exactly the account's team (another string, or any non-string) is refused
before any network call, and the value sent to Vercel is always written from
the credential. The four rewrapped tools that cannot carry a team are listed
with their reason in `TEAMLESS_UPSTREAM_TOOLS` (`src/execute.ts`). Project
mode refuses every `teamId` argument and every other project, sends no
`teamId` to the REST API, and sends the rewrapped tools (whose upstream schema
requires one) the project's own team as discovery read it.

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

A creator ticks macro-actions at a trust level (Careful / Trusting / Autonomous,
risk model §4.6); the trust level turns each risk's vector into a gate and scales its
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

In project mode `discoverResources` reads `GET /v9/projects/{project_id}` and
returns that project alone, its `accountId` as `metadata.team_id`. In team
mode it reads `GET /v2/teams/{team_id}` (validates the token and
names the team), then pages `GET /v10/projects?teamId=…&limit=100` through
`pagination.next` / `until`, at most 10 pages (1 000 projects). Each project
becomes `{ provider: 'vercel', ref: project.id, displayName: project.name,
metadata: { team_id, team_slug, team_name, framework, environments } }`.

## Tests

```
npx vitest run plugins/vercel
```

`tests/unit/plugin.test.ts` runs the SDK kit (`assertPluginWellFormed`,
`assertNoWildcard`, `assertCatalogCoverage` on the plugin's `examples`
(`src/examples.ts`, at least one per tool), `assertSlicesOnDataModel`, `catalogPathIssues`), the classifier conventions, the credential spec,
and `execute` / `discoverResources` against `mockFetch` (including the request
shapes of the custom REST tools). `classify.test.ts` pins the slices of each
tool; `risk-catalog.test.ts` lints the YAML catalog against the classifier.
`team-pin.test.ts` proves, over every declared tool, that each request
carries the credential's team and that no team id comes from the arguments,
and, for a project-scoped account, that REST names no team, the MCP server
gets the project's, and every `teamId` argument and other project is refused;
`binding.test.ts` covers the deployment binding and the refused thread tools;
`identifier-injection.test.ts` feeds dot segments, separators and encoded
forms to every identifier position of `classify` and `execute`;
`firewall.test.ts` covers the five firewall tools (slices, risks, request
shapes). 733 tests; none reaches the network.
