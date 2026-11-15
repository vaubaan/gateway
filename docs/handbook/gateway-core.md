---
title: Gateway core
tracks:
  - packages/gateway-core/src/
  - packages/gateway-core/package.json
  - packages/shared/src/domain.ts
  - packages/shared/src/refusal.ts
  - packages/shared/src/risk.ts
last_reviewed: 2026-11-01
---

# Gateway core — handbook

`@vaubaan/gateway-core`: typed refusals, the audit entry, the mission context
and the call pipeline whose stages the application fills
([execution-door](execution-door.md),
[budget-and-sessions](budget-and-sessions.md), the store, the plugins). Spec:
[gateway-risk-model](../spec/gateway-risk-model.md) §8, §12;
[vaubaan-gateway](../spec/vaubaan-gateway.md) §4.1, §8.

## Start here

- [`pipeline.ts`](../../packages/gateway-core/src/pipeline.ts) — doors, stage order, `CallOutcome`, what a rejection stores.
- [`errors.ts`](../../packages/gateway-core/src/errors.ts) — the `Refusal` union and `refuse.*` builders.
- [`risk-gateway.ts`](../../packages/gateway-core/src/risk-gateway.ts) — classify, intersect with the catalog, allow or deny; `evaluateCallForResourceSets` runs that risk step once per candidate resource set (`candidateResourceSets`), `evaluateCall` itself unchanged.
- [`fingerprint.ts`](../../packages/gateway-core/src/fingerprint.ts) — the one argument hash.

## Invariants

- **The barrel names the public API** (`src/index.ts`, no `export *`, **[inv: named-package-barrels]**): a name the other packages need is added there on purpose; the package's own tests import from the module.
- No transport, store or service here: the package depends only on
  `@vaubaan/shared`, `@vaubaan/policy-engine` and `classify` / `envOf` of the
  plugin SDK. Domain types are defined once in `@vaubaan/shared`.
- The policy's `risk_id`s are the accepted risks: no separate field that could
  diverge.
- A refusal is data returned by the pipeline, never an exception. Wording is
  keyed by status, so a new status fails to compile until it has its sentence.
- Every path writes exactly one audit entry, a throwing decision stage
  included; an `AuditWriter` must not swallow failures, and a failed write
  propagates even after a successful forward.
- The resource check runs before any risk; a refusal at any stage never
  reaches the budget or the upstream.
- `fingerprintArguments` binds the audit's `arguments_hash`, approval
  requests, approvals and the `approval-required` refusal: one value joins
  them.
- `rejected()` requires the stored text: a reason a plugin or stage wrote goes
  through `auditReason`; only `HOST_BUILT` reasons are stored as they are.

## Traps

- `BearerKind` (what opens a door) is not `CredentialKind` (how an account
  authenticates to its service).
- A stopped mission token (`token-rotated`, `holder-deactivated`, …) is an
  `AuthError` with a reason, not a refusal: one stopped token says nothing
  about the mission, which has one token per holder.
- Canonical JSON writes `null` for `Infinity` and `NaN` (`1e999` parses to
  `Infinity`): `unfaithfulArgument` rejects such a call before anything else,
  so the fingerprint binds what the plugin receives. `-0` and `0` collide and
  are accepted.
- A decision stage (`resource`, `risk`, `budget`) that throws decided nothing:
  the call is rejected and audited with a reason built from stage and error
  class only, never the message (it may quote arguments). The upstream stage
  is not a decision stage.
- `auditReason` replaces argument values in one pass, longest first: a
  sequential replace would re-match inside its placeholders.
- `upstream_error` is always a host-built summary; `upstreamErrorClassName`
  keeps a name only when identifier-shaped, so a free-text name cannot carry a
  message. An allowed call whose service failed stays `allowed`.
- `checkMissionActive` fails closed on an unreadable `expires_at`.
- `noEnvResolver` makes env-scoped risks unreachable; the `'unqualified'` mode
  is for catalog tooling and tests, never a host.
- `MemoryCacheClient` stores nothing for a TTL that is not a positive finite
  number (`NaN` would never expire). It is single-process.
- `precheck` (the git remote's listings) records, counts and executes
  nothing; `execute` decides again in full.
- The `permissionRefusal` hook stores evidence for a
  [permission request](requests.md) and changes no decision.
