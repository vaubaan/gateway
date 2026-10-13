---
title: Gateway core
status: current
date: 2026-10-13
tracks:
  - packages/gateway-core/src/
  - packages/gateway-core/tests/unit/
  - packages/gateway-core/package.json
  - packages/shared/src/domain.ts
  - packages/shared/src/refusal.ts
  - packages/shared/src/risk.ts
---

# Gateway core — `@vaubaan/gateway-core`

The v5 decision core: typed refusals, the audit entry shape, the mission
context, and the skeleton of the call pipeline with the hook points the
later features fill. No transport, no store, no provider lives here: the
door (feature P1.6) calls it, the embedded store (P0.3) implements its
`AuditWriter`, the plugins (P1.2) implement its classifier and upstream
stages.

Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §4.1 (structured
refusals), §6 (three credentials), §8 (audit);
[gateway-risk-model](../spec/gateway-risk-model.md) §8 (strict-fail
decision), §12 (audit shape of the risk fields). Replaces the legacy v4
handbook [mcp-gateway](./mcp-gateway.md).

## Layout

```
packages/gateway-core/
  src/
    types.ts         re-exports the shared vocabulary (RefusalCode, statuses, Budget, Period,
                     MissionPolicyEntry ...) and adds Door, BearerKind, MissionContext and
                     its projections (MissionConnection, MissionResource, MissionSummary)
    errors.ts        Refusal union, `refuse.*` builders, JSON-RPC mapping, AuthError
    audit.ts         CallAuditEntry / AdminAuditEntry, AuditWriter, hashArguments, MemoryAuditWriter
    cache.ts         CacheClient interface, bounded MemoryCacheClient (single-process only)
    risk-gateway.ts  decision core: evaluateCallForToken (classify → intersect → allow/deny)
    pipeline.ts      door check, DoorAuthenticator, CallPipeline and its stage interfaces
    index.ts         barrel
  tests/unit/        errors, audit, cache, authenticate, pipeline, risk-gateway
```

Dependencies: `@vaubaan/shared` (the domain types, `RiskId`, `Slice`,
JSON-RPC primitives), `@vaubaan/policy-engine` (`evaluateCall`,
`resourceEnvResolver`, `IndexedRiskCatalog`) and `@vaubaan/plugin-sdk`
(the `classify` half of `ProviderPlugin`, `ClassifyOutcome`). Nothing
else: the v4 Supabase and Upstash dependencies are gone, along with the
Redis cache client, the environment-reading cache factory and the
project-scoped `venv` secret store.

## One source of truth: `@vaubaan/shared`

The domain types are defined once, in `@vaubaan/shared` (`domain.ts`,
`refusal.ts`, `risk.ts`; ADR
[plugin-contract-and-credential-spec](../decisions/plugin-contract-and-credential-spec.md)
D8). `types.ts` re-exports what the pipeline consumes so the door keeps a
single import, and defines only what is specific to the core:

| Re-exported from `@vaubaan/shared`                                              | Defined here                                                                                    |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `REFUSAL_CODES`, `RefusalCode`, `isRefusalCode`                                 | `Door` — `execution` \| `management`                                                            |
| `ConnectionStatus`, `MissionStatus`                                             | `BearerKind` — `mission-token` \| `delegated-token` \| `human-session` (spec §6)                |
| `Gate`, `GATES`, `Budget`, `RateLimit`, `Period`                                | `ConnectionOwner` — shared `Principal` plus the `display` a refusal shows (email or group name) |
| `Principal`, `MissionPolicyEntry`, `MissionPolicy`, `acceptedRisksOf`           | `MissionConnection`, `MissionResource`, `MissionSummary`, `SessionHandle`, `MissionContext`     |
| `ConnectionResource`, `AuditDecision` (`allowed` \| `refused`, from `audit.ts`) | `DelegationContext` (the door-check part of a delegated token; P2.3 owns the rest)              |

