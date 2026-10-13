---
title: Execution door — /mcp, the call pipeline's stages, the catalog
status: current
date: 2026-10-13
last_synced: 2026-10-13
tracks:
  - apps/gateway/src/server/execution/
  - apps/gateway/src/app/mcp/
  - apps/gateway/src/app/.well-known/oauth-protected-resource/route.ts
  - apps/gateway/src/server/compose/root.ts
  - apps/gateway/tests/integration/execution/
  - apps/gateway/tests/manual/seed-demo.ts
  - packages/gateway-core/src/pipeline.ts
  - packages/gateway-core/src/fingerprint.ts
  - packages/plugin-sdk/src/plugin.ts
  - plugins/github/src/token-cache.ts
---

# Execution door — `/mcp`, the call pipeline's stages, the catalog

How an agent holding a mission token lists and calls tools: the HTTP surface,
the bearer dispatch, the stages that fill gateway-core's `CallPipeline`, the two
caches, the catalog endpoint. Spec:
[vaubaan-gateway](../spec/vaubaan-gateway.md) §4.1 (execution surface), §2.4
(no credential to the executor), §3.1 (resource selection), §6 (three
credentials, surface rate limit, no secret in logs), §7.5, §8 (audit).
Decisions:
[docker-image-and-config-format](../decisions/docker-image-and-config-format.md)
§6 (MCP SDK v2, stateless Streamable HTTP),
[upstream-credential-cache-and-rejected-credentials](../decisions/upstream-credential-cache-and-rejected-credentials.md).
Built on [gateway-core](gateway-core.md) (pipeline, refusals),
[budget and sessions](budget-and-sessions.md) (`createBudgetStage`),
[connections](connections.md) (`CredentialBroker`), [missions](missions.md)
(`verifyToken`, bootstrap kit), the [plugin SDK](plugin-sdk.md) and the
[store](store.md). Replaces the legacy v4 handbook
[mcp-gateway](mcp-gateway.md).

## Layout

```
apps/gateway/src/server/execution/      host-agnostic, never imports `next`
  index.ts            createExecutionModule(deps) → root.execution { pipeline, credentialCache, door, handlers }
  door.ts             ExecutionDoor: handleMcp(), handleCatalog(); admission, MCP serving
  token-verifier.ts   TokenVerifier — verified-token cache, per-prefix throttle, single flight
  mission-context.ts  loadMissionContext(), missionResourceOf(), periodOf()
  resource-stage.ts   createResourceStage(), citedRefs()        → resource-not-in-mission
  risk-stage.ts       createRiskStage()                         → risk-not-accepted
  upstream-stage.ts   createUpstreamStage()                     → broker, retry ladder, connection-unavailable
  credential-cache.ts ConnectionCredentialCache                 — ExecuteContext.credentialCache
  tools.ts            callableProviders(), callableTools(), buildCatalog()
  request-meta.ts     agentLabelOf(), clientOriginOf(), trustedProxyList()
  testing.ts          depotPlugin(), executionInstance() — tests only
  execution.test.ts   unit tests of the pure and in-memory parts
apps/gateway/src/app/mcp/route.ts           GET | POST | DELETE /mcp   → root.execution.handlers.mcp
apps/gateway/src/app/mcp/catalog/route.ts   GET /mcp/catalog           → root.execution.handlers.catalog
apps/gateway/src/app/.well-known/oauth-protected-resource/route.ts   RFC 9728: static bearer, no authorization server
apps/gateway/tests/integration/execution/   pipeline, door over HTTP, counters vs audit
apps/gateway/tests/manual/seed-demo.ts      seeds a local instance for the manual check
```

Dependency of the door on the protocol: `@modelcontextprotocol/server` 2.3.1
(`createMcpHandler`, `isLegacyRequest`, `Server`,
`WebStandardStreamableHTTPServerTransport`, `ProtocolError`). The v1 package
`@modelcontextprotocol/sdk` is gone. `@modelcontextprotocol/client` is a dev
dependency: the integration test drives the door with the official client.

## A request, in order

