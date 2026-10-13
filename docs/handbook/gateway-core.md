---
title: Gateway core
status: current
date: 2026-10-13
last_synced: 2026-10-13
tracks:
  - packages/gateway-core/src/
  - packages/gateway-core/tests/unit/
  - packages/gateway-core/package.json
  - packages/shared/src/domain.ts
  - packages/shared/src/refusal.ts
  - packages/shared/src/risk.ts
  - packages/shared/src/mcp.ts
---

# Gateway core — `@vaubaan/gateway-core`

The v5 decision core: typed refusals, the audit entry shape, the mission
context, and the skeleton of the call pipeline with the hook points the
features fill. No transport, no store, no provider lives here: the
execution door ([execution-door](execution-door.md)) calls it and provides
the resource, risk and upstream stages, the embedded store implements its
`AuditWriter`, the budget ([budget-and-sessions](budget-and-sessions.md))
its `BudgetStage`, the plugins its classifier.

Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §4.1 (structured
refusals), §6 (three credentials), §8 (audit);
[gateway-risk-model](../spec/gateway-risk-model.md) §8 (strict-fail
decision), §12 (audit shape of the risk fields). Replaces the legacy v4
handbook [mcp-gateway](./legacy/mcp-gateway.md).

## Layout

```
packages/gateway-core/
  src/
    types.ts         re-exports the shared vocabulary (RefusalCode, statuses, Budget, Period,
                     MissionPolicyEntry ...) and adds Door, BearerKind, MissionContext and
                     its projections (MissionConnection, MissionResource, MissionSummary)
    errors.ts        Refusal union, `refuse.*` builders, JSON-RPC mapping, AuthError
    audit.ts         CallAuditEntry / AdminAuditEntry, AuditWriter, MemoryAuditWriter,
                     BOOTSTRAP_ACTOR_ID / BOOTSTRAP_ACTOR_LABEL
    fingerprint.ts   canonicalJson, fingerprintArguments — the one argument hash (audit, approvals);
                     unfaithfulArgument — the first value JSON does not carry as is
    cache.ts         CacheClient interface, bounded MemoryCacheClient (single-process only)
    risk-gateway.ts  decision core: evaluateCallForToken (classify → intersect → allow/deny),
                     Classifier, CallVerdict, AcceptedRisksSnapshot
    pipeline.ts      door check, DoorAuthenticator, CallPipeline and its stage interfaces
    index.ts         barrel
  tests/unit/        errors, audit, fingerprint, cache, authenticate, pipeline, risk-gateway
```

Dependencies: `@vaubaan/shared` (the domain types, `RiskId`, `Slice`,
JSON-RPC primitives), `@vaubaan/policy-engine` (`evaluateCall`,
`envResolverFor`, `EnvResolver`, `IndexedRiskCatalog`) and
`@vaubaan/plugin-sdk` (the `classify` and `envOf` members of
`ProviderPlugin`, `ClassifyOutcome`). Nothing
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
refused").

## Refusals (`errors.ts`)

A refusal is **data returned by the pipeline**, not an exception. Eight
codes, one builder each under `refuse.*`, every refusal carrying its
`code`, the fields the spec lists, and an agent-readable `hint`:

| Code                      | Fields                                                                             | Hint says                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `risk-not-accepted`       | `missing_risks`, `executed_slices`                                                 | the policy engine's hint (required input), naming the risks                         |
| `budget-exhausted`        | `risk_id`, `quota`, `consumed`, `period_end` (null = one-off), `claim_url`         | hand the claim URL to the human, do not loop                                        |
| `approval-required`       | `risk_id`, `fingerprint`, `approval_url`, `expires_at`, `approval_valid_seconds`   | nothing executed, nothing held; replay the same tool and arguments within the delay |
| `resource-not-in-mission` | `cited_ref`, `connection {id,name}`, `allowed_resources[]`                         | which refs the mission may touch                                                    |
| `rate-limited`            | `risk_id`, `limit: RateLimit`, `retry_after_seconds`                               | wait N seconds; quota not consumed                                                  |
| `connection-unavailable`  | `connection {id,name}`, `status` (`expired` \| `revoked`), `owner {kind, display}` | who can reconnect                                                                   |
| `mission-inactive`        | `status` (expired/orphaned/revoked), `reason`                                      | stop calling, report to the human                                                   |
| `wrong-credential-kind`   | `door`, `presented`, `expected` (`BearerKind`)                                     | where the presented kind IS accepted (`ACCEPTED_AT`)                                |

