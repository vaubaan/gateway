---
title: Execution door — /mcp, admission, the call's stages, streaming, the catalog
tracks:
  - apps/gateway/src/server/execution/
  - apps/gateway/src/server/http/client-ip.ts
  - apps/gateway/src/app/mcp/
  - apps/gateway/src/app/.well-known/oauth-protected-resource/route.ts
  - packages/gateway-core/src/pipeline.ts
  - packages/gateway-core/src/fingerprint.ts
  - packages/plugin-sdk/src/streaming.ts
  - apps/gateway/tests/manual/seed-demo.ts
  - apps/gateway/tests/manual/streaming-check.ts
  - deploy/caddy/Caddyfile
last_reviewed: 2026-10-27
---

# Execution door — handbook

How an agent holding a mission token lists and calls tools on `/mcp` and reads `/mcp/catalog`. Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §2.4, §3.1, §4.1, §6, §7.5, §7.9; stage order and refusal shapes: [gateway-core](gateway-core.md); counting: [budget and sessions](budget-and-sessions.md). ADRs: [docker-image-and-config-format](../decisions/docker-image-and-config-format.md), [mission-token-sha256-digest](../decisions/mission-token-sha256-digest.md), [upstream-credential-cache-and-rejected-credentials](../decisions/upstream-credential-cache-and-rejected-credentials.md), [plugin-contract-and-credential-spec](../decisions/plugin-contract-and-credential-spec.md).

## Start here

- [`door.ts`](../../apps/gateway/src/server/execution/door.ts) — `handleMcp` / `handleCatalog`, the two protocol eras, JSON-RPC rendering, the after-call hook.
- [`admission.ts`](../../apps/gateway/src/server/execution/admission.ts) — origin, bearer, grounds, surface rate limit.
- [`mission-context.ts`](../../apps/gateway/src/server/execution/mission-context.ts) — what a request may reach, rebuilt per request.
- [`resource-stage.ts`](../../apps/gateway/src/server/execution/resource-stage.ts), [`upstream-stage.ts`](../../apps/gateway/src/server/execution/upstream-stage.ts) — the stages the door supplies to `CallPipeline`.

## Invariants

- **One admission for both doors.** The same `MissionAdmission` instance serves `/mcp` and the git remote, which passes its Basic password as `Bearer <key>` (structural test: `root.git.door.admission === root.execution.door.admission`).
- **Nothing is remembered.** Every request re-verifies the token (`MissionService.verifyToken`), re-derives orphaned and lost connections (`grounds.inspect`, nothing written) and rebuilds `loadMissionContext` from the store: a rotation, revocation, removal or restored authority is seen by the next call.
- **Host-agnostic.** `server/execution/` never imports `next`; routes under `app/mcp/` are one-line adapters.
- **Arguments are JSON values before any stage.** `unfaithfulArgument` rejects a non-finite number (`1e999` → `Infinity`) or a BigInt before the mission state is read, so what is fingerprinted, sealed and handed to the plugin is what JSON carries.
- **A decision stage that throws refuses the call, audited.** The reason is built from the stage and the error class, never the message, which can quote arguments (threat model, `every-refused-call-audited`).
- **Git tools only through git.** The resource stage decides a plugin's `gitRemote` fetch/push tools for `channel: 'git'` only, every other tool for `mcp` only, so a push's arguments are always the host's review, never an agent's claim.
- **The plugin sees what the door allows.** `ctx.resources` is the very array the resource stage checks against; `classify` gets the connection's public fields only (`classifyConnectionOf`), never the credential.
- **The agent label is attribution only.** No stage reads it, it reserves no budget; a bad value is dropped and logged (`agent label dropped`, never the value), never refused or repaired. Its shape constants live in `missions/bootstrap-kit.ts`, which prints them to agents.
- **One client-address rule** (`clientIpOf`: right-most `X-Forwarded-For` hop not in `trusted_proxies`, else `unknown`) for the audit's `client_ip`, the legacy-token throttle and the request page's rate limit.
- **Provider text stays with the agent.** `UpstreamFailureError.detail` goes to the agent only; the audit's `upstream_error` is a summary from provider id, status and class name.
- **Streaming decides first.** State, resource, risk and the budget transaction commit before `execute` runs; parts leave as `notifications/progress` to a caller that sent a `progressToken`; one audit entry when the stream ends; no refresh-and-retry once a part left (it would deliver the start twice).
- **No cap stage.** Catalog `caps` are applied nowhere; the one enforced catalog limit is `infra_limits.calls_per_minute_max`, at preview. `catalog-caps-enforced.test.ts` fails a shipped catalog declaring a limit the gateway does not apply ([scope-caps-amplification-axis](../decisions/scope-caps-amplification-axis.md)).