```
POST /mcp
  origin          an `Origin` header other than public_url's            → 403
  bearer          TokenVerifier.verify → DoorAuthenticator (gateway-core)
                    missing / malformed / unknown / rotated             → 401  AuthError (-32001), WWW-Authenticate: Bearer
                    web session (cookie or bearer), delegated token     → 403  wrong-credential-kind
                    too many hash verifications on one prefix           → 429
  mission context loadMissionContext (store reads, no cache)
  surface rate    rateLimiter.take('mcp:mission:<id>', mcp.rate_limit_per_minute, 60 s) → 429 (-32002), Retry-After
  protocol        isLegacyRequest(request) ? stateless JSON transport : createMcpHandler(...).fetch
  tools/list      checkMissionActive → callableTools(ctx, registry)
  tools/call      CallPipeline.execute(ctx, { tool, args, agent_label, client })
```

Everything before "protocol" answers with a JSON-RPC error envelope whose `id`
is `null` (no request was parsed yet); everything after is a JSON-RPC response
to the request's own id.

### Admission (`door.ts`)

- **Origin.** A request that carries an `Origin` header different from
  `config.publicUrl.origin` is refused. The door sends no CORS header and
  exports no `OPTIONS`.
- **Bearer dispatch.** `DoorAuthenticator.authenticateMission` (gateway-core)
  over the door's `CredentialResolver`:

  | Presented                                                   | Outcome                                                                            |
  | ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
  | active mission token                                        | `MissionContext`                                                                   |
  | token of a revoked mission                                  | `MissionContext` with `status: 'revoked'` → `mission-inactive` on the first method |
  | token replaced by rotation                                  | 401 (`unknown or revoked bearer.`)                                                 |
  | unknown prefix, wrong secret, anything that is not a bearer | 401                                                                                |
  | no `Authorization`, a valid session cookie                  | 403 `wrong-credential-kind`, `presented: human-session`                            |
  | a web session id as bearer                                  | same                                                                               |
  | a bearer the `DelegatedTokenResolver` recognises            | 403 `wrong-credential-kind`, `presented: delegated-token`                          |

  `DelegatedTokenResolver` is `ExecutionModuleDeps.delegations` /
  `RootDeps.delegatedTokens`; nothing provides one until the management door
  exists (P2.3), so a delegated token is today an unknown bearer (401). The
  hint of the refusal names where the presented kind is accepted
  (`ACCEPTED_AT` in gateway-core's `errors.ts`).

- **Surface rate limit.** Per mission, all agents together; the key and the
  window are the door's, the limit is `InstanceConfig.mcp.rateLimitPerMinute`
  ([configuration](configuration.md)). It is not the `rate-limited` refusal:
  that one is per risk, decided by the budget, and carries a `risk_id`.

### Verified-token cache (`token-verifier.ts`)

`TokenVerifier.verify(bearer)` → `TokenVerification` (missions) or
`{ outcome: 'throttled', retryAfterMs }`.

- Key `mission-token:<sha256(bearer)>`, value: the id of the token row the
  bearer matched, TTL `VERIFIED_TOKEN_TTL_SECONDS` (15 min), in `root.cache`
  (`CacheClient`).
- **Hit**: `store.missions.findTokenByPrefix(prefix)`; if the row still has
  that id, the outcome is derived from its current status (`verified`,
  `retired/rotated`, `retired/revoked`) and the mission record is the fresh
  one. Rotation and revocation are therefore seen by the next call; only the
  argon2 computation is skipped. A row that is gone or replaced voids the entry.
- **Miss**: one `rateLimiter.take('mcp-verify:<prefix>', 30, 60 s)`, then
  `MissionService.verifyToken` (argon2id). Only `verified` / `retired` results
  are stored. Concurrent misses of one bearer share one promise (`inFlight`,
  `// single-process only`).

### Mission context (`mission-context.ts`)

`loadMissionContext(store, mission, token)` builds gateway-core's
`MissionContext` on every request:

- `connections` — one `MissionConnection` per `mission.connections` entry, with
  the current `status` and `owner.display` (the user's email, or the group's
  name).
- `resources` — the rows of `connections.listResources` whose id is in the
  mission's `resourceIds` **and** whose `staleSince` is null. Scope `all` with
  an empty list yields nothing: the selection is never hydrated from the live
  list. Hidden resources stay.
- `policy` — `mission.policy` through `policyEntryOf` (budget).
- `session` — `sessions.getByMission`, or `null` before the first call.

## The stages

`createExecutionModule` builds one `CallPipeline` (gateway-core) with:

| Stage     | Implementation                                                  | Refuses                                                 |
| --------- | --------------------------------------------------------------- | ------------------------------------------------------- |
| resources | `createResourceStage({ registry, connections })`                | `resource-not-in-mission`; rejects a call no one owns   |
| risks     | `createRiskStage({ registry })`                                 | `risk-not-accepted`; rejects a classifier denial        |
| budget    | `createBudgetStage({ service: root.budget, missions })` (P1.3)  | `budget-exhausted`, `rate-limited`, `approval-required` |
| upstream  | `createUpstreamStage({ credentials, credentialCache, logger })` | `connection-unavailable` (after the allow)              |
| audit     | `store.auditWriter` (`SqliteAuditWriter`)                       | —                                                       |

`mission-inactive` and `connection-unavailable` (a connection already `expired`
or `revoked`) come from the pipeline's own pure checks.

### Resource stage (`resource-stage.ts`)

1. `registry.providerForTool(tool)` → the plugin; none → rejection
   `unknown tool '<name>'…`.
2. The mission's connection of that provider (one per provider per mission);
   none → rejection `…this mission holds no <Provider> connection.`
3. `allowed` = the context's resources on that connection; `known` = every
   resource row of the connection.
4. `plugin.classify(tool, args, allowed)`:
   - slices → `citedRefs(slices, knownRefs)`: the `ident` and `list` segments
     that equal a known ref. A cited ref outside `allowed` →
     `resource-not-in-mission`. Otherwise the target resource is the first
     allowed ref cited, or the mission's single resource on the connection, or
     `null` (account-level tool).
   - denied, and the connection knows refs the mission does not hold →
     `plugin.classify(tool, args, known)`; if that resolves to a ref outside
     `allowed` → `resource-not-in-mission` naming it. This is the path of a
     resource never selected, discovered after issuance, or selected and stale
     since.
   - otherwise the stage passes with `resource: null` and the risk stage
     reports the classifier's reason.

The refusal carries `cited_ref`, `connection { id, name }` and
`allowed_resources [{ ref, env, display_name }]`. A ref the connection has
never discovered is indistinguishable from a malformed argument: the call is
rejected with the classifier's sentence, not with the typed refusal. A
classifier that throws is treated as a denial.

### Risk stage (`risk-stage.ts`)

`evaluateCallForToken` with the registered plugin as classifier, its indexed
catalog, the mission's resources on the target connection and
`acceptedRisksOf(ctx)`; `denied_risks` is always `[]`. Environment
qualification is gateway-core's default (`envResolverFor(resources,
plugin.envOf)`).

### Upstream stage (`upstream-stage.ts`)

```
resolved = credentials.resolve(connectionId)              ConnectionUnavailableError → connection-unavailable
plugin.execute({ ...credentials.contextOf(resolved),
                 resources, agentLabel, credentialCache }, tool, args)
  UpstreamAuthError 401
    credentialCache.drop(connection) > 0  → execute again with the same credential
    still 401 (or nothing was cached)     → credentials.refresh(connectionId) → execute once more
       refresh rejected (connection now `expired`) → connection-unavailable
  UpstreamAuthError 403, any other error  → thrown as is