`isRefusal(value)` is the type guard (`isRefusalCode(code)` and a non-empty
hint); `RefusalOf<C>` narrows a `Refusal` to one code.
`UNAVAILABLE_CONNECTION_STATUSES` / `isUnavailableConnectionStatus` pin
which connection statuses refuse: `expired` and `revoked`. An `unowned`
connection (its owning group emptied) keeps serving its missions until
someone reconnects or revokes it (spec §2). The wording per inactive
mission status lives in status-keyed records, so a new status fails to
compile until it has its sentence. The unit test asserts exactly eight codes in `REFUSAL_CODES` and one
sample per code.

**JSON-RPC mapping** — unchanged since v4: `refusalToRpcError(id, refusal)`
yields `{ code: -32603, message: 'Vaubaan refused the call: <code>', data: <refusal> }`.
`REFUSAL_RPC_CODE` exports the constant. `rpcError(id, code, message, data?)`
and `rpcSuccess(id, result)` are the generic builders the door uses for the
rest of the envelope. The whole refusal, hint
included, travels in `data`; the execution door throws exactly that error
through the MCP SDK, so the client receives the code, the fields and the
hint ([execution-door](execution-door.md), "What the agent receives").

**Not refusals** — `AuthError` (`AUTH_REQUIRED_RPC_CODE` = `-32001`,
`AUTH_REQUIRED_HTTP_STATUS` = 401) for a missing, malformed, unknown or
revoked bearer: nothing was identified, so there is no credential to
refuse. `GatewayError` is its base.

