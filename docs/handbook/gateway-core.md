---
title: Gateway core
status: current
date: 2026-10-13
tracks:
  - packages/gateway-core/src/
  - packages/gateway-core/tests/unit/
  - packages/gateway-core/package.json
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
    types.ts         v5 domain types the core needs (RefusalCode, Door, CredentialKind,
                     MissionContext, MissionPolicy, MissionResource, MissionConnection ...)
    errors.ts        Refusal union, `refuse.*` builders, JSON-RPC mapping, AuthError
    audit.ts         CallAuditEntry / AdminAuditEntry, AuditWriter, hashArguments, MemoryAuditWriter
    cache.ts         CacheClient interface, bounded MemoryCacheClient (single-process only)
    risk-gateway.ts  decision core: evaluateCallForToken (classify → intersect → allow/deny)
    pipeline.ts      door check, DoorAuthenticator, CallPipeline and its stage interfaces
    index.ts         barrel
  tests/unit/        errors, audit, cache, authenticate, pipeline, risk-gateway
```

Dependencies: `@vaubaan/shared` (RiskId, Slice, JSON-RPC primitives) and
`@vaubaan/policy-engine` (`evaluateCall`, `IndexedRiskCatalog`). Nothing
else: the v4 Supabase and Upstash dependencies are gone, along with the
Redis cache client, the environment-reading cache factory and the
project-scoped `venv` secret store.

> **Merge note (P0 phase).** `types.ts` defines `RefusalCode` and the
> mission/session types locally, marked `TODO(P0 merge)`, because feature
> P0.2 adds the same names to `@vaubaan/shared` in parallel. After the P0
> merge, `types.ts` re-exports the shared definitions. Likewise
> `risk-gateway.ts` still takes v4 `ProviderBinding[]` for environment
> qualification until the policy engine takes `Resource` + `EnvResolver`.

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
| `wrong-credential-kind`   | `door`, `presented`, `expected`                                            | credentials never cross over                               |

`isRefusal(value)` is the type guard (known code + non-empty hint).
`REFUSAL_CODES` is the canonical list; the unit test asserts exactly eight
and one sample per code.

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
`risks_touched`, `accepted_risks_snapshot`, `decision` (`allowed` |
`refused`), `refusal_code`, `refusal_reason`, `approval_id`,
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
contract with the store's SQLite writer (P0.3). Name and signature are
stable. A writer must not swallow failures: the pipeline lets a rejected
`write` propagate, so no call completes without its entry (v4 logged and
continued).

**`hashArguments(args)`** is unchanged: `sha256(JSON.stringify(args ??
{}))` truncated to 16 hex characters. It is not canonical (key order
matters); the canonical fingerprint that binds approvals is P1.3's.

`MemoryAuditWriter` keeps entries in memory for tests (`.calls`, `.admin`).

## Mission context (`types.ts`)

`MissionContext` is what the door loads once per call and the pipeline
reads:

- `mission` — id, name, status (`active` | `expired` | `orphaned` |
  `revoked`), `creator_id`, `expires_at` (nullable), `period` (nullable:
  anchor + length).
- `token` — id and prefix (only the prefix is ever logged).
- `connections[]` — id, provider, name, status (`active` | `expired` |
  `revoked` | `unowned`), owner `Principal`. Never a credential.
- `resources[]` — the selection per connection: `connection_id`,
  `provider`, `ref`, `env`, `display_name`. Replaces the v4
  `ProviderBinding`.
- `policy` — `Record<RiskId, { budget: { quota, rate_limit: { max,
window_seconds } }, gate: 'auto' | 'approval' }>`. The keys **are** the
  accepted risks; `acceptedRisksOf(policy)` derives them. There is no
  separate `accepted_risks` field, so the two cannot diverge. Always an
  explicit enumeration.
- `session` — handle `{ id, started_at }` or `null` before the first call.

`DelegationContext` carries what the door check needs for a delegated
token; its full shape is P2.3's.

## Pipeline (`pipeline.ts`)

### Doors and credentials

`EXPECTED_CREDENTIAL_BY_DOOR = { execution: 'mission-token', management:
'delegated-token' }`. A human session opens no door.

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
| `RiskStage`     | P1.2 plugin wiring       | `evaluate(ctx, call, target)` → `CallVerdict` (default: `evaluateCallForToken` + plugin classifier)                                         |
| `BudgetStage`   | P1.3                     | `decide(ctx, call, {risks_touched, now})` → allowed `{session_id, remaining, approval_id}` or refusal; atomic; a refusal decrements nothing |
| `UpstreamStage` | P1.2 / P1.6              | `execute(ctx, call, target)` → provider result; the executor never sees the credential                                                      |
| `AuditWriter`   | P0.3                     | `write(entry)`; failures propagate                                                                                                          |

## Decision core (`risk-gateway.ts`)

Unchanged by the pivot. `evaluateCallForToken({ tool, args, bindings,
token, adapter, catalog })` classifies through the plugin
(`Classifier.classifyV4`), intersects with the `IndexedRiskCatalog`
(`evaluateCall` of the policy engine) and returns a `CallVerdict`:
`allow` (risks touched, slices), `deny` (missing risks, slices, hint),
`classify-denied` (plugin reason), `no-catalog` (fail closed). The v4
type names `V4TokenSnapshot`, `V4ClassifyOutcome`, `V4ClassifierAdapter`
remain as deprecated aliases of `AcceptedRisksSnapshot`,
`ClassifyOutcome`, `Classifier`. `denyResponseBody` formats the v4 body;
the pipeline uses `refuse.riskNotAccepted` instead.

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
  future `expires_at`), `checkConnectionAvailable`, then the pipeline:
  happy path with the full audit entry, inactive mission short-circuit,
  resource refusal before risk, expired connection, `risk-not-accepted`
  through the real decision core, structural rejections, budget refusal
  without upstream, approval id carried, upstream failure after allow,
  audit failure propagating.
- `risk-gateway.test.ts` (6) — the decision core, unchanged.

## References

- ADR [pivot-v4-to-v5-on-prem-mission-tokens](../decisions/pivot-v4-to-v5-on-prem-mission-tokens.md)
  D1 (in-memory cache, single process), D4 (budget, claim), amendments
  (approval gate, management door, English).
- Spec [vaubaan-gateway](../spec/vaubaan-gateway.md) §3.1–3.5, §4.1,
  §6, §8, §10; [gateway-risk-model](../spec/gateway-risk-model.md) §8,
  §12.
- Neighbouring handbooks: [policy-engine](./policy-engine.md) (the pure
  engine this core calls), [mcp-gateway](./mcp-gateway.md) (legacy v4
  orchestration, historical).