```

`connection-unavailable` after the allow is thrown as gateway-core's
`UpstreamRefusalError`: the audit entry stays `decision: 'allowed'` with
`upstream_error: 'connection-unavailable: …'`, the credit stays consumed, and
the pipeline's `failed` outcome carries the refusal. A `ProviderUnreachableError`
from the broker, a 403 and any provider failure are plain `failed` outcomes.

### Upstream credential cache (`credential-cache.ts`)

`ConnectionCredentialCache.scopeFor(connection)` is the
`ExecuteContext.credentialCache` a plugin receives: `get` / `set(key, value,
ttlSeconds)` over `root.cache`, namespaced
`upstream-credential:<connection id>:<updated_at>:<key>` and capped at
`MAX_UPSTREAM_CREDENTIAL_TTL_SECONDS` (55 min). `drop(connectionId)` deletes
what this process wrote for the connection (`written`, `// single-process
only`); the upstream stage calls it on a 401 and when the connection turns
unavailable. A reconnect, a refresh or a revocation rewrites the connection row,
so older entries are unreachable whatever the cache.

The only user today is GitHub (`plugins/github/src/token-cache.ts`):
`installationTokenForCall(ctx, repo)` keeps one installation token per
repository scope (`installation-token:<repo | *>`) for
`INSTALLATION_TOKEN_CACHE_SECONDS` (50 min), never serves one within
`INSTALLATION_TOKEN_EXPIRY_MARGIN_SECONDS` (5 min) of its expiry, and is
bypassed by `github__mint_install_token`, whose result leaves the gateway.

## What the agent receives

| Pipeline outcome        | JSON-RPC answer to `tools/call`                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `allowed`               | `result` = the plugin's `McpToolResult`, untouched                                         |
| `refused`               | `error { code: -32603, message: 'Vaubaan refused the call: <code>', data: <the refusal> }` |
| `failed` with a refusal | same (`connection-unavailable`)                                                            |
| `failed`                | `result { isError: true, content: [{ type: 'text', text: 'Upstream error: <message>' }] }` |
| `rejected`              | `error { code: -32602, message: 'Vaubaan rejected the call: <reason>', data: { reason } }` |

`data` is the whole refusal — `code`, the fields of the code, `hint` — as
`refusalToRpcError` builds it; the door throws it as the SDK's `ProtocolError`
so the transport serializes it untouched (`refusalError` in `door.ts`).
`tools/list` on an inactive mission is the same error with `mission-inactive`.

One log line per call (`tools/call`, component `execution-door`): mission id,
token prefix, tool, outcome, refusal code, `arguments_hash`, agent label. Never
an argument, never the bearer.

### Audit entry

Written by the pipeline, once per call. Fields filled by the door:
`agent_label` (below), `client_ip` / `client_user_agent` (`clientOriginOf`),
`arguments_hash` = `fingerprintArguments(args)` — the canonical SHA-256 (64 hex)
that also binds approvals, so an `approval-required` refusal's `fingerprint`
equals the entry's hash.

### Agent label (`request-meta.ts`)

`agentLabelOf(headers, params._meta)`: `_meta.agent` of the call when it is a
non-empty string, else the `X-Vaubaan-Agent` header, else `null`. Control
characters become spaces, the label is trimmed and cut at 120 characters. It
reaches the audit entry, the session event and `ExecuteContext.agentLabel`;
nothing decides on it.

### Client address

`clientOriginOf`: the right-most `X-Forwarded-For` hop that is not in
`trusted_proxies` (addresses and CIDR blocks, `node:net` `BlockList`); `null`
when `trusted_proxies` is empty, when the chain is malformed, or when every hop
is a proxy.

## Protocol

- **2026-07-28** requests (per-request `_meta` envelope) go to
  `createMcpHandler(factory, { legacy: 'reject', responseMode: 'auto' })`: one
  `Server` per request, a JSON body, upgraded to SSE only if a handler emits a
  notification before its result (none does today).
- **2025-era** requests (`initialize`, bare `tools/list`, what Claude Code
  sends today) are detected with `isLegacyRequest` and served by a fresh
  `Server` over `WebStandardStreamableHTTPServerTransport({ sessionIdGenerator:
undefined, enableJsonResponse: true })`: stateless, one JSON body per POST.
  `GET` and `DELETE` answer 405.
- Both legs build the server with `ExecutionDoor.buildServer(scope)`; on the
  modern leg the scope travels in `authInfo.extra` (the `token` field of
  `AuthInfo` is the masked prefix).
- Plugins return a complete `McpToolResult`; no provider response is streamed
  through the door today.
- `GET /.well-known/oauth-protected-resource` answers `{ resource:
<public_url>/mcp, authorization_servers: [], bearer_methods_supported:
['header'] }` so clients that probe it use the static bearer.

## Discovery and catalog (`tools.ts`)

`callableTools(ctx, registry)`: every tool of each non-experimental plugin
whose provider the mission both holds a connection for and accepts at least one
risk of (`callableProviders`). The filter is per provider: a listed tool can
still be refused `risk-not-accepted` at call time.

`GET /mcp/catalog` (mission token; 401 / 403 / 429 as `/mcp`; an inactive
mission is 403 `mission-inactive`), `Cache-Control: no-store`:

```jsonc
{
  "mission": {
    "id": "…",
    "name": "…",
    "state": "active",
    "expires_at": null,
    "period": { "start": "…", "end": "…" },
  },
  "tools": [
    { "name": "github__list_branches", "provider": "github", "description": "…", "callable": true },
  ],
  "callable_tools": ["github__list_branches"],
  "connections": [
    {
      "id": "…",
      "provider": "github",
      "name": "acme-org",
      "status": "active",
      "resources": [{ "ref": "acme/app", "env": null, "display_name": "acme/app" }],
    },
  ],
  "budget": [
    {
      "risk_id": "github.read-code",
      "quota": 500,
      "consumed": 2,
      "remaining": 498,
      "rate_limit": { "max": 60, "window_seconds": 60 },
      "gate": "auto",
    },
  ],
}
```

`tools` is the whole surface of the instance (experimental plugins excluded);
`budget` comes from `SessionService.stateOf` for the current period.

## Wiring (`compose/root.ts`)

```ts
const windows = new SlidingWindowRateLimiter(); // budget windows + surface limits, disjoint keys
const rateLimiter = deps.rateLimiter ?? windows;
const cache = deps.cache ?? new MemoryCacheClient(); // verified tokens + upstream credentials
const budget = new SessionService({
  sessions: store.sessions,
  requests: store.requests,
  rateWindows: windows,
  requestUrl: requests.requestUrl, // `<public_url>/r/<id>`, the requests module's builder
  requestExpirySeconds: config.requests.expirySeconds,
});
const execution = createExecutionModule({
  config,
  store,
  registry,
  auth,
  missions,
  connections,
  budget,
  cache,
  rateLimiter,
  logger,
  build,
});
```

`root.budget` and `root.execution` are public members of `GatewayRoot`. The
fixed-window `MemoryRateLimiter` is no longer wired; it remains for tests that
inject a clock.

## Manual check

Done on 2026-10-13 on the standalone build, with a temporary configuration and
SQLite file. `tests/manual/seed-demo.ts` seeds a user, a GitHub connection (a
placeholder installation id: enough to list tools, not to reach GitHub) and a
`read-only` mission on `acme/app`, through the repositories and
`MissionService.issue`, and prints the bootstrap kit.

```console
$ npm run build --workspace @vaubaan/gateway-app
$ export VAUBAAN_PUBLIC_URL=https://gateway.example.com VAUBAAN_STORE_PATH=$TMP/gateway.db \
         VAUBAAN_MASTER_KEY=$(npm run -s gen-master-key) VAUBAAN_ADMIN_EMAILS=ops@example.com \
         VAUBAAN_BOOTSTRAP_TOKEN=boot-<48 hex>
