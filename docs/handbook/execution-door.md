---
title: Execution door — /mcp, the call pipeline's stages, the agent label, streaming, the catalog
status: current
date: 2026-10-13
last_synced: 2026-10-27
tracks:
  - apps/gateway/src/server/execution/
  - apps/gateway/src/server/git/paths.ts
  - packages/plugin-sdk/src/git/remote.ts
  - apps/gateway/src/server/http/client-ip.ts
  - apps/gateway/src/app/mcp/
  - apps/gateway/src/app/.well-known/oauth-protected-resource/route.ts
  - apps/gateway/src/server/compose/root.ts
  - apps/gateway/tests/integration/execution/
  - apps/gateway/tests/unit/structural/catalog-caps-enforced.test.ts
  - apps/gateway/tests/unit/structural/manifest.ts
  - apps/gateway/tests/manual/seed-demo.ts
  - apps/gateway/tests/manual/streaming-check.ts
  - packages/gateway-core/src/pipeline.ts
  - packages/gateway-core/src/fingerprint.ts
  - packages/gateway-core/src/errors.ts
  - packages/gateway-core/src/types.ts
  - apps/gateway/src/server/missions/mission-service.ts
  - packages/gateway-core/tests/unit/pipeline.test.ts
  - apps/gateway/src/server/missions/bootstrap-kit.ts
  - apps/gateway/src/server/store/mission-reach.ts
  - packages/plugin-sdk/src/plugin.ts
  - packages/plugin-sdk/src/streaming.ts
  - deploy/caddy/Caddyfile
  - apps/gateway/src/server/connections/discovery-after-call.ts
---

# Execution door — `/mcp`, the call pipeline's stages, the agent label, streaming, the catalog

How an agent holding a mission token lists and calls tools: the HTTP surface,
the bearer dispatch, the stages that fill gateway-core's `CallPipeline`, the two
caches, the agent label, streaming, the catalog endpoint. Spec:
[vaubaan-gateway](../spec/vaubaan-gateway.md) §0 and §7.9 (agent label),
§4.1 (execution surface, streaming), §2.4
(no credential to the executor), §3.1 (resource selection), §6 (three
credentials, surface rate limit, no secret in logs), §7.5, §8 (audit).
Decisions:
[docker-image-and-config-format](../decisions/docker-image-and-config-format.md)
§6 (MCP SDK v2, stateless Streamable HTTP),
[upstream-credential-cache-and-rejected-credentials](../decisions/upstream-credential-cache-and-rejected-credentials.md),
[decision-stages-fail-closed-and-audited](../decisions/decision-stages-fail-closed-and-audited.md).
Built on [gateway-core](gateway-core.md) (pipeline, refusals),
[budget and sessions](budget-and-sessions.md) (`createBudgetStage`),
[connections](connections.md) (`CredentialBroker`), [missions](missions.md)
(`verifyToken`, bootstrap kit), the [plugin SDK](plugin-sdk.md) and the
[store](store.md). Replaces the legacy v4 handbook
[mcp-gateway](legacy/mcp-gateway.md).

## Layout

```
apps/gateway/src/server/execution/      host-agnostic, never imports `next`
  index.ts            createExecutionModule(deps) → root.execution { pipeline, credentialCache, tokens, door, handlers }; the log line of a failed decision stage
  door.ts             ExecutionDoor: handleMcp(), handleCatalog(); MCP serving; renders an admission denial as JSON-RPC
  admission.ts        MissionAdmission: origin, bearer, grounds, surface rate limit — one instance, shared with the git remote
  token-verifier.ts   TokenVerifier — asks the mission service at every call; throttles the argon2id check of legacy tokens
  mission-context.ts  loadMissionContext(), missionResourceOf(), periodOf()
  resource-stage.ts   createResourceStage(), citedRefs(), toolUnavailableOn()
                                                                → resource-not-in-mission; an account connected
                                                                  a way the plugin no longer declares (its stored
                                                                  credential kind is not the plugin's);
                                                                  an unbound tool on a connection that reaches
                                                                  the gateway's own hosting: `unboundTools`,
                                                                  `hosts_instance`)
                                                                  is a structural refusal, before the budget
  risk-stage.ts       createRiskStage()                         → risk-not-accepted
  scope-caps.ts       ENFORCED_INFRA_LIMIT_KEYS, ENFORCED_CAP_KEYS, unenforcedLimitsOf() — no cap stage; what the catalogs may declare
  upstream-stage.ts   createUpstreamStage()                     → broker, retry ladder, connection-unavailable
  telemetry-sink.ts   TelemetrySink port, NOOP_TELEMETRY_SINK   → the one hook of community telemetry
  credential-cache.ts ConnectionCredentialCache                 — ExecuteContext.credentialCache
  tools.ts            callableProviders(), callableTools() (minus the tools the connection's way cannot run), buildCatalog()
  request-meta.ts     readAgentLabel(), parseAgentLabel(), agentLabelOf(), clientOriginOf() — over ../http/client-ip.ts
  testing.ts          depotPlugin(), executionInstance() — tests only
  execution.test.ts   unit tests of the pure and in-memory parts
apps/gateway/src/app/mcp/route.ts           GET | POST | DELETE /mcp   → root.execution.handlers.mcp
apps/gateway/src/app/mcp/catalog/route.ts   GET /mcp/catalog           → root.execution.handlers.catalog
apps/gateway/src/app/mcp/manage/route.ts    /mcp/manage — the management door's adapter (handbook management-door), not this door
apps/gateway/src/app/.well-known/oauth-protected-resource/route.ts   RFC 9728: static bearer, no authorization server
apps/gateway/tests/integration/execution/   pipeline, door over HTTP, agent label, approvals, streaming, counters vs audit
apps/gateway/tests/manual/seed-demo.ts      seeds a local instance for the manual check
apps/gateway/tests/manual/streaming-check.ts   streaming through the standalone server: `serve`, `probe`
packages/plugin-sdk/src/streaming.ts        ToolResultPartSink, streamToolResult(), textParts(), appendPart()
```

Dependency of the door on the protocol: `@modelcontextprotocol/server` 2.3.1
(`createMcpHandler`, `isLegacyRequest`, `Server`,
`WebStandardStreamableHTTPServerTransport`, `legacyStatelessFallback`,
`ProtocolError`). The v1 package
`@modelcontextprotocol/sdk` is gone. `@modelcontextprotocol/client` is a dev
dependency: the integration test drives the door with the official client.

## A request, in order

```
POST /mcp
  origin          an `Origin` header other than public_url's            → 403
  bearer          TokenVerifier.verify → DoorAuthenticator (gateway-core)
                    missing / malformed / unknown / rotated             → 401  AuthError (-32001), WWW-Authenticate: Bearer
                    web session (cookie or bearer), delegated token     → 403  wrong-credential-kind
                    too many hash verifications, prefix + client address → 429
  grounds         MissionGrounds.inspect(mission): the creator's authority, re-read from the store;
                    an active mission it does not ground is `orphaned` for this request, nothing
                    is stored (handbook authority)
  mission context loadMissionContext (store reads, no cache)
  surface rate    rateLimiter.take('mcp:mission:<id>', mcp.rate_limit_per_minute, 60 s) → 429 (-32002), Retry-After
  protocol        isLegacyRequest(request)
                    ? (tools/call with a progressToken ? legacyStatelessFallback (SSE) : stateless JSON transport)
                    : createMcpHandler(...).fetch
  tools/list      checkMissionActive → callableTools(ctx, registry)
  tools/call      CallPipeline.execute(ctx, { tool, args, agent_label, client, onPart?, signal })
```

Everything before "protocol" answers with a JSON-RPC error envelope whose `id`
is `null` (no request was parsed yet); everything after is a JSON-RPC response
to the request's own id.

### Admission (`admission.ts`)

`MissionAdmission` is the part of a request the two doors of the execution
surface share: this one and the git remote (`/git/**`, handbook
[git-remote](git-remote.md)). The MCP door builds the one instance
(`ExecutionDoor.admission`) and the git module is handed it, so the two cannot
drift: same verifier, same 401 reasons, same `wrong-credential-kind`, same
grounds, same surface window. `admit(request, authorization)` answers either
`{ ctx, mission, client }` or a denial (`cross-origin`,
`verification-throttled`, `unauthenticated` with its `AuthError`, `refused`
with a `Refusal`, `rate-limited`); each door renders a denial in its own
protocol — JSON-RPC here, HTTP text and a Basic challenge at the git remote,
which passes the password of its Basic credential as `Bearer <key>`. A
structural test of the git suite holds `root.git.door.admission ===
root.execution.door.admission`.

- **Origin.** A request that carries an `Origin` header different from
  `config.publicUrl.origin` is refused. The door sends no CORS header and
  exports no `OPTIONS`.