## Traps

- **The surface rate limit is per mission on purpose**: a per-token window would multiply the ceiling by the token count. One holder can exhaust it for the others (threat model, A26); the audit names the holder.
- **A stopped key is a 401, not a refusal.** `token-rotated`, `token-revoked`, `holder-removed`, `holder-deactivated` (`AUTH_FAILURE_REASONS`) are given only when the secret was proven, before the pipeline: no credit, no call entry. `mission-inactive` would be false, the mission may serve other holders.
- **Legacy argon2id tokens** are the only throttled verification (`mcp-verify:<prefix>:<client address>`, 30 per minute; the prefix is public, so the address is in the key). Without `trusted_proxies` every caller is `unknown` and shares one window per prefix (boot `warn`). The first matching call rehashes the row to its digest.
- **`last_used_at`** is the door's only write outside the pipeline, at most once per token per 60 s; a failure is logged, never refuses.
- **`connection-unavailable` after the allow** (rejected refresh) keeps the entry `allowed`, credit consumed. `isError: true` is the executor declining the call itself: `allowed`, no `upstream_error`, handed back untouched.
- **The upstream credential cache** keys on the connection's `updated_at`, so a reconnect or refresh orphans old entries; `drop` deletes only what this process wrote. No shipped plugin uses it yet.
- **Two protocol eras.** 2026-07-28 requests go to `createMcpHandler` (JSON, upgraded to SSE at the first notification); 2025-era ones (what Claude Code sends today) to a stateless JSON transport, except a `tools/call` with a `progressToken`, routed to `legacyStatelessFallback` (SSE). On that leg even a refusal is SSE-framed.
- **The after-call hook is awaited** before an `allowed` answer leaves (record created resources, schedule discovery); it never throws and never changes the answer.
- **The stored rejection reason is not always what the agent read**: argument values of 3+ characters found verbatim in a plugin's sentence become `[argument]`; short or transformed values are not caught.
- **Buffering.** `compress: false` in `next.config.ts`; `flush_interval -1` in the Caddyfile is kept as an explicit guarantee; another proxy must not buffer (`X-Accel-Buffering: no` covers nginx). The full result is still held in memory; a process dying mid-stream leaves a counted action with no entry (`countersAgreeWithAudit` reports it).
- **Caller gone mid-stream** is checked between parts only (an in-flight provider call is not interrupted); it writes `stream stopped … the caller was gone` and no telemetry report.

## Procedures

- **Manual smoke** (`tests/manual/seed-demo.ts`): seeds a user, a GitHub connection and a `read-only` mission, prints the kit; exercise `/healthz`, `initialize`, `tools/list`, a refused `tools/call`, `/mcp/catalog`, the 401 and the protected-resource document with `curl` and the official client in both eras; check the secret never appears in the log. Not done yet: Claude Code against a TLS-terminated instance with a real connection.
- **Streaming check** (`tests/manual/streaming-check.ts serve`, then `probe <url> <token>`): exits non-zero when frames arrive buffered. Done directly and behind Caddy; not done with a real provider or another proxy.
- **Retiring legacy tokens**: `SELECT COUNT(*) FROM mission_tokens WHERE hash_alg = 'argon2id' AND status = 'active'`; at zero, the throttle and the `argon2` dependency can go.

## Debug

- **401 with a fresh token** → `error.data.reason` is set only when the secret is right; no reason: truncated bearer or another instance. No `Authorization` reaching the instance: the TLS terminator strips it.
- **403 `wrong-credential-kind`** → a session cookie or a delegated token instead of a mission key. **403 on everything from a browser client** → it sends `Origin`; there is no CORS.
- **429 `-32002`** → the mission's surface limit, or, for an unused legacy token, the verification throttle: declare `trusted_proxies` or let the agent succeed once.
- **`-32602` `Vaubaan rejected the call`** → unknown tool, no connection of that provider, the classifier could not place the arguments, or `could not decide this call: the <stage> stage failed` (see the `error` log line).
- **`resource-not-in-mission` on a selected resource** → it went stale; Refresh on the account page. **Listed then `risk-not-accepted`** → expected, the list is per provider.
- **`connection-unavailable` after working calls** → 401 then rejected refresh; log `credential refresh rejected`.
- **Only the result, no progress** → no `progressToken`, the plugin does not `emitPart`, or a buffering proxy (`streaming-check.ts probe`).