$ (cd apps/gateway && npx tsx tests/manual/seed-demo.ts)
mission 01a13437-af66-7437-93c3-0d2c7e4072b5 issued for demo@example.com

# 1. environment
export VAUBAAN_MISSION_TOKEN='vbn_live_RcjgsDOn_<secret>'

# 2. MCP client configuration
{ "mcpServers": { "vaubaan": { "type": "http", "url": "https://gateway.example.com/mcp",
    "headers": { "Authorization": "Bearer ${VAUBAAN_MISSION_TOKEN}" } } } }

$ PORT=3917 HOSTNAME=127.0.0.1 node apps/gateway/.next/standalone/apps/gateway/server.js &
$ curl -sS http://127.0.0.1:3917/healthz
{"status":"ok","version":"2.0.0-alpha.0","commit":"39b58a9","uptime_seconds":0,"store":{"kind":"sqlite","status":"ok"}}

$ curl -sS http://127.0.0.1:3917/mcp \
    -H "Authorization: Bearer $VAUBAAN_MISSION_TOKEN" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | jq -c '{id, tools: (.result.tools | length), first: [.result.tools[0:3][].name]}'
{"id":1,"tools":26,"first":["github__list_branches","github__list_commits","github__list_pull_requests"]}

$ curl … -d '{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"2025-06-18",…}}' | jq -c .result
{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"vaubaan-gateway","version":"2.0.0-alpha.0"}}