- **Bearer dispatch.** `DoorAuthenticator.authenticateMission` (gateway-core)
  over the door's `CredentialResolver`:

  | Presented                                                   | Outcome                                                                            |
  | ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
  | active mission token                                        | `MissionContext`, whose `token.holder` is who the call is attributed to            |
  | token revoked with its mission                              | `MissionContext` with `status: 'revoked'` → `mission-inactive` on the first method |
  | token that stopped on its own (see "Token holders" below)   | 401 with `error.data.reason`                                                       |
  | unknown prefix, wrong secret, anything that is not a bearer | 401, no reason                                                                     |
  | no `Authorization`, a valid session cookie                  | 403 `wrong-credential-kind`, `presented: human-session`                            |
  | a web session id as bearer                                  | same                                                                               |
  | a bearer the `DelegatedTokenResolver` recognises            | 403 `wrong-credential-kind`, `presented: delegated-token`                          |

  `DelegatedTokenResolver` is `ExecutionModuleDeps.delegations`: the root
  wires the authorization server's `DelegatedTokenVerifier`
  (`root.oauth.verifier`, handbook [management-door](management-door.md));
  `RootDeps.delegatedTokens` replaces it in tests of the door alone. Only a
  live delegated access token is recognised: a revoked or expired one, or a
  refresh token, is an unknown bearer (401). So is the token of a client that
  is no longer approved — disabled by an operator, or left pending by a
  registration policy tightened since — because the verifier evaluates the
  client's status at every call and answers `null` for it: such a token is
  answered 401 here, not `wrong-credential-kind`. The
  hint of the refusal names where the presented kind is accepted
  (`ACCEPTED_AT` in gateway-core's `errors.ts`).

- **Surface rate limit.** Per mission, all agents together; the key and the
  window are the door's, the limit is `InstanceConfig.mcp.rateLimitPerMinute`
  ([configuration](configuration.md)). It is not the `rate-limited` refusal:
  that one is per risk, decided by the budget, and carries a `risk_id`.
  **It stays per mission** (product owner's decision of 2026-10-13, ADR
  [owner-decisions-of-2026-10-13](../decisions/owner-decisions-of-2026-10-13.md)):
  it bounds what one mission sends to the instance and to the provider, and a
  window per token would multiply that ceiling by the number of tokens. One
  holder can therefore use up the window for the others (threat model, A26);
  the audit names the holder of each call, and the creator revokes that token
  alone.

### Token holders: who is calling, and when a token stops

A mission has one or more tokens, each with one holder (spec §0 "Mission
token"; ADR
[mission-members-and-per-holder-tokens](../decisions/mission-members-and-per-holder-tokens.md)):
a **member token**, generated by a member of the mission for themselves, or a
**named token**, created by the creator for something with no account. The
verification (`MissionService.verifyToken`, handbook [missions](missions.md),
"Members and tokens") yields the mission, the token and its holder —
gateway-core's `TokenHolder`: `{ kind: 'member', user_id, display }` (the
member's email) or `{ kind: 'named', name }`. The door puts it in
`MissionContext.token`, and from there:

- the pipeline writes `token_id`, `token_kind` and `token_holder` (the user id,
  or the name) on **every** call audit entry (`tokenAttributionOf`,
  gateway-core), and the budget stage hands the same three to the session
  event of the call;
- `GET /mcp/catalog` tells the caller whose token it holds;
- the `tools/call` log line carries `token_kind` and `holder_label`.

Nothing the caller sends changes it: the holder is the token's. The
[agent label](#agent-label-request-metats) stays the self-declared refinement
inside a token.

**One budget.** Every token of a mission draws from the same counters: the
budget stage keys them by `(session, risk, period)` and reads no holder. The
surface rate limit is per mission too.

**A token that stops working.** What a token is worth is judged at every call
from the store (`MissionService.standingOf`), on a cache miss and on a hit
alike:

| What happened                                            | The door answers                                    |
| -------------------------------------------------------- | --------------------------------------------------- |
| its holder generated a newer one                         | 401, `data.reason: 'token-rotated'`                 |
| its holder, or the creator, revoked it                   | 401, `data.reason: 'token-revoked'`                 |
| its member was removed from the mission                  | 401, `data.reason: 'holder-removed'`                |
| its member was deactivated on the instance               | 401, `data.reason: 'holder-deactivated'`            |
| the mission was revoked (every token is revoked with it) | `mission-inactive` (revoked), as before             |
| the creator lost the authority, or was deactivated       | `mission-inactive` (orphaned), for **every** holder |

The four reasons are `AUTH_FAILURE_REASONS` (gateway-core's `errors.ts`), with
one sentence each for the agent (`AUTH_FAILURE_MESSAGES`, the 401's message).
They are **not** refusal codes: the mission may be serving its other holders,
so `mission-inactive` would be false, and the eight structured refusals stay
eight. A reason is stated only to a caller whose secret was proven; an unknown
bearer gets the 401 without one. The holder is judged before the token's
status: a removed member is told `holder-removed` whatever became of the
mission since. Such a 401 is refused before the pipeline: no credit, no call
entry — the removal or the revocation has its own administrative entry.

The membership and the holder's status are **read**, not remembered: a row in
`mission_members` marked removed, or a `users.status` of `removed`, refuses
the token at the next call even if nothing revoked the token row
(`tests/integration/execution/team-door.test.ts`).

**Last used.** After admission the door records `mission_tokens.last_used_at`
(`MissionsRepo.markTokenUsed`, at most one write per token per
`TOKEN_LAST_USED_GRANULARITY_SECONDS` = 60). It is the door's only write
outside the pipeline; a failure is logged and never refuses the request.

### Token verification (`token-verifier.ts`)

`TokenVerifier.verify(bearer, clientIp)` → `TokenVerification` (missions) or
`{ outcome: 'throttled', retryAfterMs }`. `clientIp` is the address of the
[client-address rule](#client-address), `unknown` when it cannot be resolved;
the door resolves it once per request, before authenticating, and builds the
`DoorAuthenticator` of that request around it.

A mission token is stored as the **SHA-256 digest** of the Bearer
(`mission_tokens.hash`, `hash_alg = 'sha256'`; ADR
[mission-token-sha256-digest](../decisions/mission-token-sha256-digest.md)).
Verifying one is a lookup by prefix and a constant-time comparison, so:

- **Nothing is remembered.** Every call goes to
  `MissionService.verifyToken`, which reads the row, its mission and — for a
  member token — the holder's status and membership, and ends in
  `standingOf`. Rotation, revocation, a member removed and a holder
  deactivated are seen by the next call because there is no cached answer to
  be stale. The verified-token cache, its sliding TTL and its single-flight
  map are gone: they existed to skip an argon2id computation.
- **Nothing is throttled**, for a token stored as a digest: a wrong secret
  costs a row read and a hash of forty-nine bytes. Wrong secrets replayed on
  a real prefix are answered 401, each of them, and never hold the agent.

**Tokens issued by an earlier build** are stored as an argon2id hash
(`hash_alg = 'argon2id'`) and keep working:

- `bearerMatches` checks the row with the algorithm the row names. A row
  naming any other algorithm matches nothing.
- That check costs tens of milliseconds, so it is the one thing still
  throttled: the verifier hands `verifyToken` a gate,
  `rateLimiter.take(verifyThrottleKey(prefix, clientIp), VERIFY_ATTEMPTS_PER_WINDOW (30), VERIFY_WINDOW_MS (60 s))`
  — key `mcp-verify:<prefix>:<client address | unknown>` — which the service
  asks only when the row it found is a legacy one, before computing anything.
- **The first call that matches moves the row**:
  `MissionsRepo.rehashToken(id, { fromHash, hash, hashAlg })` replaces the
  argon2id hash by the SHA-256 digest of the same Bearer, only while the row
  still holds the hash that was read (two concurrent calls write once). Same
  row, same prefix, same holder, same status. One `info` log line,
  `mission token moved to its sha256 digest`, with the mission and the prefix.
  If the write fails the call still goes on — the token is as valid as before
  — a `warn` line says so and the next call tries again.
- **Why the address is in the throttle key.** The prefix is not a secret (log
  lines, session events, the Missions pages). Keyed on the prefix alone,
  thirty wrong secrets a minute would keep the real agent at 429. With
  `trusted_proxies` configured, a flood closes only the window of the address
  it comes from. Without it every caller is `unknown` and shares one window
  per prefix: the agent of a legacy token that has never called since the
  upgrade can be held off for the duration of a flood. One successful call
  ends that for good. The composition root logs one warning at boot naming
  the key ([configuration](configuration.md), "Boot sequence"; ADR
  [execution-door-json-faithful-arguments-and-shared-throttle](../decisions/execution-door-json-faithful-arguments-and-shared-throttle.md),
  whose throttle now concerns legacy tokens only).

Once every legacy row has been used or retired, the throttle is dead code and
goes with the `argon2` dependency. `SELECT COUNT(*) FROM mission_tokens WHERE
hash_alg = 'argon2id' AND status = 'active'` says how many are left.

### Grounds (`admission.ts` → `authority/mission-grounds.ts`)

Between the token verification and the mission context,
`credentialResolver` calls `deps.grounds.inspect(verified.mission)`: for a
mission the store holds as `active` it re-reads the creator's status,
memberships and shares, and returns the mission with `status: 'orphaned'`
when they do not cover its accepted risks or when one of its connections is
revoked. The context is built from that mission, so `checkMissionActive`
refuses `mission-inactive` with `status: 'orphaned'` on `tools/list`,
`tools/call` and the catalog alike.

Nothing is written: `orphaned` is derived for this request and stored nowhere
(spec §2.3). The next request asks again, so the day the authority is back the
**same token** is served, on the same session and counters — a refused call
consumed nothing. The door writes no administrative entry in either direction
(no human is behind a read): it logs `mission orphaned at the execution surface`
(info, with `cause`, `connection_id`, `uncovered`) and the pipeline audits the
refused call. A `revoked` or `expired` mission is not re-checked.

`grounds` is a required dependency. Rule, causes and measured cost (about
17–45 µs per request): [authority](authority.md), "Orphaned missions" and
"The door".

`inspect` also returns the mission's **lost parts** — a connection revoked,
or one the creator's access to was withdrawn (handbook authority, "Orphaned
missions"; ADR orphaned-missions-and-ownerless-connections, amendment
2026-10-21). They go to `loadMissionContext`, which marks each such
connection `lost` (`connection-revoked` | `access-withdrawn`; a `revoked` one
whatever the grounds said, its status being final). The mission keeps serving
through its other connections:

- a call that resolves to a lost connection is refused `connection-revoked`
  by `checkConnectionAvailable`, right after the resource stage — nothing
  classified, nothing counted; the git remote's prechecks run the same check,
  so `git clone` / `push` on that connection read the refusal's line
  ("…was removed and no longer serves this mission…");
- `tools/list` leaves its tools out (`callableProviders` skips a lost
  connection), and the catalog lists it with `lost`;
- a mission whose every connection is lost reads `orphaned` and is refused
  `mission-inactive`, as before. `connection-unavailable` stays the refusal of
  an `expired` connection, which its owner reconnects.

### Mission context (`mission-context.ts`)

`loadMissionContext(store, mission, token, selfResources)` builds
gateway-core's `MissionContext` on every request; `token` is the verified
one, with its holder (`{ id, prefix, holder }`); `selfResources` is
`config.selfResources` (the admission passes it):

- `connections` — one `MissionConnection` per `mission.connections` entry, with
  the current `status` and `owner.display` (the user's email, or the group's
  name).
- `resources` — `reachedResources(selection, connections.listResources(…),
isSelf)` (`store/mission-reach.ts`, the function the mission page and the
  bootstrap kit call too; handbook [missions](missions.md), "What a mission
  reaches on a connection"). For an explicit selection: the rows whose id is in
  the mission's `resourceIds` **and** whose `staleSince` is null **and** that
  are not one of the instance's own (`isSelfResource`, handbook
  [configuration](configuration.md) "Self resources": a stored selection that
  names it still cannot reach it); hidden ones stay. Scope `all` with an empty
  list yields nothing: that selection is never hydrated from the live list.
  Scope `connection` (the creator gave the whole account, ADR
  [mission-reaches-the-whole-connection-on-request](../decisions/mission-reaches-the-whole-connection-on-request.md))
  **is** the live list, read on every request: every row neither hidden, nor
  stale, nor the instance's own — so `resource-not-in-mission` no longer fires
  for a resource discovered after issuance, and does for one discovery no
  longer returns. The same array is what a plugin's `execute` receives as
  `ctx.resources`: a "list" tool that filters its answer to the mission
  (`fly__list_apps`, `cloudflare_dns__list_zones`) sees exactly what the
  resource stage allows. Each such `MissionConnection` carries
  `reaches_later_resources: true`, which the `resource-not-in-mission` hint
  reads ("This mission reaches the whole account except the resources its
  owner hid or that are no longer found: … A resource created through the
  gateway is reached right after its creation; one created elsewhere once the
  account's owner refreshes its resources.").
- `policy` — `mission.policy` through `policyEntryOf` (budget).
- `session` — `sessions.getByMission`, or `null` before the first call.

## The stages

`createExecutionModule` builds one `CallPipeline` (gateway-core) with:

| Stage     | Implementation                                                             | Refuses                                                 |
| --------- | -------------------------------------------------------------------------- | ------------------------------------------------------- |
| resources | `createResourceStage({ registry, connections })`                           | `resource-not-in-mission`; rejects a call no one owns   |
| risks     | `createRiskStage({ registry })`                                            | `risk-not-accepted`; rejects a classifier denial        |
| budget    | `createBudgetStage({ service: root.budget, missions })`                    | `budget-exhausted`, `rate-limited`, `approval-required` |
| upstream  | `createUpstreamStage({ credentials, credentialCache, logger, telemetry })` | `connection-unavailable` (after the allow)              |
| audit     | `store.auditWriter` (`SqliteAuditWriter`)                                  | —                                                       |

`mission-inactive` and `connection-unavailable` (a connection already `expired`
or `revoked`) come from the pipeline's own pure checks.

**A decision stage that throws refuses the call, and the refusal is
audited.** The resource, risk and budget stages (`DECISION_STAGES` in
gateway-core's `pipeline.ts`) each run inside `CallPipeline.attempt`. A stage
that throws — a classifier that is not total, a store failure under the
budget — has decided nothing: the outcome is `rejected`, nothing is counted,
nothing is sent upstream, and the call's audit entry is written on what the
earlier stages filled (no target when the resource stage failed, the touched
risks when the budget stage did), with `decision: 'refused'` and no
`refusal_code`. The reason is `stageFailureReason(stage, thrown)`, built from
the stage and the class name of what was thrown, never from its message, which
can quote the arguments:

```
Vaubaan could not decide this call: the risk stage failed (TypeError). The call was refused and nothing was executed; the operator finds the error in the instance log.
```

The agent reads that sentence (`-32602`) and the audit stores the same one. The
thrown value goes to `CallPipelineDeps.onStageError(stage, error, call)`,
which `createExecutionModule` wires to one `error` line, `call refused: a
decision stage failed` (component `execution-door`), carrying `stage`, `tool`,
`error_class` and `stack_frames` (the first 12 `at …` lines of the stack). The
message is left out of the log too: no log line carries an argument. An
observer that throws changes nothing, and a failure of the audit write itself
still propagates, as for any call. The upstream stage is not part of this: a
provider failure has its own path (below). Structural invariant
**[inv: every-refused-call-audited]**
(`tests/unit/structural/manifest.ts`); ADR
[decision-stages-fail-closed-and-audited](../decisions/decision-stages-fail-closed-and-audited.md).

**Before any stage: the arguments must be JSON values.** `CallPipeline.execute`
first asks gateway-core's `unfaithfulArgument(call.args)` for a non-finite
number (`1e999` in the request body parses to `Infinity`, which canonical
JSON writes `null`) or a BigInt. When there is one the call is a `rejected`
outcome naming its path
(`argument 'per_page' is Infinity: arguments must be JSON values (…)`)
before the mission's state is looked at: no stage runs, no
budget is spent, no request is opened, nothing reaches the plugin. What is
fingerprinted, sealed for the approver and handed to the plugin is therefore
always what JSON carries as is ([gateway-core](gateway-core.md), "Audit"
and "Order of a call"; ADR
[execution-door-json-faithful-arguments-and-shared-throttle](../decisions/execution-door-json-faithful-arguments-and-shared-throttle.md)).

### Resource stage (`resource-stage.ts`)

1. `registry.providerForTool(tool)` → the plugin; none → rejection
   `unknown tool '<name>'…`.
2. The door the call came through (`doorMismatch`): the two tools of a
   plugin's git remote (`gitRemote.fetchTool`, `gitRemote.pushTool`) are
   decided only for a call whose `CallRequest.channel` is `git`, and every
   other tool only for `mcp` (the default). A mismatch is a rejection — a git
   tool over MCP reads "…is how the gateway records git itself; it cannot be
   called over MCP…" — so the arguments of a push are always the host's
   review, never an agent's claim.
3. The mission's connection of that provider (one per provider per mission);
   none → rejection `…this mission holds no <Provider> connection.`
4. `allowed` = the context's resources on that connection; `known` = every
   resource row of the connection.
5. `plugin.classify(tool, args, allowed, connection)`, where `connection`
   is `classifyConnectionOf(MissionConnection)`: the connection's public form
   fields (`public_fields`, loaded by `loadMissionContext` from
   `metadata.fields` through `connectionPublicFields`), nothing secret. The
   risk stage hands the same view to `evaluateCallForToken`, so the slices
   it audits are the ones this stage resolved (a Fly call cites
   `org[<the connection's org>]`):
   - slices → `citedRefs(slices, knownRefs)`: the `ident` and `list` segments
     that equal a known ref. A cited ref outside `allowed` →
     `resource-not-in-mission`. Otherwise the target resource is the first
     of the mission's resources on the connection whose ref is cited, or the
     mission's single resource on the connection, or `null` (account-level
     tool).
   - denied, and the connection knows refs the mission does not hold →
     `plugin.classify(tool, args, known, connection)`; if that resolves to a ref outside
     `allowed` → `resource-not-in-mission` naming it. This is the path of a
     resource never selected, discovered after issuance, or selected and stale
     since.
   - otherwise the stage passes with `resource: null` and the risk stage
     reports the classifier's reason.

The refusal carries `cited_ref`, `connection { id, name }` and
`allowed_resources [{ ref, env, display_name }]`. A ref the connection has
never discovered is indistinguishable from a malformed argument: the call is
rejected with the classifier's sentence, not with the typed refusal. A
classifier that throws is read here as a denial whose text is not kept: the
stage passes with `resource: null`, the risk stage runs the classifier again,
and that throw is the stage failure described above.

### Risk stage (`risk-stage.ts`)

`evaluateCallForToken` with the registered plugin as classifier, its indexed
catalog, the mission's resources on the target connection and
`acceptedRisksOf(ctx)`; `denied_risks` is left out (a v5 mission carries
no explicit denies: the policy is the enumeration). Environment
qualification is gateway-core's default (`envResolverFor(resources,
plugin.envOf)`).

An env-scoped risk touched on a resource whose environment is not in the
risk's `acceptable_in_envs` — an unlabelled resource, a free-text label such
as `production`, or a risk only acceptable in `staging` touched on `prod` —
**refuses the call** (`risk-not-accepted`; the hint names the risk and the
environments it is acceptable in). The risk is never dropped from
`risks_touched`: a broader co-touched risk does not carry the call alone. The
remedy is the owner's: label the resource on the account's page
(`/accounts/<id>`).

Two more cases have no environment, and so refuse every env-scoped risk the
call touches: a slice that cites several resources of the mission whose
labels differ, an unlabelled one included (every identifier and list value is compared, not
the first one only), and a slice for which the plugin's `envOf` answers
`NO_SINGLE_ENV` (the call names a wildcard or a list where one environment
is expected; the owner's label does not stand in for it). And a slice that
carries a `*` inside an identifier or a list value is refused
`risk-not-accepted` whatever the policy: a slice names what the call touches,
the whole identifier `*` being the only way to say "any" (handbook
[policy-engine](policy-engine.md)).

### Scope caps: not enforced (`scope-caps.ts`)

The door has **no cap stage**. `plugin.normalizeForCaps` and
`plugin.normalizeArgs` are never called, the arguments reach the provider as
the agent sent them, and a catalog's `caps` block (items per call, time
window, bytes per call, calls per session) is applied nowhere. What bounds the
amplitude of a mission is the per-risk quota, rate limit and gate of its
policy, and its resource selection.

The one catalog limit the gateway enforces is
`infra_limits.calls_per_minute_max`: the mission preview refuses a rate limit
above it (`missions/preview.ts`, `budgetProblem`), and the budget stage then
enforces the mission's rate limit. `scope-caps.ts` holds that list
(`ENFORCED_INFRA_LIMIT_KEYS`, `ENFORCED_CAP_KEYS` — empty) and
`unenforcedLimitsOf(entry)`; the structural test
`tests/unit/structural/catalog-caps-enforced.test.ts` fails when a shipped
catalog declares anything else, so a catalog never states a limit the gateway
does not apply. Decision, removed values and what wiring the stage would take:
[scope-caps-not-enforced-in-v5-0](../decisions/scope-caps-not-enforced-in-v5-0.md).

### Upstream stage (`upstream-stage.ts`)

```
resolved = credentials.resolve(connectionId)              ConnectionUnavailableError → connection-unavailable
plugin.execute({ ...credentials.contextOf(resolved),
                 resources, agentLabel, credentialCache, emitPart }, tool, args)
  UpstreamAuthError 401, no part emitted yet
    credentialCache.drop(connection) > 0  → execute again with the same credential
    still 401 (or nothing was cached)     → credentials.refresh(connectionId) → execute once more
       refresh rejected (connection now `expired`) → connection-unavailable
  UpstreamAuthError 403, UpstreamHttpError, any other error
                                          → UpstreamFailureError { summary, detail, status }
  any error after a part was emitted      → UpstreamFailureError, never retried (see Streaming)
```

Every failure that is not `connection-unavailable` leaves the stage as
gateway-core's `UpstreamFailureError`, which separates two readers:

- `detail` is the error's message — the plugin's sentence, which quotes the
  request path and the start of the provider's body. It goes to the agent
  only (the `failed` outcome, then the tool result).
- `summary` is what the audit stores in `upstream_error`. The stage builds it
  from the provider id, the HTTP status when the error carries one
  (`UpstreamAuthError.upstreamStatus`, `UpstreamHttpError.status`, or a
  numeric `status` between 100 and 599 on any error) and the error's class
  name: `github answered HTTP 403 (UpstreamAuthError)`,
  `vercel answered HTTP 500 (UpstreamHttpError)`, `stripe call failed (Error)`;
  for a streamed result, `<provider> stream failed after N parts (…)` or
  `<provider> stream stopped after N parts: the caller was gone`
  ([Streaming](#streaming)).
  Never the provider's text: providers echo input in their errors, and the
  audit keeps no trace of the arguments but their hash.

`connection-unavailable` after the allow is thrown as gateway-core's
`UpstreamRefusalError`: the audit entry stays `decision: 'allowed'` with
`upstream_error: 'connection-unavailable: <status>'`, the credit stays
consumed, and the pipeline's `failed` outcome carries the refusal. A
`ProviderUnreachableError` from the broker, a 403 and any provider failure
are plain `failed` outcomes, audited by their summary.

The stage only sees a provider failure the plugin **throws**. The plugin
contract says so ([plugin-sdk](plugin-sdk.md), "Errors of `execute`"): 401/403
as `UpstreamAuthError`, another failed status as `UpstreamHttpError`, a
network failure as it comes. A result with `isError: true` is the executor
declining the call itself (an unknown tool, an argument it cannot read or
that the tool does not declare, a target outside the mission) — the SDK's
`ExecutorRefusal`, turned into that result by `declining()`: it is an
`allowed` outcome with no `upstream_error`, handed to the agent untouched. Every shipped plugin
follows the rule (since the second review cycle: `vercel` and `upstash-redis`
used to return provider failures as results; `cloudflare-dns` used to throw
its own refusals).

**Telemetry hook.** `UpstreamStageDeps.telemetry` is a `TelemetrySink`
(`telemetry-sink.ts`; default `NOOP_TELEMETRY_SINK`). `forward()` notes, in a
`WeakMap` keyed by the `CallRequest`, the plugin the call reached;
`execute()` then calls `report(call, outcome)` exactly once — with the result,
or with the error it is about to wrap — after the retry ladder. Two calls are
not reported: one the broker stopped before `plugin.execute` ran, and one
whose caller went away (the error is `CallerGoneError`, or the call's signal
is aborted when the plugin fails) — a disconnect is not an outcome of the
plugin, and the audit entry still records it. A sink that throws is caught.
The event holds the plugin (`id`, `version`, `tools`), the
tool and the outcome: no mission, no connection, no resource, no argument.
What becomes of it: handbook [telemetry](telemetry.md).

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

No shipped plugin uses it today: the GitHub plugin cached its per-call
installation tokens there until the App left (ADR
one-place-to-authorize-services-token-first); a pasted token is sent as it
is.

## What the agent receives

| Pipeline outcome        | JSON-RPC answer to `tools/call`                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `allowed`               | `result` = the plugin's `McpToolResult`, untouched (after its parts, if it streamed)       |
| `refused`               | `error { code: -32603, message: 'Vaubaan refused the call: <code>', data: <the refusal> }` |
| `failed` with a refusal | same (`connection-unavailable`)                                                            |
| `failed`                | `result { isError: true, content: [{ type: 'text', text: 'Upstream error: <detail>' }] }`  |
| `rejected`              | `error { code: -32602, message: 'Vaubaan rejected the call: <reason>', data: { reason } }` |

`data` is the whole refusal — `code`, the fields of the code, `hint` — as
`refusalToRpcError` builds it; the door throws it as the SDK's `ProtocolError`
so the transport serializes it untouched (`refusalError` in `door.ts`).
`tools/list` on an inactive mission is the same error with `mission-inactive`.

One log line per call (`tools/call`, component `execution-door`): mission id,
token prefix, token kind, holder label (the member's email or the token's
name), tool, outcome, refusal code, `arguments_hash`, agent label. Never an
argument, never the bearer.

### After the answer: what a creating call made, then a discovery

ADRs [created-resources-join-the-mission](../decisions/created-resources-join-the-mission.md),
[discovery-runs-after-a-creating-call](../decisions/discovery-runs-after-a-creating-call.md).
On an `allowed` outcome, the door **awaits** `afterCall(ctx, { tool,
connectionId: audit.connection_id, result, args })`
(`ExecutionDoorDeps.afterCall`, `followCall` in `door.ts`) before returning
the result. `createExecutionModule` wires it to two steps:

1. `CreatedResources.record(ctx, call)` (`created-resources.ts`), on the
   request path — when the tool is in its plugin's `resourceCreatingTools`, the
   result is not `isError` and the connection is the mission's connection of
   that provider: the plugin's `createdResources` reads the created resource
   from the answer, the host records it on the connection and adds it to the
   mission's selection, and audits `mission-resources-added` (handbook
   [missions](missions.md), "What a mission creates, it reaches"). Local
   SQLite writes only; it never throws and returns the refs it recorded (`[]`
   on a failure, logged `created resources not recorded` with its class only);
2. `connections.discoveryAfterCall.afterCall(ctx, call, createdRefs)`, which
   only schedules and returns: the connection's discovery runs on a later turn
   of the event loop, coalesced and bounded (handbook
   [connections](connections.md), "Discovery after a creating call").

A hook that throws or rejects is logged (`after-call hook failed`, its class
only) and the answer leaves unchanged. The arguments ride `call.args` to the
plugin's pure hook only; they are never logged nor audited. `refused`,
`rejected` and `failed` outcomes, the permission tool and the git
remote never reach it. The next call's context (`loadMissionContext`, read per
request) then holds the new resource, under an explicit selection as under the
whole connection.

### Audit entry

Written by the pipeline, once per call. Who called is `token_id`,
`token_kind` and `token_holder`, from the authenticated context ("Token
holders" above). Fields filled by the door:
`agent_label` (below), `client_ip` / `client_user_agent` (`clientOriginOf`),
`arguments_hash` = `fingerprintArguments(args)` — the canonical SHA-256 (64 hex)
that also binds approvals, so an `approval-required` refusal's `fingerprint`
equals the entry's hash. The entry of a call rejected for a non-finite number
keeps that canonical hash (the value reads `null` there), with
`decision: 'refused'` and no `refusal_code`.

**The stored reason of a rejection is not always the sentence the agent
read.** `refusal_reason` of a `rejected` call is chosen at each call site of
the pipeline, and bounded at `AUDIT_REASON_MAX_LENGTH` (500 characters):

| Rejection                                               | The agent reads             | The audit stores                                                                                                    |
| ------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| a plugin's denial, or the resource stage's own sentence | the sentence                | `auditReason(reason, args)`: every argument value of 3 characters or more found verbatim in it becomes `[argument]` |
| an argument JSON cannot carry                           | the sentence, with the path | the same without the path, whose names the caller chose (`an argument is Infinity: …`)                              |
| a missing catalog, a decision stage that threw          | the sentence                | the same sentence: the host built it from what it knows, nothing of the call                                        |

A string or a finite number of fewer than 3 characters, a boolean, and a
value the plugin quoted in another form (lower-cased, encoded, truncated)
are not recognised and stay. The hint of a typed refusal is stored as it is:
it names the cited resource ref, as the entry's `resource_ref` does.

The creator's view of an approval request reads the
slices and the touched risks of the call from this entry, found by mission,
tool and that hash; the entry of the approved replay carries `approval_id`.

### `approval-required`

A call touching a risk gated `approval` is refused whole: `risk_ids` (every
gated risk the call touches; `risk_id` is the first), `fingerprint`,
`approval_url` (`<public_url>/r/<id>` — one request for the call, however
many gated risks it touches), `expires_at` (the
request's), `approval_valid_seconds` (`approvals.expiry`) and a hint that
tells the agent to hand the URL to its human and to replay the same tool with
exactly the same arguments within that delay of the grant. The door does
nothing more: the creator answers on the human surface
([requests](requests.md), "Approvals"), the agent replays, and the budget
stage finds the approval. `tests/integration/execution/approval-door.test.ts`
runs it with the GitHub plugin's `developer` preset as shipped.

### Agent label (`request-meta.ts`)

A label is what a caller says about itself, so that the session and the audit
tell who did what when several agents work on one mission (spec §0, §7.9). It
is attribution only: **nothing decides on it**, it reserves no share of the
budget, and it is never an identity — nothing proves it. Decision: ADR
[atomic-budget-accounting](../decisions/atomic-budget-accounting.md), "The
agent label never reaches the decision" and its amendment of 2026-10-13
[the agent label is checked, not repaired](../decisions/atomic-budget-accounting.md#amendment-2026-10-13--the-agent-label-is-checked-not-repaired-p27).

**Transport.** Two carriers, read by `readAgentLabel(headers, params._meta)`:

| Carrier                                | Set by                                                        | Precedence |
| -------------------------------------- | ------------------------------------------------------------- | ---------- |
| `params._meta.agent` of a `tools/call` | an orchestrator that sends the calls of several agents itself | first      |
| HTTP header `X-Vaubaan-Agent`          | a sub-agent, once, in its own copy of the MCP configuration   | second     |

The per-call value wins when both are present. A carrier that holds nothing
(absent, empty, blank) or whose value is rejected leaves the place to the next
one, so a call whose `_meta.agent` is not a label is attributed to its header.

**Shape.** 1 to `AGENT_LABEL_MAX_LENGTH` (64) characters: ASCII letters and
digits plus `AGENT_LABEL_PUNCTUATION` (`. _ - : / @ +`), the first character a
letter or a digit; surrounding whitespace is trimmed. Both constants live in
`missions/bootstrap-kit.ts`: the door builds its check from them and the kit
prints them, so agents are told exactly what is checked.

**A value that is not a label is dropped, never refused.** No repair, no
truncation: the call proceeds as if no label had been sent, and the door logs
`agent label dropped` (info, component `execution-door`) with `mission_id`,
`carrier` (`meta` | `header`), `reason` (`not-a-string` | `too-long` |
`invalid-character`) and `length` — never the value. `parseAgentLabel(raw)`
is the pure check (`absent` | `label` | `rejected`).

**Where it goes.** `CallRequest.agent_label` → the audit entry
(`agent_label`), the session event of the call (`call-allowed` /
`call-refused` details, written by the budget) and `ExecuteContext.agentLabel`
(a plugin may forward it to its provider as a trace; none does). Read back by
the activity of a mission (`/missions/<id>/session`: calls per label, timeline
filter) and the agent filter of Activity ([audit](audit.md)).

**What it does not touch.** The pipeline's stages never read it: the mission
is identified by the token, the counters are keyed by session, risk and
period, the surface rate limit by mission. Two labels, or none, draw from the
same counters; a label that names a user, another mission or `admin` is a
string like any other. `tests/integration/execution/agent-label.test.ts`
holds this over HTTP.

### Client address

One rule for the whole instance, in `src/server/http/client-ip.ts`
(`clientIpOf`, `trustedProxyList`, `isTrustedProxyEntry`, `UNKNOWN_CLIENT`):
the right-most `X-Forwarded-For` hop that is not in `trusted_proxies`
(addresses and CIDR blocks, `node:net` `BlockList`); `unknown` when
`trusted_proxies` is empty, when a hop is malformed, or when every hop is a
proxy. Hops are trimmed and read with or without a port or brackets
(`203.0.113.7:4711`, `[2001:db8::7]:4711`); an entry of `trusted_proxies` is
trimmed, and one that is not an address or a CIDR block with a whole-number
length within its family is skipped — the config loader refuses it at start
with the same parser.

Three readers, one answer: `clientOriginOf` (this door) turns `unknown` into
`client_ip: null` for the audit entry; the token-verification throttle above
keys on it; the request page keys its surface rate limit on it
(`requests/client-ip.ts` re-exports the module).

## Protocol

- **2026-07-28** requests (per-request `_meta` envelope) go to
  `createMcpHandler(factory, { legacy: 'reject', responseMode: 'auto' })`: one
  `Server` per request, a JSON body, upgraded to SSE only if a handler emits a
  notification before its result (the progress of a streamed result).
- **2025-era** requests (`initialize`, bare `tools/list`, what Claude Code
  sends today) are detected with `isLegacyRequest` and served by a fresh
  `Server` over `WebStandardStreamableHTTPServerTransport({ sessionIdGenerator:
undefined, enableJsonResponse: true })`: stateless, one JSON body per POST.
  `GET` and `DELETE` answer 405.
- Both legs build the server with `ExecutionDoor.buildServer(scope)`; on the
  modern leg the scope travels in `authInfo.extra` (the `token` field of
  `AuthInfo` is the masked prefix).
- A 2025-era `tools/call` that carries `_meta.progressToken` is served by
  `legacyStatelessFallback(factory)` instead — the SDK's own stateless leg,
  which answers in SSE — so progress notifications have a stream to travel
  on. See [Streaming](#streaming).
- Plugins return a complete `McpToolResult`, and may emit its parts on the
  way (`ExecuteContext.emitPart`).
- `GET /.well-known/oauth-protected-resource` answers `{ resource:
<public_url>/mcp, authorization_servers: [], bearer_methods_supported:
['header'] }` so clients that probe it use the static bearer. The route file
  is an adapter over `root.oauth.discovery.executionResource(request)`: the
  document and its answer (`GET`, `HEAD`, `OPTIONS` as a CORS preflight) are
  built by the authorization server module, like the two other discovery
  documents ([management-door](management-door.md)).

## Streaming

Spec §4.1: "the gateway forwards streamed responses unmodified; the decision
is made before the stream starts". Decision: ADR
[plugin-contract-and-credential-spec](../decisions/plugin-contract-and-credential-spec.md),
amendment of 2026-10-13
[streamed results](../decisions/plugin-contract-and-credential-spec.md#amendment-2026-10-13--streamed-results-p27).

### What MCP allows

A `tools/call` is answered by **one** JSON-RPC message: the protocol
(2025-era and 2026-07-28 alike) has no partial result. What can leave before
that message is a `notifications/progress` on the call's own event stream
(SSE), and only for a caller that asked for it with `_meta.progressToken`. So
"forwarding a streamed response" means here:

- each part the provider delivers leaves the gateway at once, as a progress
  notification (`progress` = number of parts so far; a text part travels as
  `message`), while the plugin keeps reading its provider;
- the complete result still closes the exchange, because a client reads the
  result, not the notifications. The content is therefore held in memory
  until the end, exactly as for a result that was not streamed: what is not
  buffered is the **delivery**, not the result;
- a caller that sent no `progressToken` receives the same result as one JSON
  body, when the provider has finished.

### How it is wired

```
plugin.execute(ctx, …)
  ctx.emitPart(part)                 plugin SDK: streamToolResult(ctx, textParts(response.body))
    → PartRelay.emit                 upstream-stage.ts: counts the part; rejects CallerGoneError
                                     once call.signal is aborted
      → CallRequest.onPart(part)     door.ts progressForwarder: mcpReq.notify(notifications/progress)
                                     (absent when the caller sent no progressToken)
  returns the complete McpToolResult → pipeline writes the audit entry → the door answers
```

- **The decision comes first.** `onPart` is called by the upstream stage
  only, the pipeline's last: mission state, resource, risk and the budget
  transaction (decrement, `call-allowed` session event) have completed before
  `plugin.execute` runs. A refused call reaches no plugin and is answered by
  its error alone.
- **One audit entry, at the end of the stream.** The audit is append-only and
  holds one entry per call, written when the forward ends — as for any call.
  For a streamed call that is the end of the stream: `upstream_latency_ms`
  covers the whole stream. Between the first part and that write, the record
  of the decision is the counter and the `call-allowed` session event, both
  committed before the first byte.
- **A stream that breaks midway** (the plugin throws after N ≥ 1 parts): the
  entry stays `decision: allowed` with `upstream_error: '<provider> stream
failed after N parts[, HTTP <status>] (<error class>)'`; the agent receives
  the parts already sent, then `isError` with `Upstream error: the stream was
interrupted after N parts: <the plugin's sentence>`. The credit stays
  consumed (ADR
  [atomic-budget-accounting](../decisions/atomic-budget-accounting.md)).
- **No replay after a first part.** The retry ladder (drop cached
  credentials, refresh) applies only while nothing was emitted: a retry would
  deliver the beginning twice. A 401 raised after a part is a stream failure
  and leaves the connection untouched. Plugins therefore open the provider's
  response before the first `emitPart`.
- **A caller that goes away** (disconnect, MCP `notifications/cancelled`):
  the SDK aborts `mcpReq.signal`, which is `CallRequest.signal`. The relay
  reads it between two parts — a provider call in flight is never interrupted
  — and rejects the next `emitPart` with `CallerGoneError`; `streamToolResult`
  leaves its loop, which cancels the provider's body. The entry records
  `'<provider> stream stopped after N parts: the caller was gone'`. A call
  that does not stream is not affected by a disconnect: it completes and is
  audited as it always was.
- **Telemetry** receives the outcome once, when the stream has ended — a
  stream the provider broke included (`upstream-error`). A stream stopped
  because the caller went away is not reported at all.

### On the wire

| Caller                                               | Answer                                                                                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 2026-07-28, with `progressToken`                     | JSON if the handler finishes without emitting; upgraded to SSE at the first notification (`responseMode: 'auto'`) |
| 2025-era `tools/call` with `progressToken`           | SSE: `asksForProgress(request)` routes it to the SDK's `legacyStatelessFallback` (stateless, same server factory) |
| anything else (no token, `tools/list`, `initialize`) | one JSON body, as before                                                                                          |

On the 2025-era leg a call that carries a `progressToken` is answered in SSE
framing even when it is refused: the stream then holds the error and nothing
else. SSE responses are the SDK's (`Content-Type: text/event-stream`,
`Cache-Control: no-cache`, `X-Accel-Buffering: no`, a comment-frame keep-alive
every 15 s).

### What the process shape allows (measured)

The transport is a Next 16 route handler returning the SDK's web-standard
`Response` from the standalone server (ADR
[docker-image-and-config-format](../decisions/docker-image-and-config-format.md)).
Measured on 2026-10-13 with `tests/manual/streaming-check.ts` ("Manual check:
streaming" below), Next 16.4.0 standalone, Node 22, a stand-in upstream
sending one chunk every 300 ms:

| Path                                                            | Frames arrive                                             |
| --------------------------------------------------------------- | --------------------------------------------------------- |
| standalone `server.js`, direct                                  | one by one, about 300 ms apart                            |
| the same behind `deploy/caddy/Caddyfile` (Caddy 2.11.7, HTTP/2) | one by one, about 300 ms apart                            |
| the same Caddyfile without `flush_interval -1`                  | one by one (Caddy flushes `text/event-stream` on its own) |

Nothing had to change in the process shape, in `next.config.ts`
(`compress: false` was already there) or in the Caddyfile: `encode zstd gzip`
leaves the event stream uncompressed and `flush_interval -1` is kept as an
explicit guarantee. A client disconnect reaches the handler through
`request.signal`, behind the proxy too. Another reverse proxy must be told
not to buffer (`X-Accel-Buffering: no` covers nginx).

### Limits

- No shipped plugin streams yet: `emitPart` is there for the tools whose
  provider answers progressively (log tails, long exports).
- The complete result is held in memory until the end (see above); a tool
  whose output does not fit there needs pagination, not streaming.
- A progress notification carries text parts only (`message`); an image or
  resource part advances `progress` and arrives with the result.
- Progress notifications are not replayed: the door is stateless, there is no
  event store and no `Last-Event-ID` resumption. A caller that loses the
  connection calls again, and that is a new call for the budget.
- The audit entry of a streamed call is written when the stream ends. A
  process that dies mid-stream leaves a counted action without its entry —
  the same window a non-streamed call has while the provider answers, wider
  by the length of the stream; `countersAgreeWithAudit` reports it.

## Discovery and catalog (`tools.ts`)

`callableTools(ctx, registry)`: every tool of each plugin
whose provider the mission both holds a connection for — one that still serves
it, not `lost` — and accepts at least one risk of (`callableProviders`). The
filter is per provider: a listed tool can still be refused `risk-not-accepted`
at call time. The catalog's `connections[]` carries `lost`
(`connection-revoked` | `access-withdrawn`) on a connection the mission lost;
its tools are not `callable`.

`GET /mcp/catalog` (mission token; 405 with `Allow: GET` for another method; 401 / 403 / 429 as `/mcp`; an inactive
mission is 403 `mission-inactive`), `Cache-Control: no-store`:

```jsonc
{
  "mission": {
    "id": "…",
    "name": "…",
    "creator": "ada@acme.example", // who answers its requests; null if unknown
    "state": "active",
    "expires_at": null,
    "period": { "start": "…", "end": "…" },
  },
  // Whose token this request presented: "I am using Xavier's token on mission X".
  "token": { "kind": "member", "holder": "xavier@acme.example", "prefix": "AbCd1234" },
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
      "resources": [
        {
          "ref": "acme/app",
          "env": null,
          "display_name": "acme/app",
          // Only for the provider the instance is the git remote of (spec §4.1 ter).
          "git_remote": "https://gw.acme.example/git/acme/app.git",
        },
      ],
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

`tools` is the whole surface of the instance, every plugin's tools;
`budget` comes from `SessionService.stateOf` for the current period and is the
same for every holder of the mission. `git_remote` is present on the resources
of the one plugin that declares a `gitRemote` (`registry.gitRemote()`), built
by `gitRemoteUrl` from `gitRemoteBase(public_url)` (`server/git/paths.ts`).
`token.kind` is `member` (then `holder`
is the member's email) or `named` (then it is the name the creator gave);
`prefix` is the public part of the token, never more.

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
  approvalValiditySeconds: config.approvals.expirySeconds, // `approval_valid_seconds` of the refusal
});
const execution = createExecutionModule({
  config,
  store,
  registry,
  auth,
  missions,
  connections,
  grounds: authority.grounds, // re-checks the creator's authority on every request
  budget,
  cache,
  rateLimiter,
  logger,
  build,
  delegations: deps.delegatedTokens ?? oauth.verifier, // delegated tokens are refused by kind
  telemetry: telemetry.sink, // community telemetry; inert unless the operator opted in
});
// A discovery scheduled after a creating call finishes before the store closes.
opened.push(() => connections.discoveryAfterCall.stop());
```

`root.budget` and `root.execution` are public members of `GatewayRoot`. The
fixed-window `MemoryRateLimiter` is no longer wired; it remains for tests that
inject a clock.

## Manual check

Done on 2026-10-13 on the standalone build, with a temporary configuration and
SQLite file. `tests/manual/seed-demo.ts` seeds a user, a GitHub connection (a
placeholder token: enough to list tools, not to reach GitHub) and a
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
{"code":-32603,"message":"Vaubaan refused the call: resource-not-in-mission","data":{"code":"resource-not-in-mission","cited_ref":"acme/infra","allowed_resources":[{"ref":"acme/app","env":null,"display_name":"acme/app"}],"hint":"Resource 'acme/infra' is not part of this mission on connection 'acme-org'. The mission may touch: acme/app. A resource this mission creates through the gateway is reached right after its creation. For one created elsewhere, use one of these refs, or ask the mission creator to add the resource: they edit the mission, your key stays the same and your next call reaches it."}}

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
upstream, the token being a placeholder.

What was **not** done: connecting Claude Code itself to the instance, which is
the definition of done of the feature. The check above uses `curl` with the
kit's own command and the official MCP client; a session with Claude Code
against a TLS-terminated instance, with a real connection, remains to be done
by a human ([e2e-tests](../tests/e2e-tests.md)).

## Manual check: streaming

Done on 2026-10-13. `tests/manual/streaming-check.ts serve` builds the real
root on the `:memory:` store with the door tests' fixture provider, whose
`execute` reads a slow chunked response from a local stand-in upstream and
forwards it with `streamToolResult(ctx, textParts(body))`; it publishes the
root where `getRoot()` looks and starts the **standalone** `server.js` in the
same process, so the HTTP server and the route handler are the image's.
`probe` is the agent's side, in another process.

```console
$ npm run build --workspace @vaubaan/gateway-app
$ PORT=39417 HOSTNAME=127.0.0.1 NODE_ENV=production \
    npx tsx apps/gateway/tests/manual/streaming-check.ts serve &
standalone server: …/apps/gateway/.next/standalone/apps/gateway/server.js
stand-in upstream: http://127.0.0.1:37113 (5 chunks, one every 300 ms)
token: vbn_live_JYUfg9Oq_<secret>
▲ Next.js 16.4.0

$ npx tsx apps/gateway/tests/manual/streaming-check.ts probe http://127.0.0.1:39417 "$TOKEN"
1. 2025-era tools/call with a progress token, raw HTTP, http://127.0.0.1:39417
   HTTP 200, text/event-stream, headers after 419 ms, content-encoding: none
   +  420 ms  progress 1 "chunk 1 of 5\n"
   +  707 ms  progress 2 "chunk 2 of 5\n"
   + 1008 ms  progress 3 "chunk 3 of 5\n"
   + 1309 ms  progress 4 "chunk 4 of 5\n"
   + 1610 ms  progress 5 "chunk 5 of 5\n"
   + 1616 ms  result "chunk 1 of 5\nchunk 2 of 5\nchunk 3 of 5\nchunk 4 of 5\nchunk 5 of 5\n"
   => 5 progress frames spread over 1190 ms: not buffered
2. official MCP client (2025-era), onprogress
   +  323 ms  progress 1 "chunk 1 of 5\n"
   …
   + 1519 ms  progress 5 "chunk 5 of 5\n"
   => 5 progress frames spread over 1196 ms: not buffered
2. official MCP client (2026-07-28), onprogress
   +  325 ms  progress 1 "chunk 1 of 5\n"
   …
   + 1519 ms  progress 5 "chunk 5 of 5\n"
   => 5 progress frames spread over 1194 ms: not buffered
3. a stream the upstream cuts after two chunks
   +  312 ms  progress 1 "chunk 1 of 5\n"
   +  616 ms  result (isError) "Upstream error: the stream was interrupted after 1 part: terminated"
4. a refused call (a risk the mission does not accept) with a progress token
   +   10 ms  error "Vaubaan refused the call: risk-not-accepted"
5. no progress token: one JSON body
   HTTP 200, application/json, body after 1509 ms: "chunk 1 of 5\n…chunk 5 of 5\n"
6. the caller disconnects after the first frame
   +  308 ms  progress 1 "chunk 1 of 5\n"
   aborted by the probe (AbortError)

# the serve process, meanwhile
audit: allowed label=streaming-probe upstream_latency_ms=1514 upstream_error=-
audit: allowed label=probe upstream_latency_ms=1507 upstream_error=-
audit: allowed label=probe upstream_latency_ms=1504 upstream_error=-
audit: allowed label=streaming-probe upstream_latency_ms=605 upstream_error=depot stream failed after 1 part (TypeError)
audit: refused (risk-not-accepted) label=streaming-probe upstream_latency_ms=- upstream_error=-
audit: allowed label=streaming-probe upstream_latency_ms=1501 upstream_error=-
upstream: the gateway closed the body after 2 chunks
audit: allowed label=streaming-probe upstream_latency_ms=604 upstream_error=depot stream stopped after 1 part: the caller was gone
```

In step 3 the stand-in upstream destroys its socket right after writing the
second chunk, which the gateway's HTTP client did not deliver: one part
arrived, and the entry says so.

**Through the reference proxy.** The same `serve` process in a container
(the image's Node, the worktree mounted read-only) and the pinned
`caddy:2.11.7-alpine` with `deploy/caddy/Caddyfile` unchanged
(`GATEWAY_DOMAIN=localhost`, Caddy's internal certificate), on one Docker
network; the probe on the host with `NODE_TLS_REJECT_UNAUTHORIZED=0`:

```console
$ … streaming-check.ts probe https://localhost:39443 "$TOKEN"
1. 2025-era tools/call with a progress token, raw HTTP, https://localhost:39443
   HTTP 200, text/event-stream, headers after 437 ms, content-encoding: none
   +  438 ms  progress 1 "chunk 1 of 5\n"
   +  728 ms  progress 2 "chunk 2 of 5\n"
   + 1029 ms  progress 3 "chunk 3 of 5\n"
   + 1331 ms  progress 4 "chunk 4 of 5\n"
   + 1630 ms  progress 5 "chunk 5 of 5\n"
   => 5 progress frames spread over 1192 ms: not buffered
…
6. the caller disconnects after the first frame
audit: allowed label=streaming-probe upstream_latency_ms=604 upstream_error=depot stream stopped after 1 part: the caller was gone
```

Steps 2 to 6 gave the same lines as without the proxy; a second run with
`flush_interval -1` removed from the Caddyfile gave the same timings.

What was **not** done: a streaming call against a real provider (no shipped
plugin streams), and a run behind a proxy other than Caddy.

## Tests

- `src/server/execution/execution.test.ts` (21) — agent label (shape, absent,
  rejected with its reason, carrier and what was dropped), client address
  (hop with a port, brackets, spaces, invalid CIDR), `citedRefs`, tool filter,
  token verifier (nothing remembered: the standing is asked again on every
  call; no throttle for a token stored as a digest; the argon2id check of a
  legacy token throttled per prefix and address), upstream credential cache.
- `tests/integration/execution/discovery-after-call.test.ts` (8) — a
  successful `depot__create_space` schedules one discovery (merged, audited
  `after-a-call` with the member as actor, `metadata.discovery.afterCall`); a
  whole-account mission reaches the new space on its next call; the
  `resource-not-in-mission` hint of a whole-account mission; a refused, failed
  or declined (`isError`) creating call and a non-creating tool schedule
  nothing; a burst coalesces into two discoveries; the answer leaves before the
  discovery starts. The scheduler alone:
  `src/server/connections/discovery-after-call.test.ts` (11).
- `tests/integration/execution/team-door.test.ts` (11) — over HTTP: two
  members and a named token share one counter and are attributed separately in
  the audit, the session and the search; the holder is the token's whatever
  the caller declares; the catalog names the holder and the creator; last
  used; a removed member refused at the next call with a warm cache, and by
  the membership row alone; a deactivated member refused at once, by the user
  row alone, and a new token after reactivation; rotated vs revoked; a revoked
  mission is `mission-inactive` for its holders and tells a removed member
  nothing; a deactivated creator orphans every holder and reactivation
  restores every token.
- `src/server/http/client-ip.test.ts` (11) — the client-address rule and
  `isTrustedProxyEntry`.
- `tests/integration/execution/pipeline.test.ts` (24) — allowed call
  (decrement, audit entry, credential to the plugin only, env-qualified risk,
  agent label), each refusal with its fields (among them `mission-inactive`
  for a mission orphaned by a revoked connection), stale / hidden /
  never-hydrated resources, structural rejections, a classifier that throws
  (refused `-32602` naming the risk stage and the error class, one audit
  entry, nothing counted, one `error` log line, and the text of the error in
  none of the three), upstream failure (the
  host-built summary in the audit, the detail to the agent, the HTTP status
  of a client error), 401 → refresh → retry, rejected refresh → `expired`,
  403, credential cache.
- `tests/integration/execution/door-http.test.ts` (23) — the official MCP
  client in both eras against the real GitHub plugin on a mocked upstream,
  refusal `data` as the client sees it, plain JSON for `curl`, 405, tool filter,
  catalog, the 401 cases, session and delegated token refused, foreign origin,
  token verification (the stored digest, a revocation seen on the next call,
  wrong secrets answered 401 and never 429; a token an earlier build stored as
  argon2id still authenticates and is moved to its digest by its first call,
  its argon2id check throttled per prefix and address, the accepted risk
  stated for such a token with no trusted proxy), surface rate limit, a call whose arguments carry `1e999`
  rejected `-32602` with the argument's path, nothing sent upstream and an
  audit entry without refusal code, logs.
- `tests/integration/execution/agent-label.test.ts` (6) — two labels and no
  label share one counter; the same decision with any label, none, or one
  that claims an identity; a value that is not a label dropped, logged
  without its value, the call served; `_meta.agent` over the header and the
  fallback; the official MCP client in both eras.
- `tests/integration/execution/approval-door.test.ts` (8) — the GitHub
  `developer` preset as shipped: the workflow write is the gated risk;
  refusal → grant → the identical replay passes → a second identical replay
  is refused; one byte changed asks again and leaves the other approval
  intact; a write outside `.github/workflows` never meets the gate; the gate
  opened for the period, still counted; the gate set to `auto` on the
  mission; the arguments in the sealed request only, not in the audit, the
  events or the logs.
- `tests/integration/execution/streaming.test.ts` (13) — a part delivered
  while the plugin is still blocked, with the credit already counted and no
  audit entry yet; the official MCP client in both eras (`onprogress`, then
  the complete result); a provider body forwarded chunk by chunk; one JSON
  body without a progress token; a refused call answered by its error alone;
  a stream that breaks midway (entry, latency, credit, no replay); no retry
  after a part even on a 401, retry before; the caller going away. With
  telemetry on: no report for a call its caller abandoned (a stream stopped,
  or a plugin failing after the abort) while the audit entry is written; one
  `upstream-error` report when the provider breaks the stream of a caller
  that stayed.
- `packages/plugin-sdk/tests/unit/streaming.test.ts` (9) — `appendPart`,
  `streamToolResult` (order, failure, the sink rejecting), `textParts`
  (UTF-8 across chunks, early exit cancels the body, a body that errors).
- `tests/integration/execution/counters-vs-audit.test.ts` (4) — 240 random
  calls per seed (three seeds) through the door, then
  `countersAgreeWithAudit` with no mismatch; a concurrent burst on a small
  quota.
- `packages/gateway-core/tests/unit/pipeline.test.ts` (38) — `UpstreamRefusalError`,
  `UpstreamFailureError` (summary to the audit, detail to the outcome, the
  bound), the structural rejection of the resource stage, an argument JSON
  cannot carry rejected before any stage, the audit copy of a classifier's
  denial (argument values replaced in one pass, as text, bounded), a stage
  that throws before the decision (the classifier, the resource stage, the
  budget stage: audited, nothing forwarded, no message kept; a thrown value
  that is not an error; an observer that throws; the audit write of that
  refusal failing still propagates).

Scenarios in [integration-tests](../tests/integration-tests.md).

## How to debug

- **401 with a token that was just issued** — read `error.data.reason`: it is
  set when the secret is right and the token stopped (`token-rotated`,
  `token-revoked`, `holder-removed`, `holder-deactivated`; the instance log has
  `retired mission token presented at the execution surface` with the prefix).
  Without a reason the bearer is truncated or belongs to another instance. 401 and no
  `Authorization` header reaching the instance at all: the TLS terminator
  strips it, or the client probed `/.well-known/oauth-protected-resource` and
  got something else than the 200 above.
- **403 `wrong-credential-kind`** — a browser session cookie rides along (same
  origin as the interface) and no `Authorization` header was sent.
- **403 on every request from a browser-based MCP client** — it sends an
  `Origin`; the door answers no CORS.
- **429** — `Retry-After` says when. `-32002`: the mission's surface limit
  (`mcp.rate_limit_per_minute`) or, for a token issued by a build that stored
  argon2id hashes and not used since, the verification throttle of its prefix
  and client address: someone is replaying wrong secrets on that prefix from
  the same resolved address — or `trusted_proxies` is empty and all callers
  share the `unknown` window (the boot log has `trusted_proxies is empty: …`
  at `warn`). Declare the proxies, or let the agent call once: its first
  successful call moves the token to its digest and out of the throttle.
- **`Vaubaan rejected the call: …`** (`-32602`) — no refusal code: the tool is
  unknown, its provider has no connection in the mission, or the classifier
  could not place the arguments. The sentence is the classifier's. The audit
  row has `refusal_code` null and the sentence in `refusal_reason`, with
  `[argument]` where it quoted a value of the call.
  `argument '<path>' is Infinity: arguments must be JSON values` is the
  pipeline's own: the client sent a number JSON has no text for (`1e999`).
  `Vaubaan could not decide this call: the <stage> stage failed (<class>)`
  is a fault of the instance, not of the call: the log has `call refused: a
decision stage failed` at `error` with the stage, the tool, the error
  class and the stack frames.
- **`resource-not-in-mission` for a resource the mission selected** — it went
  stale: the last discovery no longer returned it (the account's page,
  "Refresh").
- **A tool is listed, then refused `risk-not-accepted`** — expected: the list
  is per provider.
- **`connection-unavailable` right after a call that used to work** — the
  provider answered 401 and the refresh was rejected; the audit row of that
  call is `allowed` with `upstream_error` starting with
  `connection-unavailable:`, and the log has `credential refresh rejected`
  (component `connections`).
- **`Upstream error: … 403`** — the provider refused the action; the
  connection is untouched. The agent's tool result has the provider's
  sentence; the audit row has only the provider id, the status and the error
  class, so the detail is read on the agent's side.
- **A plugin is called with a stale cached credential** — entries are dropped
  on a 401 and when the connection turns unavailable;
  `root.execution.credentialCache.drop(id)` empties a connection's entries by
  hand (no shipped plugin caches today).
- **A call is not attributed to the label the agent set** — the value was
  dropped: look for `agent label dropped` with the mission id; `reason` says
  why (a space, a character outside `. _ - : / @ +`, more than 64
  characters, a non-string `_meta.agent`). A call with both carriers is
  attributed to `_meta.agent`.
- **Progress never arrives, only the result** — the caller sent no
  `_meta.progressToken` (the official client adds one when `onprogress` is
  passed), the tool's plugin does not call `emitPart`, or a proxy in front
  buffers: run `tests/manual/streaming-check.ts probe` against the proxy's
  address, it exits non-zero when the frames arrive together.
- **`upstream_error: … stream failed after N parts`** — the provider's stream
  broke after the agent had received N parts; nothing was replayed.
  `… stream stopped after N parts: the caller was gone` is the agent's side
  closing the connection or cancelling the request.
- **Counters and audit disagree** — run `countersAgreeWithAudit` (budget) on
  the store; the entry of an allowed call carries `remaining_budget`.

## Extension

- **A new stage or check** — gateway-core's `CallPipeline` owns the order; the
  door only provides implementations.
- **A plugin that derives a per-call credential** — read
  `ctx.credentialCache` in `execute` (absent in discovery), choose a key inside
  the connection, never cache a credential that is a tool's result.
- **A plugin whose provider streams** — open the provider's response first
  (so a 401 is still retried), then `return streamToolResult(ctx,
textParts(response.body))`, or call `ctx.emitPart` yourself and await it.
  Nothing else changes: the tool still returns its whole result
  ([plugin-sdk](plugin-sdk.md), "Streamed results").
- **The management door** — it reads no agent label and streams nothing;
  both belong to this door. `ExecutionModule.tokens` (the `TokenVerifier`) is
  what its admission gate identifies a mission token with, to refuse it by
  kind in turn ([management-door](management-door.md)).
- **A hosted deployment** — a shared `CacheClient` for the verified tokens is
  safe (it holds token ids). Upstream credentials must stay per replica or go
  to a cache that encrypts its values.

## References

- Spec [vaubaan-gateway](../spec/vaubaan-gateway.md) §0, §2.4, §3.1, §3.2,
  §3.3, §4.1, §6, §7.5, §7.9, §8, §10, §11.2 ("Agent label").
- ADRs
  [docker-image-and-config-format](../decisions/docker-image-and-config-format.md),
  [upstream-credential-cache-and-rejected-credentials](../decisions/upstream-credential-cache-and-rejected-credentials.md),
  [atomic-budget-accounting](../decisions/atomic-budget-accounting.md),
  [api-key-format-vbn-live-argon2id](../decisions/api-key-format-vbn-live-argon2id.md)
  (the format),
  [mission-token-sha256-digest](../decisions/mission-token-sha256-digest.md)
  (what is stored),
  [execution-door-json-faithful-arguments-and-shared-throttle](../decisions/execution-door-json-faithful-arguments-and-shared-throttle.md),
  [scope-caps-not-enforced-in-v5-0](../decisions/scope-caps-not-enforced-in-v5-0.md),
  [decision-stages-fail-closed-and-audited](../decisions/decision-stages-fail-closed-and-audited.md),
  [plugin-arguments-closed-surface-and-typed-refusals](../decisions/plugin-arguments-closed-surface-and-typed-refusals.md),
  [plugin-contract-and-credential-spec](../decisions/plugin-contract-and-credential-spec.md)
  (amendment "Streamed results"); the agent label is in
  [atomic-budget-accounting](../decisions/atomic-budget-accounting.md)
  (amendment "The agent label is checked, not repaired").
- Neighbours: [gateway-core](gateway-core.md),
  [budget-and-sessions](budget-and-sessions.md), [connections](connections.md),
  [missions](missions.md), [configuration](configuration.md),
  [plugin-sdk](plugin-sdk.md).

## Explicit permission requests

The host adds `vaubaan__request_permission` to `tools/list` and `/mcp/catalog`,
under provider `vaubaan`. It passes the same mission admission, active-state
and surface-rate checks; it is not dispatched to a provider or charged as a
provider call. `permission-request.ts` accepts a refusal reference and a reason,
then returns the request URL, state and expiry. It grants no authority.

The pipeline's optional `permissionRefusal` hook persists references when the
risk stage refuses a nonempty set of missing risks. Both the MCP and git
pipelines receive it. Its failure fails the call closed. The refusal hint
names the tool and includes the reference so git output is usable too. The
bootstrap kit explains that the agent asks only when its assigned task needs
the refused permission. [Request lifecycle](requests.md#permission-requests).