Two names deserve a word. **`BearerKind`** is the kind of bearer a door
receives; it is not `CredentialKind` from `@vaubaan/shared`, which is how a
_connection_ authenticates to its provider (`api-key`, `oauth2`,
`app-install`, `ssh-key`) and belongs to the plugin contract. The refusal
code stays `wrong-credential-kind`, the spec's name. **`AuditDecision`**
says `allowed` or `refused` (spec §8 "one entry per call, allowed or
refused"); the v4 rows said `denied`, which only `AuditLogRow` in
`legacy-v4.ts` still carries.

## Refusals (`errors.ts`)

A refusal is **data returned by the pipeline**, not an exception. Eight
codes, one builder each under `refuse.*`, every refusal carrying its
`code`, the fields the spec lists, and an agent-readable `hint`:

| Code                      | Fields                                                                     | Hint says                                                  |
| ------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `risk-not-accepted`       | `missing_risks`, `executed_slices`                                         | which risks the mission lacks; ask the creator to re-issue |
| `budget-exhausted`        | `risk_id`, `quota`, `consumed`, `period_end` (null = one-off), `claim_url` | hand the claim URL to the human, do not loop               |
| `approval-required`       | `risk_id`, `fingerprint`, `approval_url`, `expires_at`                     | nothing executed; replay identically once approved         |
| `resource-not-in-mission` | `cited_ref`, `connection {id,name}`, `allowed_resources[]`                 | which refs the mission may touch                           |
| `rate-limited`            | `risk_id`, `limit {max, window_seconds}`, `retry_after_seconds`            | wait N seconds; quota not consumed                         |
| `connection-unavailable`  | `connection {id,name}`, `status`, `owner {kind, display}`                  | who can reconnect                                          |
| `mission-inactive`        | `status` (expired/orphaned/revoked), `reason`                              | stop calling, report to the human                          |
| `wrong-credential-kind`   | `door`, `presented`, `expected` (`BearerKind`)                             | credentials never cross over                               |

`isRefusal(value)` is the type guard (`isRefusalCode(code)` and a non-empty
hint). The unit test asserts exactly eight codes in `REFUSAL_CODES` and one
sample per code.

**JSON-RPC mapping** — unchanged since v4: `refusalToRpcError(id, refusal)`
yields `{ code: -32603, message: 'Vaubaan refused the call: <code>', data: <refusal> }`.
`REFUSAL_RPC_CODE` exports the constant. The whole refusal, hint
included, travels in `data`; the door must forward `data` to the MCP
client (the v4 `/mcp` route only forwarded `message`, which lost the
fields — a point for P1.6).

**Not refusals** — `AuthError` (`-32001`, HTTP 401) for a missing,
malformed, unknown or revoked bearer: nothing was identified, so there is
no credential to refuse. `GatewayError` is its base.

## Audit (`audit.ts`)

`AuditEntry = CallAuditEntry | AdminAuditEntry`, discriminated by `kind`.

**Call entry** (one per `tools/call`, allowed or refused): `ts`,
`mission_id`, `session_id`, `connection_id`, `resource_ref`, `tool`,
`arguments_hash`, `slices_executed` (structured `Slice[]`, as in v4),
`risks_touched`, `accepted_risks_snapshot`, `decision` (`AuditDecision`:
`allowed` | `refused`), `refusal_code`, `refusal_reason`, `approval_id`,
`remaining_budget` (per touched risk, after the decrement), `agent_label`,
`upstream_latency_ms`, `upstream_error`, `client_ip`,
`client_user_agent`.

Two conventions:

- `decision` is what the gateway decided. An allowed call whose provider
  then failed stays `allowed` with `upstream_error` set (v4 recorded it as
  `denied` with an `upstream-error:` prefix). An operator query for
  "actions with no business effect" is `decision = 'allowed' AND
upstream_error IS NOT NULL`.
- A structural rejection without a code (unknown tool, classifier denial,
  catalog not loaded) is `decision = 'refused'`, `refusal_code = null`,
  `refusal_reason = <text>`.

**Administrative entry**: `ts`, `user_id`, `act` (`AdminAct` union:
connection created/reconnected/transferred/revoked, share created/revoked,
mission issued/rotated/revoked/closed, budget extended, period reset,
expiry extended, gate opened, approval granted, request refused,
delegation granted/revoked, config changed), `object {type, id}`,
`before`, `after`, `delegated_client_id` (set when the act came through
the management door).

**`AuditWriter { write(entry: AuditEntry): Promise<void> }`** is the
contract with the store's SQLite writer (`SqliteAuditWriter`, P0.3). Name
and signature are stable. A writer must not swallow failures: the pipeline
lets a rejected `write` propagate, so no call completes without its entry
(v4 logged and continued).

**`hashArguments(args)`** is unchanged: `sha256(JSON.stringify(args ??
{}))` truncated to 16 hex characters. It is not canonical (key order
matters); the canonical fingerprint that binds approvals is P1.3's.

`MemoryAuditWriter` keeps entries in memory for tests (`.calls`, `.admin`).

## Mission context (`types.ts`)

`MissionContext` is what the door loads once per call and the pipeline
reads. Every member is a projection of a shared record, so the store (P0.3)
maps its rows to it without translation:

- `mission` — `MissionSummary = Pick<Mission, 'id' | 'name' | 'status' |
'creator_id' | 'expires_at' | 'period'>`. `status` is `active` |
  `expired` | `orphaned` | `revoked`; `expires_at` is nullable; `period` is
  the shared union `{ kind: 'one-off' }` |
  `{ kind: 'recurring', length_seconds, anchor_at }`.
- `token` — id and prefix (only the prefix is ever logged).
- `connections[]` — `MissionConnection = Pick<Connection, 'id' | 'provider' |
'display_name' | 'status'>` plus `owner: ConnectionOwner` (`Principal` with
  `display`). Never a credential.
- `resources[]` — `MissionResource = ConnectionResource` (`id`,
  `connection_id`, `provider`, `ref`, `env?`, `displayName`,
  `discovered_at`, `metadata?`): the selection, all connections together.
  It feeds `resourceEnvResolver` and the plugin's `classify` as-is.
- `policy` — `MissionPolicy = readonly MissionPolicyEntry[]`, each entry
  `{ risk_id, quota, rate_limit: { max, window_seconds }, gate }`. The
  `risk_id`s **are** the accepted risks; `acceptedRisksOf(ctx)` derives
  them. There is no separate `accepted_risks` field, so the two cannot
  diverge. Always an explicit enumeration; `risk_id` unique within the list
  (the store enforces it at write time).
- `session` — `SessionHandle = Pick<Session, 'id' | 'started_at'>` or `null`
  before the first call.

`DelegationContext` carries what the door check needs for a delegated
token; its full shape is P2.3's.

## Pipeline (`pipeline.ts`)

### Doors and bearers

`EXPECTED_CREDENTIAL_BY_DOOR: Record<Door, BearerKind> = { execution:
'mission-token', management: 'delegated-token' }`. A human session opens no
door.

- `parseBearer(header)` strips the scheme; missing or malformed →
  `AuthError`.
- `CredentialResolver.resolve(bearer)` is the hook the door implements
  over the store (prefix lookup, slow-hash verify, context load, cache).
  It returns a `ResolvedCredential` (`mission-token` + `MissionContext`,
  `delegated-token` + `DelegationContext`, or `human-session`) or `null`.
- `checkDoor(kind, door)` is the pure door check: a mismatch is a
  `wrong-credential-kind` refusal naming door, presented and expected.
- `DoorAuthenticator.authenticate(header, door)` composes the three:
  unknown bearer → `AuthError`; wrong kind → refusal; otherwise the
  credential. `authenticateMission(header)` is the execution-door
  shortcut returning `MissionContext | Refusal`.

### Order of a call

```
checkMissionActive(ctx, now)        mission-inactive         (pure, this module)
resources.resolve(ctx, call)        resource-not-in-mission  (ResourceStage — authority feature)
checkConnectionAvailable(target)    connection-unavailable   (pure, this module)
risks.evaluate(ctx, call, target)   risk-not-accepted        (RiskStage over evaluateCallForToken)
budget.decide(ctx, call, risks)     budget-exhausted | rate-limited | approval-required  (BudgetStage — P1.3)
upstream.execute(ctx, call, target) mint + forward           (UpstreamStage — P1.2 plugins, P1.6 door)
audit.write(entry)                  always, exactly once     (AuditWriter — P0.3)
```

`CallPipeline.execute(ctx, call)` returns a `CallOutcome`:

- `allowed` — provider result + audit entry;
- `refused` — a typed `Refusal` + audit entry (`refusal_code` set,
  `refusal_reason` = the hint);
- `rejected` — structural, no code (classifier denial, catalog missing);
  fail closed;
- `failed` — allowed, then the provider threw (`decision: 'allowed'`,
  `upstream_error` set).

Invariants the tests pin: the resource check runs before any risk is
evaluated; a refusal at any stage never reaches the budget or the
upstream; the `risk-not-accepted` refusal is produced by the unchanged
decision core (`risks_touched ⊆ accepted_risks`); every path writes
exactly one audit entry; an audit write failure propagates.

`CallRequest` carries `tool`, `args`, the optional `agent_label` and the
`client` origin (ip, user agent). `CallTarget` is the resolved
`{ connection, resource | null }`.

### Stage contracts (hook points)

| Interface       | Filled by                | Contract                                                                                                                                    |
| --------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `ResourceStage` | authority feature (P1.x) | `resolve(ctx, call)` → target, or `resource-not-in-mission` refusal                                                                         |
| `RiskStage`     | P1.2 plugin wiring       | `evaluate(ctx, call, target)` → `CallVerdict` (default: `evaluateCallForToken` + the plugin's `classify`)                                   |
| `BudgetStage`   | P1.3                     | `decide(ctx, call, {risks_touched, now})` → allowed `{session_id, remaining, approval_id}` or refusal; atomic; a refusal decrements nothing |
| `UpstreamStage` | P1.2 / P1.6              | `execute(ctx, call, target)` → provider result; the executor never sees the credential                                                      |
| `AuditWriter`   | P0.3                     | `write(entry)`; failures propagate                                                                                                          |

## Decision core (`risk-gateway.ts`)

`evaluateCallForToken({ tool, args, resources, token, adapter, catalog,
envResolver? })` classifies through the plugin, intersects with the
`IndexedRiskCatalog` (`evaluateCall` of the policy engine) and returns a
`CallVerdict`: `allow` (risks touched, slices), `deny` (`code`, missing
risks, slices, hint), `classify-denied` (plugin reason), `no-catalog` (fail
closed). The decision itself is unchanged by the pivot; its inputs are v5:

- `adapter: Classifier = Pick<ProviderPlugin, 'classify'>` — a registered
  plugin satisfies it as-is; tests pass a stub. `classify(tool, args,
resources)` returns the SDK's `ClassifyOutcome` (`{ slices }` or
  `{ denied }`), re-exported here.
- `resources: Resource[]` — the mission's resources on the target
  connection, handed to the classifier and, by default, to
  `resourceEnvResolver(resources)` so a mission that accepted
  `supabase[staging].bulk-row-write` matches an executed
  `supabase.bulk-row-write` on the staging resource. A host may pass its
  own `envResolver` (a plugin deriving the environment from a branch).
- `token: AcceptedRisksSnapshot` — `{ id, accepted_risks, denied_risks }`;
  v5 missions carry no explicit denies, pass `[]`.

The policy engine's `RiskDecision` (denied) carries `code: RefusalCode`;
the verdict forwards it and the pipeline's refusal is built with that
code. `denyResponseBody` formats the v4 body (`error: <code>`, missing
risks, slices, hint); the pipeline uses `refuse.riskNotAccepted` instead.
The v4 `ProviderBinding` input and the `V4*` aliases are gone; the legacy
app (`apps/gateway/src/lib/gateway/legacy-v4-gateway.ts`) maps its
bindings to resources with the quarantined `resourceFromBinding` until
P1.6 deletes it.

## Cache (`cache.ts`)

`CacheClient { get, set(key, value, ttlSeconds), del }` is the interface
the door uses to keep a verified mission context for a few seconds.
`MemoryCacheClient` is bounded (`maxEntries`, default 10 000; the oldest
entry is evicted after a sweep of expired ones; re-setting a key makes it
the newest) and takes an injectable clock.

`// single-process only` — a multi-replica deployment swaps in a shared
implementation of `CacheClient`; nothing else changes. The v4
`RedisCacheClient` (Upstash) and `buildCacheClient(env)` are deleted (ADR
pivot D1; the Upstash ADR is superseded).

## What left the package

- `gateway.ts` — the v4 `McpGateway` orchestrator (org/project context,
  bindings, single-use tokens, venv tools). It is **not** v5 and could not
  become v5 without the store, but the v4 application still compiles
  against it until P1.6 replaces `/mcp`. It now lives next to its only
  consumer as `apps/gateway/src/lib/gateway/legacy-v4-gateway.ts`, venv
  tools removed, with its own `LegacyAuditRow` / `LegacyAuditWriter`;
  its four tests moved to
  `apps/gateway/tests/unit/lib/gateway/legacy-v4-gateway.test.ts`. Both
  files are deleted with the rest of the v4 app code.
- `venv-store.ts` — project-scoped secret transfer; no v5 counterpart
  (plan §8-Q5). The Vercel and Supabase adapters keep their own
  structural `VenvStoreReader` until P1.2 migrates them.
- `SupabaseAuditWriter`, `RedisCacheClient`, `buildCacheClient`, and the
  `@supabase/supabase-js`, `@upstash/redis`, `@vaubaan/plugin-github`
  dependencies (declared, never imported).
- The local twins of the shared domain types (`RefusalCode`,
  `CredentialKind`, `Principal`, `Period`, `Budget`, the `Record`-shaped
  `MissionPolicy`) and the v4 `ProviderBinding` / `classifyV4` inputs of
  the decision core — reconciled at the end of the P0 wave (P0.R).

## Tests

`packages/gateway-core/tests/unit/`, vitest, no network, no store:

- `errors.test.ts` (24) — eight codes, one sample each, every field, hint
  non-empty and serializable; `isRefusal`; `refusalToRpcError` (-32603,
  data = refusal).
- `audit.test.ts` (6) — `hashArguments` sha256/16 with a known vector,
  determinism; `MemoryAuditWriter` over both kinds; the call entry carries
  every §8 field.
- `cache.test.ts` (6) — TTL, delete, bound eviction order, refresh on
  re-set, sweep before eviction, invalid bound.
- `authenticate.test.ts` (11) — door table, pure `checkDoor` on every
  mismatch, `parseBearer`, `DoorAuthenticator` for mission token vs
  delegated token vs session at each door, unknown bearer → `AuthError`.
- `pipeline.test.ts` (15) — `checkMissionActive` (status, passed and
  future `expires_at`), `checkConnectionAvailable`, then the pipeline over
  a shared-shaped context (`ConnectionResource`, policy entries, one-off
  period): happy path with the full audit entry, inactive mission
  short-circuit, resource refusal before risk, expired connection,
  `risk-not-accepted` through the real decision core and the resources of
  the target connection, structural rejections, budget refusal without
  upstream, approval id carried, upstream failure after allow, audit
  failure propagating.
- `risk-gateway.test.ts` (8) — the decision core: allow, deny with
  `code: 'risk-not-accepted'`, classifier denial, missing catalog,
  explicit denies, the classifier receives `(tool, args, resources)`,
  environment qualification from the resources by default and an explicit
  `envResolver` overriding it, `denyResponseBody`.

## References

- ADR [pivot-v4-to-v5-on-prem-mission-tokens](../decisions/pivot-v4-to-v5-on-prem-mission-tokens.md)
  D1 (in-memory cache, single process), D4 (budget, claim), amendments
  (approval gate, management door, English);
  [plugin-contract-and-credential-spec](../decisions/plugin-contract-and-credential-spec.md)
  D1 (`classify`), D3 (`Resource`, `EnvResolver`), D8 (`shared` reset).
- Spec [vaubaan-gateway](../spec/vaubaan-gateway.md) §3.1–3.5, §4.1,
  §6, §8, §10; [gateway-risk-model](../spec/gateway-risk-model.md) §8,
  §12.
- Neighbouring handbooks: [policy-engine](./policy-engine.md) (the pure
  engine this core calls), [plugin-sdk](./plugin-sdk.md) (the shared
  vocabulary and the plugin contract), [store](./store.md) (the
  `AuditWriter` implementation), [mcp-gateway](./mcp-gateway.md) (legacy
  v4 orchestration, historical).