$ curl … -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"github__list_branches","arguments":{"owner":"acme","repo":"infra"}}}' \
  | jq -c '.error | {code, message, data: {code: .data.code, cited_ref: .data.cited_ref, allowed_resources: .data.allowed_resources, hint: .data.hint}}'
{"code":-32603,"message":"Vaubaan refused the call: resource-not-in-mission","data":{"code":"resource-not-in-mission","cited_ref":"acme/infra","allowed_resources":[{"ref":"acme/app","env":null,"display_name":"acme/app"}],"hint":"Resource 'acme/infra' is not part of this mission on connection 'acme-org'. The mission may touch: acme/app. Use one of these refs, or ask the mission creator to add the resource."}}

$ curl -sS http://127.0.0.1:3917/mcp/catalog -H "Authorization: Bearer $VAUBAAN_MISSION_TOKEN" \
  | jq -c '{mission: .mission.state, callable: (.callable_tools | length), surface: (.tools | length), budget: .budget[0]}'
{"mission":"active","callable":26,"surface":206,"budget":{"risk_id":"github.read-code","quota":5000,"consumed":0,"remaining":5000,"rate_limit":{"max":120,"window_seconds":60},"gate":"auto"}}

$ curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3917/mcp … -d '{"jsonrpc":"2.0","id":4,"method":"tools/list"}'   # no Authorization
401
$ curl -sS http://127.0.0.1:3917/.well-known/oauth-protected-resource
{"resource":"https://gateway.example.com/mcp","authorization_servers":[],"bearer_methods_supported":["header"]}