`AuthError.reason` is set when the secret of a mission token **was** proven
and the token no longer authenticates — `AUTH_FAILURE_REASONS`:
`token-rotated`, `token-revoked`, `holder-removed`, `holder-deactivated`, each
with its sentence for the agent in `AUTH_FAILURE_MESSAGES` (keyed by reason, so
a new one fails to compile until it has its sentence);
`AuthError.tokenStopped(reason)` builds it. These are deliberately **not**
refusal codes: a mission has several tokens, one per holder, and a token that
stopped says nothing about the mission, which may be serving the others
(`mission-inactive` would be false). The eight codes stay eight (ADR
[mission-members-and-per-holder-tokens](../decisions/mission-members-and-per-holder-tokens.md),
D6; the door's side is in [execution-door](execution-door.md), "Token
holders").

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
  then failed stays `allowed` with `upstream_error` set — also when the
  failure is the connection's credential rejected for good
  (`UpstreamRefusalError`): `upstream_error` is then `<refusal code>:
<status>` and `refusal_code` stays null. `upstream_error` is always a
  summary the host built, at most `UPSTREAM_ERROR_SUMMARY_MAX_LENGTH` (200)
  characters, never the provider's text (see "Call pipeline"). An operator
  query for
  "actions with no business effect" is `decision = 'allowed' AND
upstream_error IS NOT NULL`.
- A structural rejection without a code (an argument JSON cannot carry, unknown tool, a provider the
  mission has no connection for, classifier denial, catalog not loaded) is `decision = 'refused'`, `refusal_code = null`,
  `refusal_reason = <text>`. The text is the **audit copy** of the reason
  (`auditReason` in `pipeline.ts`): a plugin's denial may quote the value it
  refuses, which the caller reads whole in its JSON-RPC error, while the entry
  has every argument value found in the text (strings and numbers of three
  characters or more, at any depth) replaced by `[argument]` and is cut at
  500 characters — the audit holds the fingerprint of the arguments, never
  the arguments.

**Administrative entry**: `ts`, `user_id`, `act` (`AdminAct` union:
connection created/reconnected/refused/transferred/reassigned/revoked, resources
discovered, resource edited, share created/revoked,
mission issued/rotated/revoked/closed/orphaned/restored, budget extended, period reset,
expiry extended, gate opened, gate changed, approval granted, request refused,
delegation granted/revoked, group created, group member added/removed,
OAuth client approved/disabled, user deactivated/reactivated, config changed),
`object {type, id}` with `type: AdminObjectType` (`connection | share |
mission | request | delegation | group | oauth-client | user |
instance-config`),
`before`, `after`, `delegated_client_id` (set when the act came through
the management door).

`user_id` is the human behind the act: a user id (a delegated client acts
on behalf of one), or the exported constant `BOOTSTRAP_ACTOR_ID`
(`'bootstrap'`) for entries written by the bootstrap operator — the holder
of the one-time bootstrap token, who has no user row yet.
`BOOTSTRAP_ACTOR_LABEL` (`'Bootstrap operator'`) is its display name
wherever an actor is shown. One pair of constants serves every writer
(auth, connections) and every reader (audit).

**`AuditWriter { write(entry: AuditEntry): Promise<void> }`** is the
contract with the store's SQLite writer (`SqliteAuditWriter`, P0.3). Name
and signature are stable. A writer must not swallow failures: the pipeline
lets a rejected `write` propagate, so no call completes without its entry
(v4 logged and continued).

**`arguments_hash`** is `fingerprintArguments(args)` (`fingerprint.ts`):
SHA-256 hex (64 characters) of `canonicalJson(args ?? {})` — object keys
sorted recursively, arrays in order, `undefined` members dropped, `toJSON`
honoured, BigInt refused. It is the same value that binds approval
requests, approvals and the `approval-required` refusal, so an audit row
joins the request it produced. The budget re-exports both functions; v4's
16-hex `hashArguments` is gone.

**What the fingerprint cannot tell apart.** Canonical JSON writes `null` for
a number JSON has no text for (`Infinity`, `-Infinity`, `NaN`), so `{"n":
Infinity}` and `{"n": null}` share a fingerprint — and
`JSON.parse('{"n":1e999}')` yields `Infinity`. `unfaithfulArgument(args)`
(`fingerprint.ts`) returns the first such value, or `null`:
`UnfaithfulArgument { kind: 'non-finite-number' | 'bigint', path, value }`,
`path` like `a.b[2]` (`(arguments)` for the arguments as a whole), `value`
one of `Infinity`, `-Infinity`, `NaN`, `a BigInt` — never the arguments.
Functions, symbols and `undefined` are not reported: they are dropped, as
`JSON.stringify` drops them. The pipeline rejects a call that has one before
anything else looks at it (below). `-0` and `0` also share a fingerprint;
JSON carries both as `0`, and it is accepted (ADR
[execution-door-json-faithful-arguments-and-shared-throttle](../decisions/execution-door-json-faithful-arguments-and-shared-throttle.md)).

`MemoryAuditWriter` keeps entries in memory for tests (`.entries`, `.calls`,
`.admin`).

## Mission context (`types.ts`)

`MissionContext` is what the door loads once per call and the pipeline
reads. Its `token` is an `AuthenticatedToken` — `{ id, prefix, holder }`,
`holder` a `TokenHolder`: `{ kind: 'member', user_id, display }` or `{ kind:
'named', name }` (spec §0 "Mission token": one holder per token).
`tokenAttributionOf(token)` is what the audit keeps of it (`token_id`,
`token_kind`, and the user id or the name), `tokenHolderLabel(holder)` what a
reader is shown. The pipeline writes the attribution on every call entry
(`CallAuditEntry.token_id`, `token_kind`, `token_holder`; all three `null`
only on an entry older than the holder model): it comes from the context, so
nothing a call carries can change who called. Every member is a projection of a shared record, so the store (P0.3)
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
  It feeds `envResolverFor` and the plugin's `classify` as-is.
- `policy` — `MissionPolicy = readonly MissionPolicyEntry[]`, each entry
  `{ risk_id, quota, rate_limit: { max, window_seconds }, gate }`. The
  `risk_id`s **are** the accepted risks; `acceptedRisksOf(ctx)` derives
  them. There is no separate `accepted_risks` field, so the two cannot
  diverge. Always an explicit enumeration; `risk_id` unique within the list
  (the store enforces it at write time).
- `session` — `SessionHandle = Pick<Session, 'id' | 'started_at'>` or `null`
  before the first call.

`DelegationContext` carries what the door check needs for a delegated
token (delegation, user, public client id, scopes, expiry); it is produced
by the authorization server's `DelegatedTokenVerifier`
([management-door](management-door.md)).

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
unfaithfulArgument(call.args)       rejected, no code        (pure, this module)
checkMissionActive(ctx, now)        mission-inactive         (pure, this module)
resources.resolve(ctx, call)        resource-not-in-mission  (ResourceStage — execution door)
checkConnectionAvailable(target)    connection-unavailable   (pure, this module)
risks.evaluate(ctx, call, target)   risk-not-accepted        (RiskStage over evaluateCallForToken)
budget.decide(ctx, call, risks)     budget-exhausted | rate-limited | approval-required  (BudgetStage — P1.3)
upstream.execute(ctx, call, target) mint + forward           (UpstreamStage — execution door)
audit.write(entry)                  always, exactly once     (AuditWriter — P0.3)
```

`CallPipeline` is built from `CallPipelineDeps` (`resources`, `risks`,
`budget`, `upstream`, `audit`, optional `now` clock; the budget stage
returns a `BudgetDecision`). `CallPipeline.execute(ctx, call)` returns a
`CallOutcome`:

- `allowed` — provider result + audit entry;
- `refused` — a typed `Refusal` + audit entry (`refusal_code` set,
  `refusal_reason` = the hint; a `risk-not-accepted` entry also records
  the `risks_touched` the decision core computed, covered and missing);
- `rejected` — structural, no code (an argument that is not a JSON value,
  the resource stage found no target, classifier denial, catalog missing);
  fail closed. The first of these is decided before the mission's state is
  read and before any stage, and its reason reads
  `argument '<path>' is <value>: arguments must be JSON values (…)`.
  Its audit entry keeps the canonical hash of the arguments (the
  number reads `null` there), so it joins the other entries of the same
  arguments; for a BigInt, which has no canonical form and cannot come from a
  JSON body, the entry is built over empty arguments;
- `failed` — allowed, then the provider threw (`decision: 'allowed'`,
  `upstream_error` set). `refusal` is the typed refusal when the stage threw
  `UpstreamRefusalError` (`connection-unavailable` after a rejected
  refresh), `null` otherwise. `error` is the provider's detail, for the
  caller of the tool only.

A failed forward has two readers, and they do not get the same text.
Providers echo input in their errors, so the provider's message must not
reach the audit, whose only trace of the arguments is their hash:

| Thrown by the upstream stage                        | `audit.upstream_error` (stored)             | `outcome.error` (to the caller) |
| --------------------------------------------------- | ------------------------------------------- | ------------------------------- |
| `UpstreamFailureError({ summary, detail, status })` | `summary`                                   | `detail`                        |
| `UpstreamRefusalError(refusal, message)`            | `<refusal code>: <refusal status>`          | `<refusal code>: <message>`     |
| anything else                                       | `upstream call failed (<error class name>)` | the error's message             |

The stored value is cut at `UPSTREAM_ERROR_SUMMARY_MAX_LENGTH`.
`upstreamErrorClassName(thrown)` returns the error's `name` when it is
identifier-shaped (64 characters at most) and `Error` otherwise, so a name
set to free text cannot carry a message into the audit. The stage owns the
wording of `summary` (the execution door builds it from the provider id,
the HTTP status and the class name).

`execute` mirrors the table above, one private method per stage:
`resolveTarget` (resource resolution, then connection availability),
`decideRisks`, `decideBudget`, `forward`. Each returns either a final
`CallOutcome` (the call ends there, audited) or the audit entry enriched
with what the stage learned, which the next stage receives.

`checkMissionActive` fails closed on an expiry it cannot read: an
`expires_at` that `Date.parse` does not understand is `mission-inactive`
(`status: 'expired'`, the reason says the expiry is unreadable), never "no
expiry".

In `forward`, only the provider call sits in the `try`. A failure of the
audit write **after a successful forward** is not an upstream failure: it
propagates to the door, and is never recorded as `upstream_error` on an
action that did happen (the earlier form caught it, answered `failed` and
stored a second entry saying the provider had failed).

Invariants the tests pin: the resource check runs before any risk is
evaluated; a refusal at any stage never reaches the budget or the
upstream; the `risk-not-accepted` refusal is produced by the unchanged
decision core (`risks_touched ⊆ accepted_risks`); every path writes
exactly one audit entry; an audit write failure propagates, on the success
path as on the others, with the provider called once and no entry carrying
`upstream_error`.

`CallRequest` carries `tool`, `args`, the optional `agent_label` and the
`client` origin (`ClientOrigin { ip, user_agent }`), plus two optional
members for streaming: `onPart(part)`, which receives each part of a result
the provider delivers progressively, and `signal`, aborted when the caller is
gone. The pipeline itself reads neither: only the upstream stage — the last
one, after every check and the budget decrement — calls `onPart`, and the
audit entry is still written once, when the forward ends, so its
`upstream_latency_ms` covers the whole stream ([execution-door](execution-door.md),
"Streaming"). No stage reads `agent_label`: it is copied to the entry. `CallTarget` is the
resolved
`{ connection, resource | null }`.

### Stage contracts (hook points)

| Interface       | Filled by      | Contract                                                                                                                                                        |
| --------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ResourceStage` | execution door | `resolve(ctx, call)` → `ResourceResolution`: target, `resource-not-in-mission` refusal, or `{ ok: false, reason }` (structural rejection)                       |
| `RiskStage`     | execution door | `evaluate(ctx, call, target)` → `CallVerdict` (default: `evaluateCallForToken` + the plugin's `classify`)                                                       |
| `BudgetStage`   | P1.3           | `decide(ctx, call, {risks_touched, now})` → allowed `{session_id, remaining, approval_id}` or refusal; atomic; a refusal decrements nothing                     |
| `UpstreamStage` | execution door | `execute(ctx, call, target)` → provider result; throws `UpstreamRefusalError(refusal)` for an unusable connection, `UpstreamFailureError` for any other failure |
| `AuditWriter`   | P0.3           | `write(entry)`; failures propagate                                                                                                                              |

## Decision core (`risk-gateway.ts`)

`evaluateCallForToken({ tool, args, resources, token, adapter, catalog,
envResolver? })` classifies through the plugin, intersects with the
`IndexedRiskCatalog` (`evaluateCall` of the policy engine) and returns a
`CallVerdict`: `allow` (risks touched, slices), `deny` (`code:
'risk-not-accepted'`, missing risks, risks touched, slices, hint),
`classify-denied` (plugin reason), `no-catalog` (fail closed). The decision itself is unchanged by the pivot; its inputs are v5:

- `adapter: Classifier = Pick<ProviderPlugin, 'classify' | 'envOf'>` — a
  registered plugin satisfies it as-is; tests pass a stub.
  `classify(tool, args, resources)` returns the SDK's `ClassifyOutcome`
  (`{ slices }` or `{ denied }`), re-exported here; the optional
  `envOf(slice, resources)` is the plugin's own environment derivation.
- `resources: Resource[]` — the mission's resources on the target
  connection, handed to the classifier and, by default, to
  `envResolverFor(resources, adapter.envOf)`: the plugin's own derivation
  first (Vercel's `env[prod]` segment), the owner's label on the matching
  resource next, unqualified last. So a mission that accepted
  `supabase[staging].bulk-row-write` matches an executed
  `supabase.bulk-row-write` on the staging resource. A host may pass its
  own `envResolver`; the literal `'unqualified'` asks for the engine's mode
  without env qualification (catalog tooling and tests, never a host). A
  resolver that knows no environment (`noEnvResolver`) is not that mode: it
  leaves env-scoped risks where no mission can hold them, and the call is
  refused.
- `token: AcceptedRisksSnapshot` — `{ id, accepted_risks, denied_risks? }`;
  `denied_risks` is the v4 explicit-deny list, optional: a v5 mission
  carries none (the callers written before it became optional pass `[]`).
  When given, a denied risk still trumps acceptance.

The policy engine's `RiskDecision` (denied) carries `code:
'risk-not-accepted'` (the only code the risk step emits) and the hint; the
verdict forwards both and the pipeline's refusal is built from them with
`refuse.riskNotAccepted` (the engine owns the wording, gateway-core never
composes a fallback).

## Cache (`cache.ts`)

`CacheClient { get, set(key, value, ttlSeconds), del }` is the interface
the execution door keeps its verified-token proofs and the plugins'
derived upstream credentials behind; it is
the only cache port of the code base (the composition root re-exports it
and builds `MemoryCacheClient`, see [configuration](configuration.md)).
`MemoryCacheClient` is bounded (`maxEntries`, default 10 000; the oldest
entry is evicted after a sweep of expired ones; re-setting a key makes it
the newest), exposes `size` and takes an injectable clock
(`MemoryCacheOptions`). `set` with a TTL that is not a positive, finite
number stores nothing (and drops the key): `NaN` would otherwise yield an
entry that never expires.

`// single-process only` — a multi-replica deployment swaps in a shared
implementation of `CacheClient`; nothing else changes. The v4
`RedisCacheClient` (Upstash) and `buildCacheClient(env)` are deleted (ADR
pivot D1; the Upstash ADR is superseded).

## What left the package

- `gateway.ts` — the v4 `McpGateway` orchestrator (org/project context,
  bindings, single-use tokens, venv tools). It lived on as
  `apps/gateway/src/lib/gateway/legacy-v4-gateway.ts` until the execution
  door replaced `/mcp`; it is deleted, with `hashArguments` and
  `denyResponseBody`, which only it used.
- `venv-store.ts` — project-scoped secret transfer; no v5 counterpart
  (plan §8-Q5).
- `SupabaseAuditWriter`, `RedisCacheClient`, `buildCacheClient`, and the
  `@supabase/supabase-js`, `@upstash/redis`, `@vaubaan/plugin-github`
  dependencies (declared, never imported).
- The local twins of the shared domain types (`RefusalCode`,
  `CredentialKind`, `Principal`, `Period`, `Budget`, the `Record`-shaped
  `MissionPolicy`) and the v4 `ProviderBinding` / `classifyV4` inputs of
  the decision core — reconciled at the end of the P0 wave (P0.R).

## Tests

`packages/gateway-core/tests/unit/`, vitest, no network, no store:

- `errors.test.ts` (29) — eight codes, one sample each, every field, hint
  non-empty and serializable; `isRefusal`; `isUnavailableConnectionStatus`;
  `rpcError` / `rpcSuccess`; `AuthError` code and status;
  `refusalToRpcError` (-32603, data = refusal); the `mission-inactive` hint of
  an orphaned mission says how long an earlier request stays grantable.
- `audit.test.ts` (2) — `MemoryAuditWriter` over both kinds; the call entry
  carries every §8 field.
- `fingerprint.test.ts` (12) — key sorting, `undefined` and array holes,
  `toJSON`, primitives, BigInt refused, sha256 vector, key order vs value
  change, no arguments, 64 hex; `unfaithfulArgument`: nothing found in what
  JSON carries as is, the first non-finite number named with its path, a
  BigInt named, `Infinity` and `null` colliding in the fingerprint.
- `cache.test.ts` (7) — TTL, a non-positive or non-finite TTL caching
  nothing, delete, bound eviction order, refresh on re-set, sweep before
  eviction, invalid bound.
- `authenticate.test.ts` (11) — door table, pure `checkDoor` on every
  mismatch, `parseBearer`, `DoorAuthenticator` for mission token vs
  delegated token vs session at each door, unknown bearer → `AuthError`.
- `pipeline.test.ts` (28) — `checkMissionActive` (status, passed, future
  and unreadable `expires_at`, the wording of an expired status without a
  stored expiry), `checkConnectionAvailable` (`unowned` passes,
  `expired` and `revoked` refuse), then the pipeline over
  a shared-shaped context (`ConnectionResource`, policy entries, one-off
  period): happy path with the full audit entry, inactive mission
  short-circuit, resource refusal before risk, expired connection,
  `risk-not-accepted` through the real decision core and the resources of
  the target connection, structural rejections, budget refusal without
  upstream, approval id carried, upstream failure after allow (with and
  without `UpstreamRefusalError`; `UpstreamFailureError` with an argument
  marker absent from the audit and present on the outcome; the bound of the
  stored summary; `upstreamErrorClassName`), a call with no target rejected before
  any risk, an argument JSON cannot carry (`Infinity`) rejected before any
  stage, audit failure propagating — including a writer that fails once
  after a successful forward (the call rejects, the provider was called
  once, nothing is stored as an upstream failure) and one that fails after
  an upstream failure.
- `risk-gateway.test.ts` (9) — the decision core: allow, deny with
  `code: 'risk-not-accepted'`, classifier denial, missing catalog,
  explicit denies and `denied_risks` left out, the classifier receives
  `(tool, args, resources)`, environment qualification: the adapter's
  `envOf` first, the resource label when it abstains, an explicit
  `envResolver` overriding both, and `envResolver: 'unqualified'`.

## References

- ADR [pivot-v4-to-v5-on-prem-mission-tokens](../decisions/pivot-v4-to-v5-on-prem-mission-tokens.md)
  D1 (in-memory cache, single process), D4 (budget, claim), amendments
  (approval gate, management door, English);
  [plugin-contract-and-credential-spec](../decisions/plugin-contract-and-credential-spec.md)
  D1 (`classify`), D3 (`Resource`, `EnvResolver`), D8 (`shared` reset);
  [execution-door-json-faithful-arguments-and-shared-throttle](../decisions/execution-door-json-faithful-arguments-and-shared-throttle.md)
  (arguments must be JSON values).
- Spec [vaubaan-gateway](../spec/vaubaan-gateway.md) §3.1–3.5, §4.1,
  §6, §8, §10; [gateway-risk-model](../spec/gateway-risk-model.md) §8,
  §12.
- Neighbouring handbooks: [policy-engine](./policy-engine.md) (the pure
  engine this core calls), [plugin-sdk](./plugin-sdk.md) (the shared
  vocabulary and the plugin contract), [store](./store.md) (the
  `AuditWriter` implementation), [execution-door](./execution-door.md)
  (the door and the stages), [mcp-gateway](./legacy/mcp-gateway.md) (legacy v4
  orchestration, historical).