$ node mcp-client.mjs   # @modelcontextprotocol/client 2.3.1 over real HTTP: connect + listTools, both eras
2025-era: connected to vaubaan-gateway 2.0.0-alpha.0, 26 tools
2026-07-28: connected to vaubaan-gateway 2.0.0-alpha.0, 26 tools

$ grep -c "$TOKEN_SECRET" server.log
0
$ grep '"tools/call"' server.log | tail -1 | jq -c '{msg, component, tool, outcome, refusal_code, arguments_hash: (.arguments_hash | length)}'
{"msg":"tools/call","component":"execution-door","tool":"github__list_branches","outcome":"refused","refusal_code":"resource-not-in-mission","arguments_hash":64}
```

The instance listened on plain HTTP with no proxy in front, so the kit's URL
(`public_url`, https) was replaced by the loopback address in the commands.
`mcp-client.mjs` was a throw-away script: `new Client(…)` and
`StreamableHTTPClientTransport` with the `Authorization` header, `connect()`,
`listTools()`, once with the default handshake and once pinned to 2026-07-28.
No call reached GitHub: an allowed `tools/call` on this seed would fail
upstream, the installation being a placeholder.

What was **not** done: connecting Claude Code itself to the instance, which is
the definition of done of the feature. The check above uses `curl` with the
kit's own command and the official MCP client; a session with Claude Code
against a TLS-terminated instance, with a real connection, remains to be done
by a human ([e2e-tests](../tests/e2e-tests.md)).

## Tests

- `src/server/execution/execution.test.ts` (17) — agent label, client address,
  `citedRefs`, tool filter, verified-token cache (once, state re-read, void
  proof, single flight, throttle), upstream credential cache.
- `tests/integration/execution/pipeline.test.ts` (20) — allowed call
  (decrement, audit entry, credential to the plugin only, env-qualified risk,
  agent label), each refusal with its fields, stale / hidden / never-hydrated
  resources, structural rejections, upstream failure, 401 → refresh → retry,
  rejected refresh → `expired`, 403, credential cache.
- `tests/integration/execution/door-http.test.ts` (17) — the official MCP
  client in both eras against the real GitHub plugin on a mocked upstream,
  refusal `data` as the client sees it, plain JSON for `curl`, 405, tool filter,
  catalog, the 401 cases, session and delegated token refused, foreign origin,
  argon2 once, verification throttle, surface rate limit, logs.
- `tests/integration/execution/counters-vs-audit.test.ts` (4) — 240 random
  calls per seed (three seeds) through the door, then
  `countersAgreeWithAudit` with no mismatch; a concurrent burst on a small
  quota.
- `packages/gateway-core/tests/unit/pipeline.test.ts` — `UpstreamRefusalError`,
  the structural rejection of the resource stage;
  `plugins/github/tests/unit/token-cache.test.ts` (5).

Scenarios in [integration-tests](../tests/integration-tests.md).

## How to debug

- **401 with a token that was just issued** — the bearer is truncated, belongs
  to another instance, or was replaced by a rotation
  (`MissionService.verifyToken` → `retired/rotated`). 401 and no
  `Authorization` header reaching the instance at all: the TLS terminator
  strips it, or the client probed `/.well-known/oauth-protected-resource` and
  got something else than the 200 above.
- **403 `wrong-credential-kind`** — a browser session cookie rides along (same
  origin as the interface) and no `Authorization` header was sent.
- **403 on every request from a browser-based MCP client** — it sends an
  `Origin`; the door answers no CORS.
- **429** — `Retry-After` says when. `-32002`: the mission's surface limit
  (`mcp.rate_limit_per_minute`) or, on a 401-looking bearer, the verification
  throttle of its prefix.
- **`Vaubaan rejected the call: …`** (`-32602`) — no refusal code: the tool is
  unknown, its provider has no connection in the mission, or the classifier
  could not place the arguments. The sentence is the classifier's. The audit
  row has `refusal_code` null and the same sentence in `refusal_reason`.
- **`resource-not-in-mission` for a resource the mission selected** — it went
  stale: the last discovery no longer returned it (Connections page, "Refresh
  discovery").
- **A tool is listed, then refused `risk-not-accepted`** — expected: the list
  is per provider.
- **`connection-unavailable` right after a call that used to work** — the
  provider answered 401 and the refresh was rejected; the audit row of that
  call is `allowed` with `upstream_error` starting with
  `connection-unavailable:`, and the log has `credential refresh rejected`
  (component `connections`).
- **`Upstream error: … 403`** — the provider refused the action; the
  connection is untouched.
- **GitHub is called with a stale installation token** — entries live at most
  50 min and are dropped on a 401; `root.execution.credentialCache.drop(id)`
  empties a connection's entries by hand.
- **Counters and audit disagree** — run `countersAgreeWithAudit` (budget) on
  the store; the entry of an allowed call carries `remaining_budget`.

## Extension

- **A new stage or check** — gateway-core's `CallPipeline` owns the order; the
  door only provides implementations.
- **A plugin that derives a per-call credential** — read
  `ctx.credentialCache` in `execute` (absent in discovery), choose a key inside
  the connection, never cache a credential that is a tool's result.
- **The management door (P2.3)** — provide a `DelegatedTokenResolver` to the
  root so delegated tokens are refused here by kind.
- **A hosted deployment** — a shared `CacheClient` for the verified tokens is
  safe (it holds token ids). Upstream credentials must stay per replica or go
  to a cache that encrypts its values.

## References

- Spec [vaubaan-gateway](../spec/vaubaan-gateway.md) §2.4, §3.1, §3.3, §4.1,
  §6, §7.5, §8, §10.
- ADRs
  [docker-image-and-config-format](../decisions/docker-image-and-config-format.md),
  [upstream-credential-cache-and-rejected-credentials](../decisions/upstream-credential-cache-and-rejected-credentials.md),
  [atomic-budget-accounting](../decisions/atomic-budget-accounting.md),
  [api-key-format-vbn-live-argon2id](../decisions/api-key-format-vbn-live-argon2id.md).
- Neighbours: [gateway-core](gateway-core.md),
  [budget-and-sessions](budget-and-sessions.md), [connections](connections.md),
  [missions](missions.md), [configuration](configuration.md),
  [plugin-sdk](plugin-sdk.md).
