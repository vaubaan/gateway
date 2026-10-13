---
title: Integration tests
status: current
date: 2026-10-13
last_synced: 2026-10-13
tracks:
  - vitest.config.ts
  - packages/policy-engine/tests/
  - packages/plugin-sdk/tests/
  - plugins/_template/tests/
  - plugins/github/tests/
  - plugins/vercel/tests/
  - plugins/supabase/tests/
  - plugins/railway/tests/
  - plugins/ssh/tests/
  - plugins/resend/tests/
  - plugins/upstash-redis/tests/
  - plugins/cloudflare-dns/tests/
  - plugins/gmail/tests/
  - plugins/stripe/tests/
  - packages/gateway-core/tests/
  - apps/gateway/tests/
  - apps/gateway/src/server/
  - apps/gateway/src/app/
  - apps/gateway/migrations/
  - packages/telemetry/src/
  - deploy/collector/
  - packages/shared/src/
---

# Integration tests

Vitest, headless. No browser, no database server, no real provider.
Discovery is centralised in
`vitest.config.ts` (`test.include`):

```
apps/*/tests/unit/**/*.test.ts         apps/*/tests/unit/**/*.test.tsx
apps/*/tests/integration/**/*.test.ts
packages/*/tests/unit/**/*.test.ts     packages/*/tests/unit/**/*.test.tsx
packages/*/tests/integration/**/*.test.ts
plugins/*/tests/unit/**/*.test.ts
packages/*/src/**/*.test.ts            apps/*/src/**/*.test.ts
```

`apps/*/tests/e2e/**` is excluded (Playwright, see
[`e2e-tests.md`](./e2e-tests.md)), and so is `apps/gateway/tests/manual/`
(no `*.test.ts` there). Every test runs in the `node` environment. No test
reaches a provider: the v4 suites that could (and the `SKIP_LIVE` switch
that guarded them) were deleted with the v4 application. One suite opens a
socket, on loopback only: `plugins/ssh/tests/unit/host-key-pinning.test.ts`
drives the real SSH transport against an ssh server started in the test
process.

## Map — spec §10 to this file

The scenarios below are grouped by v5 subsystem, one section per package or
server module, each appended to by the feature that built it. Spec
[vaubaan-gateway](../spec/vaubaan-gateway.md) §10 lists what must be tested;
this table says where each requirement lives, and what is not written yet.

| Spec §10                                                                 | Section                                                                                                                                                                 |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit — each plugin's classifier                                          | [Provider plugins](#scenarios--provider-plugins)                                                                                                                        |
| Unit — authority composition, resource selection, environment resolution | [Policy engine](#scenarios--policy-engine), [Missions](#scenarios--missions), [Execution door](#scenarios--execution-door)                                              |
| Unit — the budget                                                        | [Budget and sessions](#scenarios--budget-and-sessions)                                                                                                                  |
| Unit — the approval                                                      | [Budget and sessions](#scenarios--budget-and-sessions) (fingerprint, lookup, consumption), [Approval gate](#scenarios--approval-gate) (decision, gate opening, erasure) |
| Unit — structured refusals                                               | [gateway-core](#scenarios--gateway-core), [Execution door](#scenarios--execution-door)                                                                                  |
| Unit — credential separation                                             | [gateway-core](#scenarios--gateway-core), [Execution door](#scenarios--execution-door); the management surface is not built (P2.3)                                      |
| Integration — connection                                                 | [Connections](#scenarios--connections-resources-provider-apps)                                                                                                          |
| Integration — share                                                      | [Store](#scenarios--store) (rows and restrictions only); the flow is not built (P2.2)                                                                                   |
| Integration — issuance                                                   | [Missions](#scenarios--missions)                                                                                                                                        |
| Integration — claim and replay                                           | [Requests](#scenarios--requests), [Execution door](#scenarios--execution-door)                                                                                          |
| Integration — approval and replay                                        | [Approval gate](#scenarios--approval-gate)                                                                                                                              |
| Integration — revocation flows, `orphaned` states                        | [Missions](#scenarios--missions), [Budget and sessions](#scenarios--budget-and-sessions), [Connections](#scenarios--connections-resources-provider-apps)                |
| Integration — OAuth delegation, issuance by an MCP client                | not written (P2.3)                                                                                                                                                      |
| Integration — simulated IdP                                              | [Human authentication](#scenarios--human-authentication)                                                                                                                |
| Structural — telemetry report without forbidden fields                   | [Community telemetry](#scenarios--community-telemetry)                                                                                                                  |
| Structural — session counters agree with the audit                       | [Execution door](#scenarios--execution-door), [Budget and sessions](#scenarios--budget-and-sessions)                                                                    |
| Structural — no configuration value hard-coded                           | [Instance configuration](#scenarios--instance-configuration-crypto-composition-root)                                                                                    |
| Structural — enumerated lists, never a wildcard or a preset reference    | [Plugin SDK](#scenarios--plugin-sdk), [Store](#scenarios--store), [Missions](#scenarios--missions)                                                                      |
| Structural — every plugin ships a preset of its own catalog              | [Plugin SDK](#scenarios--plugin-sdk), [Provider plugins](#scenarios--provider-plugins)                                                                                  |
| Structural — authority recomputed from current membership                | [Human authentication](#scenarios--human-authentication), [Missions](#scenarios--missions)                                                                              |
| End to end — the cutover acceptance scenario                             | [`e2e-tests.md`](./e2e-tests.md): manual, with an automated browser smoke before it                                                                                     |

## Coverage

| Suite                                                                     |    Tests |
| ------------------------------------------------------------------------- | -------: |
| `apps/gateway/src/app/(app)/missions/new/form-state.test.ts`              |       22 |
| `apps/gateway/src/server/audit/filters.test.ts`                           |       18 |
| `apps/gateway/src/server/auth/admin-rule.test.ts`                         |        5 |
| `apps/gateway/src/server/auth/bootstrap.test.ts`                          |        3 |
| `apps/gateway/src/server/auth/claims.test.ts`                             |       11 |
| `apps/gateway/src/server/auth/guard.test.ts`                              |       10 |
| `apps/gateway/src/server/auth/handlers.test.ts`                           |        9 |
| `apps/gateway/src/server/auth/idp-settings.test.ts`                       |        7 |
| `apps/gateway/src/server/auth/origin.test.ts`                             |        5 |
| `apps/gateway/src/server/auth/session-service.test.ts`                    |        7 |
| `apps/gateway/src/server/authority/authority-service.test.ts`             |        7 |
| `apps/gateway/src/server/compose/compose.test.ts`                         |       16 |
| `apps/gateway/src/server/config/duration.test.ts`                         |        2 |
| `apps/gateway/src/server/config/load.test.ts`                             |       38 |
| `apps/gateway/src/server/connections/codec-and-keypair.test.ts`           |       12 |
| `apps/gateway/src/server/connections/credentials.test.ts`                 |       15 |
| `apps/gateway/src/server/connections/input.test.ts`                       |       23 |
| `apps/gateway/src/server/connections/install-verification.test.ts`        |        5 |
| `apps/gateway/src/server/connections/mapping.test.ts`                     |        3 |
| `apps/gateway/src/server/connections/oauth2.test.ts`                      |       16 |
| `apps/gateway/src/server/connections/pending.test.ts`                     |        7 |
| `apps/gateway/src/server/connections/service.test.ts`                     |       33 |
| `apps/gateway/src/server/connections/shipped-providers.test.ts`           |        5 |
| `apps/gateway/src/server/crypto/aead.test.ts`                             |       12 |
| `apps/gateway/src/server/execution/execution.test.ts`                     |       21 |
| `apps/gateway/src/server/http/client-ip.test.ts`                          |       11 |
| `apps/gateway/src/server/http/healthz.test.ts`                            |        4 |
| `apps/gateway/src/server/logging/logging.test.ts`                         |        6 |
| `apps/gateway/src/server/missions/bootstrap-kit.test.ts`                  |        9 |
| `apps/gateway/src/server/missions/catalog-view.test.ts`                   |       11 |
| `apps/gateway/src/server/missions/preview.test.ts`                        |       44 |
| `apps/gateway/src/server/missions/summary.test.ts`                        |        8 |
| `apps/gateway/src/server/missions/token.test.ts`                          |        8 |
| `apps/gateway/src/server/provider-apps/service.test.ts`                   |       15 |
| `apps/gateway/src/server/requests/approval.test.ts`                       |       27 |
| `apps/gateway/src/server/requests/claim.test.ts`                          |       37 |
| `apps/gateway/src/server/requests/client-ip.test.ts`                      |        2 |
| `apps/gateway/src/server/requests/events.test.ts`                         |        6 |
| `apps/gateway/src/server/requests/state.test.ts`                          |        9 |
| `apps/gateway/src/server/requests/sweeper.test.ts`                        |        4 |
| `apps/gateway/src/server/telemetry/outcome.test.ts`                       |       28 |
| `apps/gateway/src/server/telemetry/settings.test.ts`                      |        7 |
| `apps/gateway/src/server/telemetry/stats.test.ts`                         |       11 |
| `apps/gateway/tests/integration/audit/admin-mutations.test.ts`            |       26 |
| `apps/gateway/tests/integration/audit/audit-query.test.ts`                |       22 |
| `apps/gateway/tests/integration/audit/mission-session.test.ts`            |       15 |
| `apps/gateway/tests/integration/audit/retention.test.ts`                  |       10 |
| `apps/gateway/tests/integration/auth/oidc-login.test.ts`                  |       16 |
| `apps/gateway/tests/integration/budget/pipeline-consistency.test.ts`      |        6 |
| `apps/gateway/tests/integration/budget/session-service.test.ts`           |       20 |
| `apps/gateway/tests/integration/compose/boot.test.ts`                     |        4 |
| `apps/gateway/tests/integration/connections/connect-flow.test.ts`         |        6 |
| `apps/gateway/tests/integration/connections/repository-status.test.ts`    |        9 |
| `apps/gateway/tests/integration/execution/approval-door.test.ts`          |        7 |
| `apps/gateway/tests/integration/execution/counters-vs-audit.test.ts`      |        4 |
| `apps/gateway/tests/integration/execution/door-http.test.ts`              |       19 |
| `apps/gateway/tests/integration/execution/pipeline.test.ts`               |       22 |
| `apps/gateway/tests/integration/missions/gate.test.ts`                    |       17 |
| `apps/gateway/tests/integration/missions/mission-handlers.test.ts`        |        8 |
| `apps/gateway/tests/integration/missions/mission-lifecycle.test.ts`       |       28 |
| `apps/gateway/tests/integration/requests/approval-access.test.ts`         |       29 |
| `apps/gateway/tests/integration/requests/approval.test.ts`                |       42 |
| `apps/gateway/tests/integration/requests/request-handlers.test.ts`        |       13 |
| `apps/gateway/tests/integration/requests/request-service.test.ts`         |       30 |
| `apps/gateway/tests/integration/standalone-native-addons.test.ts`         |        3 |
| `apps/gateway/tests/integration/standalone-plugin-catalogs.test.ts`       |        2 |
| `apps/gateway/tests/integration/store/approval-decisions.test.ts`         |       16 |
| `apps/gateway/tests/integration/store/audit.test.ts`                      |       13 |
| `apps/gateway/tests/integration/store/config.test.ts`                     |        7 |
| `apps/gateway/tests/integration/store/connections-shares.test.ts`         |       13 |
| `apps/gateway/tests/integration/store/corrupt-rows.test.ts`               |       14 |
| `apps/gateway/tests/integration/store/delegations.test.ts`                |        7 |
| `apps/gateway/tests/integration/store/identities.test.ts`                 |       10 |
| `apps/gateway/tests/integration/store/missions.test.ts`                   |        8 |
| `apps/gateway/tests/integration/store/requests-approvals.test.ts`         |       10 |
| `apps/gateway/tests/integration/store/schema.test.ts`                     |        6 |
| `apps/gateway/tests/integration/store/sessions.test.ts`                   |       11 |
| `apps/gateway/tests/integration/store/web-sessions.test.ts`               |        8 |
| `apps/gateway/tests/integration/telemetry/telemetry.test.ts`              |       15 |
| `apps/gateway/tests/unit/app/admin-guard.test.ts`                         |       29 |
| `apps/gateway/tests/unit/app/app-guard.test.ts`                           |       80 |
| `apps/gateway/tests/unit/app/field.test.tsx`                              |        6 |
| `apps/gateway/tests/unit/server/auth/mutation-guard.test.ts`              |      131 |
| `apps/gateway/tests/unit/server/budget/decide.test.ts`                    |       15 |
| `apps/gateway/tests/unit/server/budget/gates.test.ts`                     |        9 |
| `apps/gateway/tests/unit/server/budget/mission-state.test.ts`             |        7 |
| `apps/gateway/tests/unit/server/budget/period.test.ts`                    |        8 |
| `apps/gateway/tests/unit/server/connections/provider-app-handler.test.ts` |        4 |
| `apps/gateway/tests/unit/server/rate-limit/sliding-window.test.ts`        |        8 |
| `apps/gateway/tests/unit/server/store/db.test.ts`                         |        2 |
| `apps/gateway/tests/unit/server/store/ids.test.ts`                        |        6 |
| `apps/gateway/tests/unit/server/store/migrate.test.ts`                    |        9 |
| `apps/gateway/tests/unit/structural/catalog-caps-enforced.test.ts`        |       12 |
| `apps/gateway/tests/unit/structural/example-config-providers.test.ts`     |       10 |
| `apps/gateway/tests/unit/structural/no-hardcoded-config.test.ts`          |      226 |
| `apps/gateway/tests/unit/structural/telemetry-collector-schema.test.ts`   |        7 |
| `apps/gateway/tests/unit/structural/telemetry-report-shape.test.ts`       |        3 |
| `packages/gateway-core/tests/unit/audit.test.ts`                          |        2 |
| `packages/gateway-core/tests/unit/authenticate.test.ts`                   |       11 |
| `packages/gateway-core/tests/unit/cache.test.ts`                          |        7 |
| `packages/gateway-core/tests/unit/errors.test.ts`                         |       28 |
| `packages/gateway-core/tests/unit/fingerprint.test.ts`                    |        8 |
| `packages/gateway-core/tests/unit/pipeline.test.ts`                       |       27 |
| `packages/gateway-core/tests/unit/risk-gateway.test.ts`                   |        9 |
| `packages/plugin-sdk/tests/unit/catalog-loader.test.ts`                   |       31 |
| `packages/plugin-sdk/tests/unit/catalog-path.test.ts`                     |        4 |
| `packages/plugin-sdk/tests/unit/define-plugin.test.ts`                    |       24 |
| `packages/plugin-sdk/tests/unit/env-of.test.ts`                           |        3 |
| `packages/plugin-sdk/tests/unit/registry.test.ts`                         |       10 |
| `packages/plugin-sdk/tests/unit/testing-kit.test.ts`                      |       14 |
| `packages/policy-engine/tests/unit/budget.test.ts`                        |       25 |
| `packages/policy-engine/tests/unit/qualify.test.ts`                       |       29 |
| `packages/policy-engine/tests/unit/risk-evaluator.test.ts`                |       20 |
| `packages/policy-engine/tests/unit/risk-policy.test.ts`                   |        9 |
| `packages/policy-engine/tests/unit/risk-runtime.test.ts`                  |       25 |
| `packages/policy-engine/tests/unit/slice-dsl.test.ts`                     |       23 |
| `packages/policy-engine/tests/unit/slice-matcher.test.ts`                 |       29 |
| `packages/shared/src/api-key.test.ts`                                     |        9 |
| `packages/shared/src/data-model.test.ts`                                  |        4 |
| `packages/shared/src/mcp.test.ts`                                         |       10 |
| `packages/shared/src/risk-id.test.ts`                                     |       20 |
| `packages/shared/src/session-events.test.ts`                              |       28 |
| `packages/telemetry/src/client.test.ts`                                   |       17 |
| `packages/telemetry/src/queue.test.ts`                                    |       12 |
| `packages/telemetry/src/report.test.ts`                                   |       24 |
| `plugins/_template/tests/unit/plugin.test.ts`                             |       18 |
| `plugins/cloudflare-dns/tests/unit/classify.test.ts`                      |       33 |
| `plugins/cloudflare-dns/tests/unit/data-model.test.ts`                    |        9 |
| `plugins/cloudflare-dns/tests/unit/plugin.test.ts`                        |       42 |
| `plugins/cloudflare-dns/tests/unit/risk-catalog.test.ts`                  |       38 |
| `plugins/github/tests/unit/classify.test.ts`                              |       69 |
| `plugins/github/tests/unit/data-model.test.ts`                            |        1 |
| `plugins/github/tests/unit/execute.test.ts`                               |       25 |
| `plugins/github/tests/unit/plugin.test.ts`                                |       14 |
| `plugins/github/tests/unit/risk-catalog.test.ts`                          |       56 |
| `plugins/github/tests/unit/token-cache.test.ts`                           |        5 |
| `plugins/gmail/tests/unit/classify.test.ts`                               |      105 |
| `plugins/gmail/tests/unit/data-model.test.ts`                             |        5 |
| `plugins/gmail/tests/unit/plugin.test.ts`                                 |       26 |
| `plugins/gmail/tests/unit/q-parser.test.ts`                               |       32 |
| `plugins/gmail/tests/unit/risk-catalog.test.ts`                           |       45 |
| `plugins/railway/tests/unit/classify.test.ts`                             |       22 |
| `plugins/railway/tests/unit/data-model.test.ts`                           |        1 |
| `plugins/railway/tests/unit/plugin.test.ts`                               |       30 |
| `plugins/railway/tests/unit/policy.test.ts`                               |       39 |
| `plugins/railway/tests/unit/risk-catalog.test.ts`                         |       19 |
| `plugins/resend/tests/unit/classify.test.ts`                              |       64 |
| `plugins/resend/tests/unit/data-model.test.ts`                            |        6 |
| `plugins/resend/tests/unit/mission-evaluation.test.ts`                    |       15 |
| `plugins/resend/tests/unit/plugin.test.ts`                                |       43 |
| `plugins/resend/tests/unit/risk-catalog.test.ts`                          |       33 |
| `plugins/ssh/tests/unit/adversarial.test.ts`                              |      181 |
| `plugins/ssh/tests/unit/classify.test.ts`                                 |       90 |
| `plugins/ssh/tests/unit/data-model.test.ts`                               |        2 |
| `plugins/ssh/tests/unit/host-key-pinning.test.ts`                         |       37 |
| `plugins/ssh/tests/unit/plugin.test.ts`                                   |      299 |
| `plugins/stripe/tests/unit/classify.test.ts`                              |       48 |
| `plugins/stripe/tests/unit/data-model.test.ts`                            |        8 |
| `plugins/stripe/tests/unit/execute.test.ts`                               |       23 |
| `plugins/stripe/tests/unit/plugin.test.ts`                                |       31 |
| `plugins/stripe/tests/unit/policy.test.ts`                                |       30 |
| `plugins/stripe/tests/unit/risk-catalog.test.ts`                          |       20 |
| `plugins/supabase/tests/unit/classify.test.ts`                            |      109 |
| `plugins/supabase/tests/unit/data-model.test.ts`                          |        1 |
| `plugins/supabase/tests/unit/execute.test.ts`                             |       35 |
| `plugins/supabase/tests/unit/mission-evaluation.test.ts`                  |       34 |
| `plugins/supabase/tests/unit/plugin.test.ts`                              |       22 |
| `plugins/supabase/tests/unit/risk-catalog.test.ts`                        |       44 |
| `plugins/upstash-redis/tests/unit/classify.test.ts`                       |       30 |
| `plugins/upstash-redis/tests/unit/command-table.test.ts`                  |       88 |
| `plugins/upstash-redis/tests/unit/data-model.test.ts`                     |        1 |
| `plugins/upstash-redis/tests/unit/execute.test.ts`                        |       11 |
| `plugins/upstash-redis/tests/unit/plugin.test.ts`                         |       24 |
| `plugins/upstash-redis/tests/unit/policy.test.ts`                         |       24 |
| `plugins/upstash-redis/tests/unit/risk-catalog.test.ts`                   |       49 |
| `plugins/vercel/tests/unit/binding.test.ts`                               |       49 |
| `plugins/vercel/tests/unit/classify.test.ts`                              |       42 |
| `plugins/vercel/tests/unit/data-model.test.ts`                            |        1 |
| `plugins/vercel/tests/unit/firewall.test.ts`                              |       11 |
| `plugins/vercel/tests/unit/plugin.test.ts`                                |       33 |
| `plugins/vercel/tests/unit/risk-catalog.test.ts`                          |       55 |
| `plugins/vercel/tests/unit/team-pin.test.ts`                              |       99 |
| **TOTAL** (`npm run test`, 2026-10-13, after a build; 182 files)          | **4415** |

Nothing is skipped after a build. Without `.next/standalone` the five
standalone tests (`standalone-native-addons` 3, `standalone-plugin-catalogs` 2) skip; `npm run ci` builds first, so they run there. Each plugin has one
classifier suite, `classify.test.ts`, on its v5 entry point
`classify(tool, args, resources)`, and its adapter scenarios in
`execute.test.ts` / `plugin.test.ts` on `plugin.execute` with `mockFetch`.
The plugins with env-scoped risks or a binding to enforce also carry a suite
that evaluates calls through the real catalog and the policy engine
(`policy.test.ts`, `mission-evaluation.test.ts`, and the per-concern suites
listed under "Scenarios — Provider plugins").

## Run

```bash
npm run test                              # full suite, headless
npm run test:watch                        # file-watcher mode for local dev
npx vitest run packages/policy-engine     # one package
```

## Scenarios — Policy engine

> Covers: `docs/spec/gateway-risk-model.md` §3 (DSL), §4 (catalog), §8
> (runtime). Handbook [[policy-engine]]. The package is a dependency of
> gateway-core and the plugin SDK.

`packages/policy-engine/tests/unit/`.

- **`slice-dsl.test.ts`** — `parseSlice` happy path and every error branch
  (missing provider/action, invalid action, unterminated bracket, empty
  bracket, double dot, list with empty entry); `serializeSlice` round trip
  (simple, glob, list, wild-rec, the canonical examples of the spec).
- **`slice-matcher.test.ts`** — `matches` simple/wild/list/glob, `covers`
  (`**` vs `*` partial order), symmetric `intersects` with glob × glob,
  asymmetric cases on `wild-rec`; glob charset regression (`release-*`
  matches `release-1.2`: the parser and the glob share one identifier
  charset).
- **`risk-evaluator.test.ts`** — `risksTouchedBy` (code read, feature
  branch, merge-protected + fallback, branch protection, provider mismatch
  → empty), `risksTouchedByAll` (deduplicated union, stable order),
  `indexCatalog` (rejects a pattern of the wrong provider and an
  unparseable one), `findRiskEntry`.
- **`risk-policy.test.ts`** — `checkAcceptableInEnv` (no env, env not in
  the list, ok) + `prepareCatalog` (duplicate id, regex failure, fallback
  warning through the injectable `warn`, `hasFallbackRisk`).
- **`risk-runtime.test.ts`** (25) — `evaluateCall` allow (feature branch
  alone, an uncategorized write needing the fallback and only it, read
  code), deny (missing risk, explicit deny, empty slices, no catalog match),
  multi-slice (all risks covered, one missing fails), env qualification
  through `resourceEnvResolver` (staging vs prod resource), the unqualified
  mode named by `envResolver: 'unqualified'` and never inferred from which
  resolver object is passed, every denial carries
  `code: 'risk-not-accepted'`, `evaluateCallSimple` happy path.
  **Regression block — an env-scoped risk touched outside its acceptable
  environments refuses the call**: on a labelled resource the specific risk
  is required on top of the broad one; on a resource with no label, or a
  label outside `acceptable_in_envs`, a broad co-touched risk no longer
  carries the call alone; a multi-slice call is refused whole; holding the
  unqualified id does not open an unlabelled resource; the same slices pass
  where every touched risk is acceptable and accepted.
- **`qualify.test.ts`** (29) — `isEnvScopedEntry` (true when
  `acceptable_in_envs` is non-empty), `qualifyRiskId` (injects `[env]`
  before the first `.`, idempotent, no-op when account-scoped, env-scoped
  cases via `test.each`), `unqualifyRiskId` (strip + idempotent), round-trip
  property, `resourceEnvResolver` / `noEnvResolver` (ref match, provider
  mismatch, no env label), `resolveVector` (the override of the env replaces
  its axes, the others inherit, the base vector is not mutated).
- **`budget.test.ts`** (25) — the one budget rule every catalog reader
  shares: `isPositiveInteger`; `budgetIssues` accepts a legal budget with
  either gate, refuses a quota that is infinite, zero, negative, fractional,
  `NaN` or not a number, a rate limit that is not `{ max, window_seconds }`
  of positive integers, and any gate outside the closed set, listing every
  illegal field in field order; `ratePerMinute` / `exceedsRateCeiling`
  (normalised to one minute, strictly above the ceiling only).

## Scenarios — Plugin SDK

> Covers: `docs/spec/vaubaan-gateway.md` §5 (plugins), §3.2 (presets), §10
> (structural tests: at least one preset per plugin, every preset entry a
> risk of its own catalog, never a wildcard). ADR
> [[plugin-contract-and-credential-spec]]. Handbook [[plugin-sdk]].

`packages/plugin-sdk/tests/unit/`. The template plugin's own suite is under
"Scenarios — Provider plugins".

- **`catalog-loader.test.ts`** — loads the `acme` fixture YAML (provider,
  `catalog_version`, date scalar kept as a string, optional fields,
  presets with default gate); collected, path-qualified errors: duplicate
  id, malformed id, id of another provider, malformed slice pattern,
  missing fallback (error, or accepted with `requireFallback: false`),
  zero presets (error, or accepted with `requirePresets: false`), preset
  entry referencing a foreign or unknown risk, env-qualified entry on a
  non-env-scoped risk or outside `acceptable_in_envs`, wildcard or
  sentinel in a preset entry (`wildcardIssues`: risk ids and preset entries
  each reported by their own rule), non-integer budget or unknown gate,
  an unknown key inside `rate_limit` reported at its path, a preset id
  declared twice or a risk repeated inside one preset, `caps` and
  `infra_limits` parsed into typed values (known keys, positive integers),
  a vector that must name its six axes while an override may name a subset
  (`isCompleteVector`),
  deprecated risk in a preset, unknown keys and bad enum values, provider
  slug, YAML syntax error naming the source; the fallback rules (exactly
  one entry by flag, pattern or id, which must match the catch-all write
  whatever made it the fallback; the `uncategorized-` id convention needs
  its dash; `fallback: false` opts out; a preset
  entry on the fallback is an error; an entry recognised by convention
  without `fallback: true` loads with a warning through `warn` and is
  still indexed as the fallback).
- **`registry.test.ts`** — ids in registration order, `has/get/require`,
  `providerForTool` (exact name, prefix rule for unlisted tools, null),
  `toolDeclarations`, `labels` (with `experimental`), `idEnum` (non-empty tuple, throws when
  empty), `catalogOf` indexed, `presetsOf`; conflicts: same id twice, tool
  outside the plugin prefix, ill-formed plugin reported with its id.
- **`define-plugin.test.ts`** — fixture well-formed and frozen; every issue
  collected (id grammar, semver, tool prefix and duplicates, data-model
  and catalog provider mismatch); catalog rules through the definition;
  data-model referential integrity; credential spec rules per kind
  (api-key secret field, oauth2 https + PKCE for public clients +
  `refreshable` needs `refresh()`, app-install, ssh-key, unknown kind);
  the `app-install` `userVerification` block (well-formed with and without
  pagination, every malformed member named by path, `client_id` /
  `client_secret` required among the app settings);
  missing functions; `expectCredentialKind`; `normalizeArgsIfEnabled`
  (off by default, on with the flag, no hook no change); **budget rules on
  a TypeScript catalog**: a preset entry with an infinite quota, a negative
  rate or an unknown gate is refused like its YAML twin, every illegal value
  of one entry listed.
- **`testing-kit.test.ts`** — `assertCatalogCoverage` on the fixture
  (touched risks in catalog order; `risksUntouched` leaves the fallback
  out — reachable by design only; `fallbackHits` names the samples only
  the fallback covered), every failure branch (tool without sample, sample
  for an undeclared tool, unexpected denial, expected denial not met, no
  slice, foreign provider, slice no risk matches), `PluginAssertionError`
  with every finding; `assertNoWildcard` on lists, catalogs and plugins;
  `assertPresetsValid`; `assertPluginWellFormed` (definition issues plus
  the fallback flag: a catch-all recognised by convention only fails);
  `mockFetch` (routes by method / URL / predicate, recorded calls, `times`,
  unmatched request rejects).
- **`catalog-path.test.ts`** — `catalogPathNextTo`: default file name,
  `URL` input, the fixture resolving to a readable file, the two Turbopack
  rewrite shapes raising the named error.
- **`env-of.test.ts`** — `envFromSliceSegment`: the identifier after the
  named entity, `undefined` on wildcards, lists, absent or terminal
  segment, no confusion with an identifier equal to the entity name.

## Scenarios — Shared

> Covers: `packages/shared/src/` — the risk-id grammar, the MCP tool-name
> convention and the eight refusal codes (`vaubaan-gateway.md` §4.1, §6),
> the token format, the session event details, the data-model check. Suites
> co-located with the source.

- **`risk-id.test.ts`** (20) — `parseRiskId` both forms, hyphenated provider
  and dotted name, eleven malformed inputs rejected; `formatRiskId`
  round-trip and null/empty env; `baseRiskId`; `isProviderId`;
  `isExplicitRiskId` (wildcards rejected).
- **`mcp.test.ts`** (10) — `toolPrefixFor` / `splitToolName` (hyphen ↔
  underscore, first separator only, malformed names); the eight refusal
  codes of spec §4.1 and §6; `isRefusalCode`.
- **`api-key.test.ts`** (9) — `generateApiKey` for `live` and `test`
  (`vbn_live_<8>_<32>` / `vbn_test_<8>_<32>`, the prefix being part of the
  key); `parseApiKey` tells the two kinds apart and rejects the retired
  `vbn_mgmt_` prefix, an unknown prefix, wrong lengths and a prefix or a
  secret outside base62; `hashApiKey` / `verifyApiKey` round trip, a key
  with one more character refused, `false` on a hash it cannot read.
- **`session-events.test.ts`** (22) — `parseEventDetails`, the one parser
  of the typed union of session event details: every kind that carries
  details is read from a well-formed sample (allowed and refused call,
  dropped and closed request, period reset, quota and expiry extension,
  rotation, revocation) and answers `null` for a malformed one; a kind
  without a details shape and a stored value that is not an object answer
  `null`; keys the shape does not name are ignored; the two shapes of an
  extension are told apart on their dimension.
- **`data-model.test.ts`** (4) — `validateDataModel`: a consistent model has
  no error; an orphan parent is reported with provider, plane and entity; a
  parent declared in another plane does not count; every orphan is listed.

## Scenarios — Provider plugins

> Covers: the ten handbooks under
> [`docs/handbook/providers/`](../handbook/providers/README.md) and
> [[plugin-sdk]]. Spec: `vaubaan-gateway.md` §5 (plugins), §3.2 (presets),
> §10 (structural tests); `gateway-risk-model.md` §7. ADRs
> [[plugin-contract-and-credential-spec]],
> [[plugin-catalog-path-and-standalone-tracing]],
> [[fallback-risk-only-when-uncategorized]].

Every plugin runs the SDK kit in `tests/unit/plugin.test.ts`
(`assertPluginWellFormed` — including the `fallback: true` flag —,
`assertPresetsValid`, `assertNoWildcard`, `assertCatalogCoverage` with one
realistic sample per declared tool; `risksUntouched` is asserted and
`fallbackHits` is empty) and exercises `execute` and `discoverResources`
against `mockFetch`, which rejects any unmatched request. **No test ever
reaches a provider.** Each plugin's `classify.test.ts` pins the
`(tool, args, resources) → slices` contract of its classifier, case by case.
The suites named `policy`, `mission-evaluation` and the like go one step
further: they run `classify` then `evaluateCall` on the shipped catalog, so
what they assert is the decision a mission gets — in particular that a
classifier **fails closed** (what it cannot place is refused or costs every
class, never the cheapest one) and that an env-scoped risk is refused on a
resource without a usable environment label. Counts per plugin are the
`plugins/<id>` totals of the table above.

**Template** (18) — `plugin.test.ts`: the kit on the scaffold (every named
risk touched), a classifier case per convention (ref from the arguments,
single-resource default, ambiguity denied, a workspace outside the mission's
resources refused by `classify` and by `execute` through the one shared
resolver), `execute` against `mockFetch`, the catalog path resolved with
`catalogPathNextTo` and present on disk.

**GitHub** (170) — `plugin.test.ts` (14): structural kit (26 tools, the 14
named risks touched), the fallback lint, presets `read-only` / `developer` /
`release-manager`, the `app-install` credential spec with its five app
settings and the declarative `userVerification` (GitHub token endpoint,
`GET /user/installations`, 100 per page). `execute.test.ts` (25):
installation token minting (JWT → `access_tokens`), per-call repository
scoping, Octokit dispatch over the injected fetch, `UpstreamAuthError`,
`github__mint_install_token`, paged resource discovery; **the merge is bound
to the declared base** (the pull request is read first and a real base other
than the declared one is refused without merging), and `push_files` reads
`files` like the classifier. `classify` (69): every tool's slices, the
multi-slice tools, the `workflow-via-file` slice, retired tools, structural
denials, and 34 cases of **what it cannot place exactly** (non-canonical
workflow paths, `refs/…` branch names, malformed identifiers), all refused.
`risk-catalog` (56): one `[tool, args, risks]` row per call shape, evaluated
through the shipped catalog — the risks each tool touches, exactly.
`token-cache` (5), `data-model` (1). No `envOf`: the catalog has no
env-scoped risk.

**Vercel** (290) — `plugin.test.ts` (33): kit (31 tools; every named risk
touched but `toolbar-write`, unreachable while the thread tools are
refused), project resolution against the mission's resources, `vercelEnvOf`
and the plugin's `envOf` composed with `envResolverFor` (the slice's
`env[prod]` wins over an owner label, an env-less slice falls back to it),
`api-key` credential spec, `execute` (rewrap of mcp.vercel.com and the
custom REST tools) and `discoverResources` against `mockFetch`.
`risk-catalog` (55): YAML structural validation, every pattern parses,
coverage lint, saliency checks. `classify` (42): per-tool slices,
`deploy_to_vercel` always on `env[prod]` whatever `target` says, the env-var
fan-out, one spelling per argument. `binding.test.ts` (49): **a
deployment- or URL-addressed tool runs only on a deployment of the mission's
project** — a foreign deployment is refused and nothing reaches the
provider; the thread-addressed toolbar tools, which cannot be bound to a
project, are denied by the classifier. `team-pin.test.ts` (99): **every
request carries the team of the credential** and a `teamId` argument that is
not exactly that team is refused, for every declared tool (the sample table
is the tool list; the tools that cannot carry a team are reviewed one by
one). `firewall.test.ts` (11): slices, risks and request shapes of the
firewall tools. `data-model` (1).

**Supabase** (245) — `plugin.test.ts` (22): kit with one sample per tool
(44 tools; `row-write-one` and `auth.bulk-user-write` knowingly unreached),
presets, `oauth2` credential spec (PKCE, Basic client auth, `refreshable`
with no plugin `refresh`), `execute` (read-only `execute_sql`) and
`discoverResources` against `mockFetch`. `risk-catalog` (44): loaded shape,
posture-sensitive entries, coverage lint, cardinality mutual exclusion,
decision-level spot checks. `classify` (109), of which 74 on **the SQL of
`apply_migration`**: the reader is an allow-list of statement shapes — plain
DDL stays on the schema write, row writes, drops, RLS, privileges and
extensions each add their risk, and anything it cannot read statement by
statement needs every write class. `execute` (35): Management API and
data-plane request shapes, and **the target project resolved exactly as the
classifier resolves it** (a non-string `project_ref`, an alias spelling).
`mission-evaluation.test.ts` (34): on a project **without an environment
label** every write and the user listing are refused whatever the mission
holds, account-scoped reads stay allowed; on **prod**, a migration embedding
DML, dropping a table or unreadable is refused, a plain DDL migration needs
`migration-write` only; the three presets decided call by call on labelled
projects (`migration-operator`: any migration on staging, plain DDL and RLS
only on prod, behind an approval). `data-model` (1).

**Railway** (111) — `plugin.test.ts` (30): kit (the nine named risks
touched, no fallback hit), `classifyRailway` on `Resource[]` (project and
environment resolution, denials), `oauth2` credential spec (PKCE,
`resourceIndicator`, `prompt=consent`, no plugin `refresh`), `executeRailway`
(rewrap of mcp.railway.com with the stripped tool name, GraphQL variable
tools) and `discoverRailwayResources` against `mockFetch`. `risk-catalog`
(19): shape, `prepareCatalog`, runtime `risksTouchedBy`, variable writes as
classified, coverage. `classify` (22): a write of named variables is
`service-var[K1,…].W`; `replace=true` adds the marker
`service-var-replace.W`. `policy.test.ts` (39): a single variable write
touches `upsert-variable` alone and only a replace touches
`bulk-variables-replace`; each preset decided per call and per environment;
**`list-variables` with the read-only preset is refused on a prod, an
unlabelled and a free-text-labelled project**; an `environmentId` must
belong to the resolved project (`accept-deploy`, `redeploy`, the agent
tool). `data-model` (1).

**SSH** (609) — `plugin.test.ts` (299): kit (every catalog risk touched by
one `ssh__exec` sample); `classifySsh`: host resolution against the
mission's resources (single host default, explicit ref, foreign / ambiguous
/ malformed denied), read vs write, `secret-file` marker, `destructive` /
`package` / `service` / `privilege` markers, `sudo` on a whitelisted verb
stays a read, mixed lines touch both sides, a redirection to a file is a
write while `2>&1` is not, **a line that cannot be seen through carries
every class and is never a read**; runtime qualification through
`resourceEnvResolver` (`ssh[prod].exec-destructive` missing → denied; a
write on an unlabelled or free-text-labelled host is refused whatever the
mission accepts); **the presets evaluated through the policy engine** (55:
what `read-only`, `developer` and `operator` allow, gate and refuse per
environment, wrappers and spellings included); `splitCommandLine` and
`lexCommandLine` (words as the shell builds them, what it cannot see
through is named); the read allow-list matching whole argument vectors (71)
and the command-class tables (127: `isDestructive`, `isPackageInstall`,
`isServiceControl`, privilege wrappers with their options); credential spec
(`ssh-key`, four fields with patterns, `sshTarget` narrowing and refusals);
`fingerprintOf` / `hostKeyMatches`; `execute` and `discoverResources` over a
fake `SshTransport`. `adversarial.test.ts` (181): **command lines built to
fool the classifier fail closed** — comment and quote tricks, ANSI-C
quoting, substitutions, here-documents, control characters, inline
interpreters, unknown wrappers and other hosts are classified as every
class (129 lines), conservative shapes stay conservative and plain shapes
stay plain (51), a line without a command is refused.
`host-key-pinning.test.ts` (37): **the real `ssh2` transport against an
in-process ssh server on loopback** — the matching pin connects and runs the
command; a pin of another key, or one that is absent, empty, blank,
malformed, truncated, in another case, MD5 or not a string never
authenticates (no socket for a target without a usable pin); there is no
trust on first use; `execute` and `discoverResources` refuse a credential
without a normalised SHA256 pin before the transport. `classify` (90),
`data-model` (2). No test reaches a real host.

**Resend** (161) — `plugin.test.ts` (43): kit (the two deprecated v4 ids
knowingly unreached), the `from` domain as the resource, recipient zones
(a single send is its zone slice, never a count marker), batch sends,
domains / segments / contacts, broadcasts verified against the named
segment, misc denials, `execute` (only the declared fields of a tool reach
Resend) and `discoverResources` against `mockFetch`, `api-key` credential
spec and presets `read-only` / `developer` / `marketing-operator` /
`domain-admin`. `risk-catalog` (33): shape (the bulk entries declare only
the rate ceiling the gateway enforces, exact irreversible set, only the
exfiltration risk env-scoped, no preset on the fallback, the two deprecated
v4 ids) and slice → risk resolution. `classify` (64), of which 21 on
**fields that would escape the classification** (`To` / `Cc` / `Bcc`
envelope headers and the like, refused). `mission-evaluation.test.ts` (15):
an external-unbounded send from a prod or unlabelled domain is refused
whatever the mission accepted, one external recipient among internal ones is
enough, a mixed batch is refused whole; each shipped preset decided call by
call. `data-model` (6).

**Upstash Redis** (227) — `plugin.test.ts` (24): kit with one sample per
tool (21 tools, every named risk touched, no fallback hit), presets,
database resolution against the mission's resources (single-database
default; ambiguous, missing, foreign or malformed refused; account-level
tools need none), environment from the owner label of the database
resource, `api-key` credential spec (`email` non-secret, Management API key
secret), `execute` (Basic auth on the Management API, REST tokens redacted,
the data tools read `rest_url` + `rest_token` then POST the command,
refusals before any network call, 401/403 → `UpstreamAuthError`) and
`discoverResources` (one resource per database, no token in the metadata,
200 cap with a warning) against `mockFetch`. `risk-catalog` (49): YAML
validation, pattern parsing, coverage lint, saliency checks.
`command-table.test.ts` (88): **every Redis command sits in exactly one
class** (the six sets are pairwise disjoint, no deleting command is a plain
write or a read); `execute` with one command, a pipeline or a
`MULTI` / `EXEC` body costs the union of its commands; an unknown command
is arbitrary execution; the dedicated tools cost what the same command
costs through `execute`. `policy.test.ts` (24): every write is refused on a
database with no label or a label the catalog does not list, reads pass;
the three presets per environment (`DEL` needs `delete-data` through either
tool). `classify` (30), `execute` (11), `data-model` (1).

**Stripe** (160) — `plugin.test.ts` (31): kit (every named risk touched, no
fallback hit), resource resolution and `modeOf` (ref suffix, metadata; the
env label is never a source of the mode), argument handling, `execute`
(form-encoded REST v1) and `discoverResources` (one resource per mode)
against `mockFetch`, `api-key` credential spec. `risk-catalog` (20): 16
named risks + fallback at catalog v3, every risk env-scoped on the mode, no
preset carries the fallback, the money-out risks carry the rate ceiling and
no cap the door does not enforce, slice → risk resolution including the
`payment-intent.W` side effect of `create_subscription` resolving to
`subscription-create` and a novel write to the fallback alone. `classify`
(48), `execute.test.ts` (23: only declared arguments reach Stripe).
`policy.test.ts` (30): **an argument that changes the nature of the call
costs the stronger risk** (`cancel_at*` → `subscription-cancel`,
`auto_advance` → `invoice-finalize`); **customer data is not reachable with
`read-billing-history` alone** (invoices, charges, payment intents and
events need `read-customer-pii`; `expand` and any undeclared argument are
refused); a resource with no resolvable mode, or a label contradicting the
key's mode, is refused; the three presets on their mode and nothing on the
other. `data-model` (8).

**Cloudflare DNS** (122) — `plugin.test.ts` (42): kit (15 tools, every risk
touched), zone resolution (single zone default, explicit `zone_id`, foreign
provider denied), record writes with the `critical` / `delete` overlays (an
under-specified write or deletion is critical by default),
`isCriticalRecord` / `recordSensitivity`, `execute` (a write or deletion
declared ordinary reads the record first and is refused on an apex, MX or
NS record; a path-unsafe record or zone id never reaches the API) and
`discoverResources` (one resource per zone) against `mockFetch`, `api-key`
credential spec and presets `read-only` / `dns-operator` / `zone-admin`.
`risk-catalog` (38): shape (11 named risks + fallback at catalog v2, no env
scoping, no cap), `prepareCatalog`, **every tool touches exactly its
risks**, `risksTouchedBy` sanity checks (`zone-delete` only on the zone
itself). `classify` (33), `data-model` (9).

**Gmail** (213, experimental) — `plugin.test.ts` (26): kit, the experimental
shape (`experimental: true`, version below 1.0, no tool exposed), coverage
through a tool-exposing variant of the plugin
(`draft-to-zone-external-unbounded` and `bulk-label-write` knowingly
unreached), mailbox selection (none, foreign, ambiguous), `oauth2`
credential spec (Google, PKCE, `client_secret_post`, offline consent, no
plugin `refresh`), `discoverResources` and the structured `not_implemented`
answer of `execute` against `mockFetch`, presets `read-only` / `developer`.
`risk-catalog` (45): loaded catalog lint, pattern parsing, per-tool
coverage, `risksTouchedBy` spot checks. `classify` (105): a search bounded
by a positive `from:` is its zone, **a query the parser cannot bound is the
unknown zone plus the bulk marker**, sensitive labels fail closed on reads,
a draft to an external recipient or to a recipient that cannot be parsed is
refused, label tools need well-formed ids. `q-parser` (32, unions and
groupings reported, never read as a conjunction), `data-model` (5).

**Structural — `apps/gateway/tests/unit/structural/catalog-caps-enforced.test.ts`**
(12) — ADR [[scope-caps-not-enforced-in-v5-0]]: the v5.0 door has no cap
stage, so none of the ten shipped catalogs may declare a `caps` block or an
infra limit the gateway does not enforce (one test per plugin); the check
itself flags both and lets the rate ceiling through, and its list of
enforced limits is pinned to what the code enforces today.

## Scenarios — gateway-core

> Covers: handbook [[gateway-core]]. Spec: `vaubaan-gateway.md` §4.1, §6,
> §8, §10 ("structured refusals", "credential separation");
> `gateway-risk-model.md` §8.

`packages/gateway-core/tests/unit/`, vitest, no network, no store.

- **`risk-gateway.test.ts`** (9) — the pure decision core
  `evaluateCallForToken`: allow, deny with missing risks and
  `code: 'risk-not-accepted'`, classify-denied, no-catalog (fail closed),
  denied_risks shadow, the classifier receives `(tool, args, resources)`,
  environment qualification from the adapter's `envOf` first (a derived
  env wins over the owner label, an abstaining hook falls back to it), then
  the mission's resources, and an explicit `envResolver` overriding both;
  `envResolver: 'unqualified'` names the test mode without a resolver;
  `denied_risks` may be left out (a v5 mission carries none).
  The decision is
  unchanged since v4; its inputs are the v5 `Resource[]` and the plugin's
  `classify` (P0.R).
- **`errors.test.ts`** (28) — the eight refusal codes: exactly eight in
  `REFUSAL_CODES`, one builder sample per code, every field of every code,
  `hint` non-empty and serializable, `isRefusal` guard, JSON-RPC mapping
  (`-32603`, refusal in `data`, code in the message).
- **`fingerprint.test.ts`** (8) — the one argument hash (audit entry,
  approvals): recursive key sorting, arrays in order, `undefined` dropped,
  `toJSON`, BigInt refused, known sha256 vector, key order vs one-byte
  change, null/undefined ≡ `{}`, 64 hex.
- **`audit.test.ts`** (2) — `MemoryAuditWriter` over call and administrative entries; a call entry
  carries every spec §8 field.
- **`cache.test.ts`** (7) — `MemoryCacheClient`: TTL expiry, delete, bound
  evicts the oldest, re-set refreshes age, expired swept before a live
  eviction, invalid bound rejected, a TTL that is not a positive finite
  number caches nothing.
- **`authenticate.test.ts`** (11) — credential separation: door table,
  `checkDoor` on every mismatch (mission token at management, delegated
  token at execution, session at either) → `wrong-credential-kind` with
  door/presented/expected; `parseBearer`; `DoorAuthenticator` end to end;
  unknown bearer → `AuthError`, not a refusal.
- **`pipeline.test.ts`** (27) — `checkMissionActive` (status, passed and
  future `expires_at`, **an unreadable `expires_at` is expired: the check
  fails closed**), `checkConnectionAvailable`; `CallPipeline` over a
  context built from the shared types (`ConnectionResource`, policy entry
  list, one-off period): happy path with the full audit entry, inactive
  mission refused before anything else, `resource-not-in-mission` before
  any risk evaluation, expired connection, `risk-not-accepted` through the
  real decision core fed with the resources of the target connection and
  the budget untouched, structural rejections without a code, budget
  refusal with no upstream call, approval id carried to the audit, upstream
  failure after allow (`decision: allowed`, `upstream_error`, no refusal),
  `UpstreamRefusalError` (entry still `allowed`, `upstream_error` prefixed by
  the code, the outcome carries the refusal), a call with no target rejected
  before any risk with no code. **The audit never stores the provider's
  text**: `UpstreamFailureError` puts a host-built summary in the entry and
  the detail in the outcome, the message of a plain error never reaches the
  audit, the stored summary is bounded and `upstreamErrorClassName` is an
  identifier, never free text. **An audit write that fails after a
  successful forward is not recorded as an upstream failure** and
  propagates, as it does after an upstream failure.
  The real stages — resource, risk, upstream — and the door are tested in
  "Scenarios — Execution door" below; the budget stage in "Scenarios — Budget
  and sessions".

## Scenarios — Instance configuration, crypto, composition root

> Covers: spec §4.3 (instance configuration, admin rule), §6 (encryption
> at rest, no secret in logs), §10 structural "no configuration value is
> hard-coded". Handbook [[configuration]], ADR
> [[docker-image-and-config-format]]. Co-located under
> `apps/gateway/src/server/**` unless a path says otherwise.

- **`config/load.test.ts`** (37) — minimal env-only configuration with
  defaults; every missing required key named at once with its variable(s);
  `public_url` http refused, non-URL and query string refused, trailing
  slash stripped, sub-path kept; master key length / base64; bootstrap
  token length; trusted proxies IP/CIDR; durations, integers, booleans,
  log level; **admin rule** (group alone, emails alone lower-cased, both,
  neither → error naming both variables, non-email); IdP block optional
  → bootstrap required, configured → bootstrap optional with default
  claim mapping, partial block names the missing sub-keys, https issuer,
  claim mapping and allowed domains; provider apps from
  `VAUBAAN_PROVIDER_<ID>_<FIELD>[_FILE]` including hyphenated ids, unknown
  field refused in env and YAML; YAML `${VAR}` / `${file:}` resolution,
  **file wins over env key by key**, unset reference and missing secret
  file named, missing / invalid / non-mapping file, empty file,
  `previous_keys` duplicate version, `*_FILE` alone and both-set error; a
  master key is registered with the redactor in the form it was configured
  in; **the example YAML is fully commented out** — it parses to an empty
  document and, copied as is, overrides nothing from the environment.
- **`config/duration.test.ts`** (2) — `30s 10m 24h 7d`; rejects the rest.
- **`crypto/aead.test.ts`** (12) — round trip and `keyVersion` stamp, fresh
  nonce, **AD mismatch** (other connection id) fails, tampered blob,
  short blob, unknown format byte, empty and unicode plaintext, empty
  connection id; **`key_version` honoured**: v2 encryptor opens v1 blobs
  through `previous_keys`, seals with v2, v1 cannot open v2, unknown
  version names `encryption.previous_keys`, right version wrong key fails;
  `deriveConnectionKey` deterministic and distinct per id and per master
  key.
- **`logging/logging.test.ts`** (6) — mission token prefix kept, secret
  dropped; configured secrets replaced longest-first and JSON-escaped;
  empty secrets ignored; JSON line shape with bindings; a field named
  `time`, `level` or `msg` does not overwrite the line's own; level
  threshold and stderr routing.
- **`compose/compose.test.ts`** (16) — `buildRoot` from configuration
  alone over the `:memory:` store (schema version 4, the shipped registry); the store
  receives the root's encryptor and a `RegistryCatalogIndex` (base ids,
  env-qualified ids within `acceptable_in_envs`, unknown provider,
  wildcard refused) and is closed with the root; with an injected empty
  registry, provider apps are a warning; with plugins registered, a
  provider app for an unknown plugin is a `ConfigError` naming
  `providers.<id>` and `VAUBAAN_PROVIDER_<ID>_*` (exit 78); `checkProviderApps` passes on matching or absent apps; no secret in
  the boot log; `getRoot` builds once and shares the promise, forgets a
  failed build; `bootOrExit` exits 78 naming the key, 1 on other failures,
  nothing on success; `MemoryRateLimiter` window and reset,
  `MemorySessionStore` (unknown or expired session); **a step that throws
  after the store is opened** closes the store handle and stops the timers
  already started, then rethrows, and a root that builds stops its timers
  and closes the store once on `close()`.
- **`http/healthz.test.ts`** (4) — 200 with build stamps and store kind
  (`memory`) and no configuration value, 503 degraded on store ping
  failure, 503 unavailable when the root cannot be built; the handler needs
  only the store liveness, a logger, the build stamps and the start time.
- **`http/client-ip.test.ts`** (11) — the one trusted-proxy / client-address
  rule (`clientIpResolver`), used by the request page limit and by the
  door's token-verification throttle: `X-Forwarded-For` ignored when no
  proxy is trusted (one shared key), the right-most hop that is not a
  trusted proxy, a forged left-hand entry not believed, `unknown` when every
  hop is trusted or the header is absent, a malformed hop stops the walk,
  IPv6, ports and brackets, invalid or out-of-family `trusted_proxies`
  entries skipped instead of trusting more; `isTrustedProxyEntry` accepts
  exactly what the matcher keeps.
- **`tests/integration/compose/boot.test.ts`** (4) — the production
  wiring against a temporary SQLite file: the database is created, the
  migrations applied (`schema_version` 4, four `schema_migrations` rows),
  the store pings and `/healthz` reports `{ kind: 'sqlite', status: 'ok' }`,
  the boot log carries `store opened`; a store secret is sealed with the
  encryptor built from the configuration (blob not clear text, current
  `key_version`) and reopens after a second boot without re-migrating; a
  risk id the registry does not know is refused
  (`UnknownRiskIdError`); an unreadable `store.path` exits 1 with a
  message naming `store.path` and `VAUBAAN_STORE_PATH`.
- **`apps/gateway/tests/unit/structural/no-hardcoded-config.test.ts`**
  (one test per scanned file; the count is in the table above) — no literal URL, Supabase ref, GitHub /
  Stripe / mission token, private key or JWT in the whole application
  (`apps/gateway/src`, `next.config.ts`), `deploy/`, `scripts/`,
  `.github/workflows`; only `telemetry-default.ts` and
  `deploy/config/*.example*` are exempt.
- **`apps/gateway/tests/unit/structural/example-config-providers.test.ts`**
  (10) — the deployment examples show the provider apps the shipped plugins
  take, and nothing else: every provider block of `gateway.example.yaml` and
  every `VAUBAAN_PROVIDER_*` variable of `.env.example` is one a plugin
  declares, the two examples show the same providers, commented and active
  lines are read alike; the checks themselves refuse a provider that takes
  no app, an unknown provider, an undeclared field and a missing required
  one.
- **`apps/gateway/tests/integration/standalone-native-addons.test.ts`** (3)
  — reads the build output and is skipped when `.next/standalone` is
  absent (CI builds before testing): the `/healthz` route handler trace lists
  the `argon2` and `better-sqlite3` `.node` binaries; a Node process started
  inside the standalone tree resolves both packages from the standalone
  `node_modules` (not the repository's), hashes with argon2 and runs a query
  on an in-memory SQLite database.
- **`apps/gateway/tests/integration/standalone-plugin-catalogs.test.ts`**
  (2) — same skip rule: the template's `risk-catalog.yaml` is traced into
  `.next/standalone` next to its module, and so is every
  `plugins/<id>/src/risk-catalog.yaml` of the repository (the list is read
  from the `plugins/` directory; none may be missing). ADR
  [[plugin-catalog-path-and-standalone-tracing]].

Container smoke (`deploy/docker/smoke.sh`, CI job `docker`): see
[`e2e-tests.md`](./e2e-tests.md).

## Scenarios — Human authentication

> Covers: spec §0 (Operator, User, Group, IdP), §4.2 Administration, §4.3
> (IdP block, bootstrap token, admin rule), §6 "human authentication"
> (short sessions bound to the origin, origin check on every mutation), §7.1,
> §10 integration "simulated IdP" and structural "authority recomputed from
> current membership". Handbook [[authentication]], ADR
> [[oidc-relying-party-and-web-session]]. Co-located under
> `apps/gateway/src/` unless a path says otherwise.

- **`server/auth/claims.test.ts`** (11) — groups claim as array (trimmed,
  de-duplicated, non-strings dropped), as space/comma/semicolon delimited
  string, absent or of another type; default and custom (Entra-style)
  mapping; email lower-cased, `name` → display name; missing `sub` /
  `email` fail closed naming the claim(s) (`LoginError` `claims-missing`);
  allowed email domains (empty list = any, case-insensitive, no `@`);
  **`email_verified: false` is refused** with its own closed code, whatever
  claim the email is mapped from, while a verified email and an IdP that
  does not send the claim pass.
- **`server/auth/admin-rule.test.ts`** (5) — group match, email match
  (case-insensitive), neither, either half of a combined rule,
  `describeAdminRule` without secrets.
- **`server/auth/origin.test.ts`** (5) — matching `Origin`; another origin,
  scheme or the internal host refused; `Referer` fallback; neither header
  or `Origin: null` refused; 403 body `origin-mismatch`.
- **`server/auth/session-service.test.ts`** (7) — cookie attributes
  (`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age`), malformed values
  ignored; user session created / read / destroyed; **absolute expiry** at
  `SESSION_TTL_MS` (8 h); pending logins apart from sessions, single use,
  10-minute TTL; a stored session or pending sign-in of another shape reads
  as none and is deleted.
- **`server/auth/bootstrap.test.ts`** (3) — exact token accepted while
  active, variants refused; `unavailable` without a configured token;
  revocation persisted in `instance_config`, durable across services,
  idempotent (first timestamp kept), token refused afterwards.
- **`server/auth/idp-settings.test.ts`** (7) — none until saved, then read
  back from the store (`source: store`); client secret **sealed**
  (`secret_blob`, associated data `instance_config:idp.client_secret`);
  blank secret keeps the stored one; every problem reported at once, http
  issuer only with `allowInsecureIssuer`; file configuration wins and makes
  the service read-only; `splitList`; every key saved in one transaction (a
  failed write keeps the previous settings whole).
- **`server/auth/handlers.test.ts`** (9) — `safeReturnTo`: same-origin
  paths kept; URLs, `//host`, `/\host` and relative junk fall back, and so
  do seven shapes a browser resolves to another origin (a tab, newline,
  carriage return or NUL after the first slash, `/.//a//host`,
  `/x/..//a//host`).
- **`server/auth/guard.test.ts`** (10) — the one guard of every mutating
  handler, `guardMutation` (origin, then session, then role): another
  origin, no `Origin` and no `Referer`, an opaque `Origin` and a foreign
  `Referer` are refused **before the session is read**; a same-origin
  `Referer` stands in for a missing `Origin`; nobody → 401 whatever the
  role; the `user` role lets a user through, operator or not, and not the
  bootstrap operator; the `operator` role follows the admin rule.
  `guardSession` checks session and role without the origin (reads);
  `refusalResponse` words each refusal and is never cached.
- **`tests/unit/server/auth/mutation-guard.test.ts`** (113) — **structural:
  the guard covers every mutating handler.** Every handler of the human
  surfaces is classified and every mutating route of the app is found from
  the source and must delegate to a guarded mutation; then, table-driven
  over the 14 mutating handlers (missions preview / issue / rotate / revoke,
  request decide, connection connect / discover / revoke / resource edit,
  provider app, IdP settings, logout, bootstrap login): the rightful caller
  passes; another origin, no origin, no session, a session of the wrong role
  and a bootstrap session whose token was revoked are refused **and write
  nothing**.
- **`tests/unit/app/admin-guard.test.ts`** (24) and
  **`tests/unit/app/app-guard.test.ts`** (80) — **structural: every page and
  route authenticates itself; the layout is not the boundary.** The pages
  and routes of `/admin` and of the `(app)` surface are discovered from the
  file tree. Each admin page calls `requireOperator()` and renders nothing
  for a visitor without a session, a signed-in non-operator and a bootstrap
  session whose token was revoked; each `(app)` page calls a session helper
  before it reads anything from the root and renders nothing without a
  session or for a revoked bootstrap session; each route only delegates to
  a handler known to authenticate (401 / 403 otherwise, the bootstrap
  operator refused where a user is needed).
- **`tests/unit/app/field.test.tsx`** (6) — form labels are bound to their
  controls, rendered to static markup (no browser): `Field` with `htmlFor`
  is a real `<label for>`, a group named by its label when it holds several
  controls, no label element without a label, the error shown in place of
  the hint; `CredentialFieldInputs` binds every label, textarea included,
  with ids that stay unique when two lists share a page.- **`tests/integration/auth/oidc-login.test.ts`** (16) — the composition
  root over the `:memory:` store with the real `openid-client` relying
  party and the in-process **`FakeIdp`** (`fake-idp.ts`: discovery, JWKS,
  token, userinfo through `customFetch`; ES256 ID tokens; PKCE S256
  verified; `authorize()` plays the consenting browser), handlers driven
  with web-standard `Request`s:
  1. first sign-in creates the user (email lower-cased, display name) and
     its `idp` groups; the principal is `isOperator` through the admin
     group; `groups` scope requested because the IdP advertises it; the
     client secret never reaches the log;
  2. re-login with changed groups rewrites IdP memberships, leaves a local
     group alone, keeps the emptied IdP group's row;
  3. a claim colliding with a local group is ignored with a warning;
  4. **structural** — removed from the admin group, the next
     `authenticate()` reports `isOperator: false` and `authorizeAdmin` 403;
  5. non-admin user: 403 on `authorizeAdmin` and on the settings handler;
     no session → 401;
  6. bootstrap: `/auth/login` without IdP → `idp-not-configured`; the token
     form refused without `Origin` (403) and with a wrong token
     (`bootstrap-refused`); accepted → bootstrap session authorised on
     `/admin`; the IdP saved through the form (secret sealed, one
     `config-changed` audit entry by `bootstrap` without the secret); a
     non-operator IdP sign-in leaves the token active; the first operator
     sign-in revokes it (`bootstrap.revoked_at`, log line); then the form
     answers `bootstrap-unavailable`, `verify()` is false and the stale
     bootstrap session is 401 and deleted;
  7. the callback URL is built from `public_url` even when the request
     arrives on `http://127.0.0.1:3000`;
  8. tampered `state` → `state-mismatch` (no session, login cookie
     cleared); callback without pending login → `login-expired`; IdP
     `access_denied` → `idp-error` with the detail logged;
  9. email outside `allowed_email_domains` refused (no user created);
     missing claims → `claims-missing`;
  10. userinfo claims merged under the ID token claims (userinfo-only
      email and groups);
  11. logout: cross-origin POST → 403 and the session survives; same-origin
      → 303 `/login`, row deleted, cookie cleared;
  12. sessions are rows of `web_sessions`;
  13. a sign-in whose email the IdP marks as unverified is refused: no
      user, no operator, the bootstrap token still active;
  14. a sign-in replaces the session the browser already had;
  15. an IdP save whose audit entry cannot be written stands and is
      reported at `error`;
  16. a body that is not a form answers 400.

## Scenarios — Store

> Covers: spec [`vaubaan-gateway.md`](../spec/vaubaan-gateway.md) §2, §3.3,
> §3.5, §6 ("encryption at rest", "authoritative, atomic counting",
> "immutable audit"), §8, §10 (structural tests). Handbook [[store]]. ADR
> [[embedded-store-sqlite-and-migrations]]. Every suite runs on an
> ephemeral `:memory:` store with the real migrations (`0001`-`0004`), a
> `ManualClock`, a `StubEncryptor` and a five-id `SetCatalogIndex`
> (`apps/gateway/src/server/store/testing.ts`); the two file-based cases
> use a temp directory. Paths are relative to `apps/gateway/tests/`.

- **`unit/server/store/ids.test.ts`** (6) — UUIDv7 canonical form and
  version/variant bits, embedded millisecond timestamp, ordering across
  milliseconds, strict monotonicity of 5k ids within one process (counter
  in `rand_a`), 10k uniqueness, rejection of non-v7 ids.
- **`unit/server/store/migrate.test.ts`** (9) — `NNNN_name.sql` loading
  and ordering, malformed file name rejected, duplicate version rejected,
  idempotent re-run, incremental apply of a new file, checksum
  immutability of an applied file (boot refused), full rollback of a
  failing file (nothing recorded, no table left), a database carrying a
  migration this image does not ship is refused, the four shipped
  migrations `0001`-`0004` in the default directory.
- **`unit/server/store/db.test.ts`** (2) — `isSqliteVersionAtLeast`
  against `MIN_SQLITE_VERSION`: major, minor and patch compared in order;
  a missing or malformed component counts as zero.
- **`integration/store/schema.test.ts`** (6) — the 29 tables exist; every table is `STRICT`; the store satisfies the composition root's
  `Store` port (`kind`, `ping()`, `close()`); boot against an empty file sets WAL,
  `foreign_keys`, `synchronous=NORMAL` and reopens without re-migrating;
  two writers on one file serialize under `BEGIN IMMEDIATE` (second gets
  `SQLITE_BUSY` while the lock is held, succeeds after commit);
  `VACUUM INTO` backup is a readable single file with no `-wal`.
- **`integration/store/audit.test.ts`** (13) — gateway-core
  `CallAuditEntry` round-trips through `audit` + `audit_risks` rows
  (accepted snapshot, touched, remaining budget), a touched-but-not-accepted
  risk is kept, `AdminAuditEntry` round-trips, **`UPDATE` aborts**
  (decision, latency, risk rows), **`DELETE` aborts** outside the purge
  path, `purgeOlderThan` removes only older rows and closes the window,
  a recent row cannot be deleted even inside a window, retention default
  90 days from the clock, filters (mission, kind, range, limit),
  `countAllowedTouches` for the counters-vs-audit check, schema `CHECK`s
  refuse incomplete entries, `SqliteAuditWriter` implements gateway-core's
  `AuditWriter` and propagates failures.
- **`integration/store/identities.test.ts`** (10) — users: upsert from
  IdP creates then refreshes (email, last login), lookups, removal and
  reactivation; groups: `getOrCreate` idempotent, atomic membership
  replacement and `groupsOf`, single add/remove, FK rejection of a
  non-user member; `syncIdpMemberships` replaces the IdP memberships of a
  user and leaves local groups alone, skips and reports a name held by a
  local group, and is one transaction (a failure keeps the previous
  memberships and creates no group).
- **`integration/store/connections-shares.test.ts`** (13) — connection
  credential sealed with the connection id as associated data and
  unreadable under another id; ciphertext never on the record; group
  ownership, transfer, `unowned`, revocation; reconnection reactivates;
  list filters and `listOwnedBy`; resource sync by ref keeping ids and
  owner env labels. Shares: restriction stored as rows, **unknown or
  wildcard risk ids refused by the catalog check** (`*`, `github.*`,
  unknown, empty) and **by the schema `CHECK`** when bypassed, empty
  restriction allowed, active-for-targets listing and revocation.
- **`integration/store/missions.test.ts`** (8) — creation with
  connections and policy rows, resource selection per connection,
  inconsistent selections refused (`selected` without resources, `all`
  with resources, resource of another connection, no connection), policy
  validation (catalog, non-negative integer quota and rate, positive
  window, duplicates), atomic `replacePolicy`, status and expiry
  transitions, token issuance and rotation (`active` → `rotated`,
  revoke), schema-level single active token and unique prefix.
- **`integration/store/sessions.test.ts`** (11) — session born on first
  call and never recreated; **N=50 concurrent `decideAndDecrement` on
  quota 1 → exactly one allow**, 49 refusals, one counter at 1; a call
  touching N risks decrements N counters and a refusal none; new period
  starts at zero; a thrown decider rolls back the session creation;
  in-transaction approval consumption is single-use; request drop and
  extra events from inside the refusal transaction; `resetCounters` and
  `listEvents` since/limit; **structural check**: `session_counters`
  consumed == allowed audit touches after a mixed run.
- **`integration/store/requests-approvals.test.ts`** (10) — approval
  request arguments sealed with `request:<id>` as associated data and
  readable only through `getArguments`; approval requires tool and
  fingerprint; decision erases the blob and a second decision is refused;
  sweeper expires open requests and erases blobs; inbox lists only the
  creator's open requests. Approvals: single-use and bound to the exact
  risk, tool and fingerprint; **the same arguments on another tool touching
  the same risk do not consume it**; an approval without a tool is never
  written and a row older than migration 0005 is never matched; expiry; one
  approval per request.
- **`integration/store/delegations.test.ts`** (7) — public client with
  de-duplicated redirect URIs, consent listing, single-use and expiring
  codes, refresh-token rotation chain (`revoked_at`, `replaced_by_id`),
  access token found only while live and delegation active, delegation
  revocation cascades to tokens, mission issued by delegation records
  the delegation id.
- **`integration/store/config.test.ts`** (7) — clear values overwrite,
  secrets sealed with `instance_config:<key>` and `key_version` stamped,
  a key is a value or a secret never both, delete; `apply` writes values,
  secrets and deletions together, all or nothing (a failing write leaves
  every key as it was), and is a no-op with no write.
- **`integration/store/web-sessions.test.ts`** (8) — `store.webSessions`,
  the one web session store: round trip, unknown id, TTL expiry and sweep
  on write, overwrite of value and expiry, non-positive TTL refused;
  **the row is keyed by the SHA-256 of the session id and the id itself is
  never written**; a row keyed by the id in clear (written before the
  digest) is not read; a value that is not JSON reads as no session and the
  row is removed.
- **`integration/store/corrupt-rows.test.ts`** (14) — **every enum column
  is validated on read; a corrupt row fails loudly**: an unknown
  `users.status`, `groups.source`, `shares.status`, `missions.status`,
  `mission_connections.resource_scope`, `mission_policy.gate`,
  `mission_tokens.status`, `requests.kind` / `state`, `delegations.status`
  or code challenge method, `audit.kind`, `act` or `object_type` is refused;
  an administrative entry the gateway wrote still reads; a corrupt request
  aborts a claim decision without writing anything.

> **Not covered here, by design.** The accounting rules (period
> arithmetic, quota/rate comparison, gate handling) are the budget's
> `decide` callback, tested in the section below against this primitive.
> The real `Encryptor` (XChaCha20-Poly1305, per-blob KDF,
> `apps/gateway/src/server/crypto/`) has its own suite; the store's stub
> only reproduces the port's associated-data and key-version contract.

## Scenarios — Budget and sessions

> Covers: spec [`vaubaan-gateway.md`](../spec/vaubaan-gateway.md) §2.3
> (mission states), §3.2 (unit, quota, rate limit, one budget per
> mission), §3.3 (session, rollover on read), §3.5 (gate, fingerprint
> binding, single use, whole-call refusal, "the gate does not replace the
> budget"), §6 ("authoritative, atomic counting"), §10 "the budget" and
> the structural test "session counters agree with the audit". Handbook
> [[budget-and-sessions]]. ADR [[atomic-budget-accounting]]. The
> integration suites run on the `:memory:` store with the fixture of
> `apps/gateway/tests/integration/budget/fixture.ts` (one creator, one
> connection, a three-risk policy: `code-read` 10/period 5 per 60 s,
> `write-feature-branch` 1/period, `merge-protected` 2/period 1 per 60 s
> gated `approval`; daily period anchored 2026-10-13). Paths are relative
> to `apps/gateway/tests/`.

- **`unit/server/budget/period.test.ts`** (8) — `periodIndex` at the
  anchor, the last millisecond, the boundary (belongs to the next period),
  a week later, before the anchor (period 0); zero, negative, fractional
  length and malformed anchor refused; `currentPeriod` for a recurring
  mission (start = counters key, end = reload), a one-off mission (single
  open-ended period at the anchor, whatever `now`), an anchor spelled with
  an offset normalised to canonical ISO; `periodSpecOf` borrowing the
  stored anchor for a one-off `Period`.
- The fingerprint tests live with the function, in
  `packages/gateway-core/tests/unit/fingerprint.test.ts` (above).
- **`unit/server/budget/decide.test.ts`** (15) — **multi-risk decrement**
  (`[READ, WRITE, READ]` → decrements `[READ, WRITE]`, remaining per risk),
  a call touching no risk, remaining after prior consumption, a gated risk
  with an approval names it for consumption, an opened gate behaves as
  `auto`; `budget-exhausted` with `period_end` (and `null` for one-off),
  **whole-call refusal** when one of two risks is exhausted, `rate-limited`
  with `retry_after_seconds >= 1`, `approval-required` with the
  fingerprint, **multi-risk call refused as a whole** when one risk is
  gated, dimension-major order (quota beats gate, rate beats gate), an
  approval bypasses neither quota nor rate; a touched risk outside the
  policy is a `BudgetInvariantError`; inputs are not mutated.
- **`unit/server/budget/mission-state.test.ts`** (7) — stored
  `revoked` / `orphaned` / `expired` win; `expires_at` reached reads
  `expired` without a column flip; `active` with `exhausted` per risk and
  remaining for the current period; **rollover on read** (yesterday's
  exhaustion gone today); a one-off never reloads; remaining clamped at 0
  after a quota was lowered; `consumedInPeriod` sums one period only.
- **`unit/server/rate-limit/sliding-window.test.ts`** (8) — unknown key is
  empty; `peek` never records, `push` does, `retryAfterMs` is when the
  oldest action leaves; actions slide out one by one; keys independent;
  non-positive window refused; idle keys swept above the prune threshold;
  the composition root's `RateLimiter.take` (check and consume, credit back
  after the window); `rateWindowKey` by mission and risk.
- **`integration/budget/session-service.test.ts`** (20) — session born on
  the first call, N risks → N counters, `call-allowed` event with tool,
  risks, remaining; **a refused call decrements nothing**, drops exactly one
  claim in the creator's inbox with `claim_url = requestUrl(id)`, expiry
  `now + requests.expiry`, events `call-allowed, request, call-refused`; a
  replayed refusal reuses the open request, a decided one is replaced;
  whole-call refusal leaves the other counter untouched; **rollover on
  read** (next period starts at zero, both periods' rows kept); reload of
  an hourly mission by arithmetic, a one-off mission exhausted forever with
  `period_end: null`; **N=50 concurrent `recordCall` on quota 1 → exactly
  one allow, 49 `budget-exhausted`, counter 1, one claim**; **several agent
  labels share the counters**, labels only on events; `rate-limited`: no
  request, no decrement, `retry_after_seconds` from the oldest action, free
  again after the window; refusals on another risk record nothing in the
  window; approval gate: request holds tool, fingerprint and sealed
  arguments readable through `getArguments`, `approval_url` and
  `expires_at` match the request, a granted approval is consumed by the
  identical replay in another key order (counter and `approval_ids`), a
  second replay asks again with a new request, one byte changed asks
  again, an expired approval does not open the gate, a multi-risk call with
  one gated risk is refused whole, **approved actions count against the
  quota** (third merge is `budget-exhausted`, a claim not an approval
  request); a touched risk outside the policy aborts the transaction (no
  session); `stateOf` with rollover, expiry and stored statuses, reading
  the counters of the current period only however old the mission is.
- **`integration/budget/pipeline-consistency.test.ts`** (6) — the
  `BudgetStage` inside the real `CallPipeline` with `SqliteAuditWriter` and
  stub resource / risk / upstream stages: after a mixed run (allowed,
  allowed-then-upstream-failed, exhausted, approval-required, a concurrent
  burst of 8 with a window of 5, a later exhausted multi-risk call, one
  more allowed) **`SUM(session_counters) == COUNT(audit allowed)` per risk**
  via the reusable `countersAgreeWithAudit`; **an allowed call that fails
  upstream keeps its credit** (`decision: allowed`, `upstream_error`,
  next call `budget-exhausted`); a one-off mission's open-ended period
  (anchor read from the store); a mission with no session yet reports zero
  everywhere; **granted claims** (quota extension, period reset, then a
  refusal) lower the counters and the check still agrees because it adds
  back the credits their events record (`counted + credited == audited`),
  per period; a credit event whose details are malformed is skipped without
  throwing.

## Scenarios — Connections, resources, provider apps

> Covers: spec §0 (Connection, Resource), §2.3 connection states, §4.2
> Connections and Administration, §6 (encryption at rest, anti-replay and
> anti-redirect, per-user rate limit on connection flows), §7.2. Handbook
> [[connections]], ADR [[connect-driver-and-resource-curation]]. No test
> reaches a provider: outbound HTTP is `mockFetch`, which rejects any
> request no route covers; plugins are `fixturePlugin()` (one
> `CredentialSpec` per kind) except in `shipped-providers.test.ts`.

Unit, co-located under `apps/gateway/src/server/connections/` and
`apps/gateway/src/server/provider-apps/` (134):

- **`oauth2.test.ts`** (16) — authorization URL (code flow, state, S256
  challenge, RFC 7636 appendix B vector, resource indicator, extra
  parameters that cannot override the core ones, PKCE required when the
  spec says so); code exchange with `client_secret_basic` (form-encoded
  Basic), `client_secret_post`, public client; a PKCE exchange without a
  verifier refused before the provider is called; `resource` on the token
  request; `expires_in` and comma-delimited scopes; a rejected grant
  carries the provider's `error: description` and never the client
  secret; an error body under HTTP 200; 5xx / network / missing
  `access_token` are not rejections; refresh rotates the refresh token,
  keeps it when none is returned, is a rejection without one.
- **`service.test.ts`** (33) — the connect driver per credential kind:
  - `oauth2`: redirect URI on `public_url`, the verifier of the exchange
    matches the challenge of the redirect, the credential is stored and
    the plugin discovers with the fresh token and without the client
    secret; **a replayed callback is refused** (`state-invalid`, token
    endpoint called once); a state that is unknown, absent, **of another
    user**, or of another provider is refused; **a foreign return URL is
    refused at the start** (`https://evil…`, `//evil…`, `/\evil…`) and one
    inside `public_url` is honoured; `app-not-configured`; a provider
    denial consumes the state; a failed exchange shows the provider's
    wording; a failed first discovery keeps the connection; the per-user
    rate limit (10 per minute, other users unaffected, window reset);
  - `app-install`, installation binding (P1.4b): installation URL with
    the state; **an installation id in the authorizing user's list (on the
    second page) is accepted**, the code exchanged with the app's client
    and no `redirect_uri`, the list read with the user token and the
    declared headers, the plugin receives the private key but not the
    client secret, and the user token is in no connection, audit entry or
    plugin context; **an id not in the list is refused, nothing stored,
    discovery never called, `connection-refused` audited**; **a callback
    without `code` is refused** before any request (also with `?error=`);
    **a refused code exchange is refused** (GitHub's 200 +
    `bad_verification_code`) while a 503 is `provider-unreachable` and not
    audited; a denied list is refused, an unreadable one fails closed; a
    reconnection is verified and its refusal names the connection; replay,
    missing id ("awaiting approval"), malformed id and an installation the
    provider rejects store nothing;
  - `app-install` **without `userVerification`**: refused at start and
    absent from the picker by default; connects once the operator accepts
    unverified installations (`installation_verification: none`); refused
    and audited at the callback when the acceptance was withdrawn
    mid-flow;
  - `api-key`: field validation by label, secret never echoed; a rejected
    key stores nothing and shows the provider's error (the Resend
    "restricted to only send emails" case); an unreachable provider is
    reported as such; foreign-provider and ref-less resources ignored;
  - `ssh-key`: key pair generated, private key only in the sealed
    credential, public key on the view, discovery deferred then run by
    the owner;
  - ownership (owner only, strangers get `not-found` everywhere, members
    of an owner group are owners), the `experimental` flag on the picker
    and the view, reconnect in place (expired → active, same id;
    `provider-mismatch`; `connection-revoked`; **an `unowned` connection is
    not reconnected** until an owner is reassigned, spec §2.3), revoke
    (terminal, blob erased, idempotent, audited once);
  - resources: **owner label, display name, hidden flag and list settings
    survive a re-discovery** while provider facts are refreshed; a
    vanished resource is marked stale (first date kept) and cleared when
    it returns; a plugin-set environment is read-only and follows the
    plugin, an invalid plugin label is dropped; edits are validated
    before any write; a failed refresh changes nothing; a rejected
    credential that cannot be refreshed expires the connection.
- **`credentials.test.ts`** (15) — `resolve` hands the decrypted secret
  and an app config without the client secret; a token inside the 60 s
  skew is refreshed, the rotated refresh token is persisted (sealed again)
  and presented at the next refresh; **an `unowned` connection is served**
  (its missions keep running, spec §2.3; a forced refresh keeps it
  `unowned`, a rejected one still throws `UpstreamAuthError`) while an
  expired or revoked one is refused without decrypting anything;
  no expiry / no refresh token → used as is; concurrent refreshes run one
  grant; `invalid_grant` → `expired` + `UpstreamAuthError`; 503 → still
  `active`; missing app configuration → still `active`; api key and
  oauth2 without refresh token → `expired`; a revocation during the
  refresh is never undone; a plugin `refresh()` replaces the generic
  grant; a rejecting plugin refresh expires, any other failure does not.
- **`pending.test.ts`** (7) — state single use, bound to the user, burnt
  by a foreign attempt, malformed / unknown refused, TTL, two concurrent
  callbacks → exactly one; notices read once by their web session.
- **`input.test.ts`** (23) — field reading; `resolveReturnTo` (fifteen
  refused shapes: userinfo, port and scheme tricks, paths that normalise to
  `//host`, control characters and backslashes a browser strips or
  rewrites); names; environment labels; editable metadata keys; list
  parsing.
- **`mapping.test.ts`** (3) — the one connection summary: a record is
  `id`, `provider`, `display_name` and `status` and nothing else; a user
  owner is named by email and a group owner by its name; an owner that no
  longer exists gives a null name, the wording left to the caller.
- **`codec-and-keypair.test.ts`** (12) — the four `CredentialSecret` kinds
  round-trip, malformed stored text refused; the generated ed25519 key is
  parsed by `ssh2`, matches its public line and signs.
- **`install-verification.test.ts`** (5, P1.4b) — `verifyInstallation`
  alone: a bare list in one request with Basic client authentication, ids
  as numbers or strings; an absent id, a longer id with the same prefix and
  malformed items refused; a spec header cannot replace `Authorization`;
  the cap of 20 pages refuses; refusal versus unreachable for each failure,
  and no error message carries the user token or the client secret.
- **`shipped-providers.test.ts`** (5) — the plugins the image ships:
  registered once; every provider-app field is expressible in the mounted
  configuration; no shipped `app-install` plugin is unverifiable;
  redirect-flow providers are offered only once their app
  is configured, forms need nothing; a valid https redirect with state,
  PKCE, resource indicator and extra parameters for each.
- **`provider-apps/service.test.ts`** (15) — fields per credential kind
  (a verified `app-install` adds `client_id` / `client_secret`); one entry
  per plugin with its `installVerification`; a secret sealed under
  `instance_config:provider_apps.<id>.<field>` and never returned; blank
  keeps the stored secret; every problem at once; the client secret goes
  to the host only, for `oauth2` and for a verified `app-install` (which
  keeps its private key); accepting unverified installations is explicit,
  works for a file-sourced provider, is refused for a verifying or
  non-installing provider, and a stray flag never weakens a verification;
  missing fields named; **the mounted configuration wins** and makes the
  provider read-only; an incomplete file block is not completed from the
  store; clear; the fields of a provider are saved, and cleared, in one
  transaction (a failed write keeps the previous app whole).
- **`apps/gateway/tests/unit/server/connections/provider-app-handler.test.ts`**
  (4) — the provider-app handler when the audit fails: a saved provider app,
  or an acceptance of unverified installations, whose audit entry cannot be
  written stands and is logged at `error` (no error line when the audit
  works); a body that is not a form answers 400 on every form handler and
  writes nothing.

Integration:

- **`tests/integration/store/connections-shares.test.ts`** (two of its 13
  cases) —
  `syncDiscoveredResources` at the repository (merge rule, stale, plugin
  label that stops being set, name handed back to discovery) and the
  conditional transitions `refreshCredential` / `markExpired` /
  `reconnect` / `revoke` (a revoked connection is never brought back).
- **`tests/integration/connections/repository-status.test.ts`** (9) —
  connection statuses at the repository: **`revoked` is terminal**
  (`setCredential` refuses and writes nothing, `setStatus` refuses to move
  it to `active`, `expired` or `unowned`, revoking again keeps the first
  date, a missing connection is still `not found`); **`unowned` keeps
  serving and cannot be reconnected** (a refreshed credential is persisted
  and the status left alone, a reconnection writes nothing, it can still be
  revoked).
- **`tests/integration/connections/connect-flow.test.ts`** (6; the two
  `app-install` scenarios are P1.4b: a foreign installation id and a
  callback without code are refused through the handlers with a
  `connection-refused` audit row each, the rightful user connects, and
  **the user token, the authorization code, the client secret and the
  private key appear in no table and no log line**; a plugin without
  `userVerification` is refused until an operator — not a user, and not for
  a verifying provider — accepts unverified installations, audited) —
  `buildRoot` over the `:memory:` store with the **real encryptor**, a
  fixture registry and a mocked provider, driven through the HTTP
  handlers:
  1. the operator registers the provider app (403 for a non-operator, 401
     without a session, audit entry without the secret) → the user starts
     the flow → the callback arrives on the internal host and lands on
     `/connections/<id>?notice=<id>` (no message in the URL; the notice
     is read once) → **the credential blob and a dump of every table
     contain neither the access token, the refresh token nor the client
     secret**, and the blob does not open under another connection id →
     resources discovered → an owner edit survives a refresh that renames
     one resource upstream and drops another (marked stale) → the
     replayed callback is refused → a stranger and a cross-origin request
     cannot revoke → revoke: `revoked`, blob NULL, resources kept, audit
     `config-changed` / `connection-created` / `connection-revoked`;
  2. an API key and an SSH private key are absent from the dump; a
     plugin-set label is marked and its edit refused;
  3. guards: no session, no origin, bootstrap operator on a user endpoint,
     callback without a session → `/login`, unconfigured app, foreign
     `return_to`, unknown provider, a notice unreadable from another
     session;
  4. an unknown provider is reported as unknown, and a failure to read the
     app settings as a failure.

Not covered here: the pages themselves (server components; walked by hand,
see [`e2e-tests.md`](./e2e-tests.md)), and a real provider.
`connection-unavailable` for missions on a revoked or expired connection is
in "Scenarios — Execution door".

## Scenarios — Missions

> Covers: spec [`vaubaan-gateway.md`](../spec/vaubaan-gateway.md) §3.1
> (monotonicity, enumeration, partition per connection, resource selection),
> §3.2 (mandatory budget, presets per plugin), §4.2 "Missions", §4.4, §7.4,
> §7.8, §10 ("authority" structural tests). Handbook [[missions]].

Unit, co-located (109):

- **`src/server/authority/authority-service.test.ts`** (7) — the owner holds
  the full catalog as an explicit enumeration (env-scoped risks expanded per
  acceptable env, no wildcard); nobody else holds anything; every _current_
  member of an owner group is an owner, recomputed on each call; no plugin, no
  authority; `connectionsOf` (own and through a group); `uncoveredRisks`.
- **`src/server/missions/preview.test.ts`** (44) — **monotonicity**: accepted ⊄
  authority → `exceeds-authority` with the uncovered list, the covered part
  still shown; wildcard, sentinel, foreign and out-of-env ids → `unknown-risk`;
  unknown and unauthorised connections answer alike; inactive connection.
  **Partition per connection**: each partition against its own authority; a
  risk filed under the wrong connection; one flat policy; the same connection
  twice; two connections of one provider; connection by provider, ambiguous
  provider. **Resource selection**: `all` → the explicit list; by id or by ref;
  a foreign resource; an empty selection; hidden and stale left out of `all`; a
  hidden one selectable, a stale one refused and unable to resolve an env; a
  connection with no resource. **Env-qualified ids**: pass with a labelled
  resource, shown and refused without, no label needed when the plugin derives
  the env. **Mandatory budget**: no budget, half a budget, zero / negative /
  fractional / infinite values, the catalog's rate ceiling. **Presets**:
  application as an explicit enumeration; intersection with the authority and
  with the selection, reported in `skipped_from_preset`; a base id expanded per
  selected env and never persisted; per-risk override inheriting what it omits;
  exactly the explicit entries; no budget for a risk the preset lacks; unknown
  preset, repeated risk, connection accepting nothing. Name, period, expiry;
  every problem reported in one pass. **Notices, never blocking**: the
  selected resources that carry no environment label are named with what it
  costs (env-scoped risks refused at call time), and so is a resource
  labelled with an environment no risk of the catalog is acceptable in;
  nothing is said when every resource is labelled, when the plugin derives
  the environment or when the catalog has no env-scoped risk; a draft with a
  notice and no issue is issuable.
- **`catalog-view.test.ts`** (11) — explicit enumeration equal to the owner
  authority; base id, env, fallback, deprecated, rate ceiling; per-env vector;
  `SEVERITY_RANKS` equal to `RISK_VECTOR_AXES`; score bounds and levels;
  `isResolvable`; `presetWidth` and its one-liner.
- **`summary.test.ts`** (8) — the three lines (can / cannot / quantities) for a
  recurring and a one-off mission, the empty form, label truncation, period and
  expiry phrases.
- **`bootstrap-kit.test.ts`** (9) — the secret only in the env snippet; MCP
  configuration with the instance URL and `${VAUBAAN_MISSION_TOKEN}`; the agent
  block (connections, refs, risks, budget); one line per refusal code and "never
  work around"; the `curl … tools/list` check; masked prefix on a revisited
  page; sub-path of the public URL; `/agent-bootstrap.md` documents every
  refusal code and names no instance.
- **`token.test.ts`** (8) — `vbn_live_<8>_<32>`, argon2id hash, clear prefix;
  verification; uniqueness; prefix of a live token only; the draft schema
  (unknown keys refused, every malformed field named).
- **`src/app/(app)/missions/new/form-state.test.ts`** (22) — initial state
  (nothing included, hidden and stale resources unticked, daily period, no
  expiry); a preset fills the policy and the draft sent is the explicit
  enumeration; the untouched preset follows the resource selection and says
  what it left out; edited entries are kept and flagged; base-id expansion;
  per-risk override; the default budget of a hand-ticked risk (chosen preset,
  another preset, none → issuance blocked); **"select all" → an enumerated list**
  inside the authority and the selection, without the fallback and deprecated
  entries; period and expiry mapping; loading a resolved draft.

Integration, `:memory:` store, the real root with the shipped plugins,
connections and resources seeded through the repositories (36):

- **`tests/integration/missions/mission-lifecycle.test.ts`** (28) — **issue →
  the token verifies → rotate → the old token is `retired/rotated` → revoke →
  `retired/revoked` and gateway-core's `checkMissionActive` answers
  `mission-inactive`**; malformed bearer, unknown prefix and wrong secret answer
  alike; the mission persists explicit resource ids and policy lines, no preset
  reference; a resource discovered later is not covered; `all` without hidden
  and stale resources, a hidden one when ticked, a stale one refused; the hash
  and prefix are stored, the secret is in neither the table nor the audit;
  a refused draft writes nothing; no authority → `connection-unknown`; an
  owner-group member issues until they leave the group; a three-connection
  mission with one partition each (Vercel's env-qualified risks need no label);
  env-qualified entries refused or skipped from a preset; duplicate (same
  policy, own token, no expiry, stale resources dropped) re-checked against
  the current authority; rotate / revoke creator-only, idempotent revoke,
  no rotation of a revoked or expired mission; `rotation` / `revocation`
  session events and audit acts; list and detail (state, labels, remaining,
  masked kit); past expiry refused; one-off mission; a taken token prefix is
  re-drawn; the issuance context (experimental, `derives_env`, presets,
  authority); revoked connections left out, expired ones unusable; **every
  preset of every shipped plugin previews cleanly** for an owner whose
  resources carry every env label, never with the fallback. **The detail
  page and the kit list what the door reaches**: nothing on a connection
  that had no resource at issuance, even once discovery finds some; no
  hidden resource for a mission issued on "all" when every resource is
  hidden; a resource turned stale dropped from both; the creator is told
  when a selected resource carries no environment label on an env-scoped
  catalog.
- **`tests/integration/missions/mission-handlers.test.ts`** (8) — 201 with the
  secret once, the kit and `no-store`; cross-origin refused on all four routes
  before the session is read; 401 without a session, 403 for the bootstrap
  operator; 400 with the fields named; 422 with the preview; preview of an
  agent's proposal (provider and refs resolved, nothing written); rotate
  200 / 404 / 409; revoke 404 for someone else's mission.

Not covered here: the browser (Playwright, see
[`e2e-tests.md`](./e2e-tests.md)); calls through the execution door with an
issued token are in "Scenarios — Execution door".

## Scenarios — Execution door

> Covers: handbook [[execution-door]]. Spec: `vaubaan-gateway.md` §4.1
> (discovery, call, the eight refusals, catalog), §2.4, §3.1 (resource
> selection), §3.3 and §10 (counters agree with the audit), §6 (three
> credentials, surface rate limit, no secret in logs), §8.

Ephemeral instance: the real composition root on the `:memory:` store
(`executionInstance()` in `src/server/execution/testing.ts`), a scripted
fixture plugin `depot` (a resource ref the classifier requires, an
account-level tool, an env-scoped risk, a risk to gate, an `execute` and a
`refresh` the test scripts), missions issued through `MissionService.issue`,
calls sent as JSON-RPC to `root.execution.handlers.mcp`.

- **`src/server/execution/execution.test.ts`** (21) — agent label (header,
  `_meta.agent` wins, sanitised and bounded); client address (ignored
  without `trusted_proxies`, right-most untrusted hop, CIDR, IPv6, malformed
  chain, a hop with a port or in brackets, an invalid `trusted_proxies`
  entry skipped — the one rule of `http/client-ip`); `citedRefs` over
  identifier and list segments; tool filter (needs a connection **and** an
  accepted risk, nothing of an experimental plugin); verified-token cache
  (hash computed once, state re-read on every call, proof keyed by a hash of
  the bearer, **the proof slides on every hit** so an agent that keeps
  calling never verifies again, a replaced row voids the proof, concurrent
  first calls share one verification, unknown bearers never cached and
  **throttled per prefix and client address** — a flood of wrong secrets
  locks out only its sender —, a non-token bearer costs nothing); upstream
  credential cache (scoped per connection, dropped on demand, unreachable
  after the connection row changed, lifetime capped).- **`integration/execution/pipeline.test.ts`** (22)
  - _allowed call_: forwarded to the plugin, the touched risk decremented,
    one audit entry with connection, resource ref, canonical
    `arguments_hash`, `remaining_budget`; the decrypted credential reaches
    the plugin and never the response; an env-qualified risk matches through
    the label of the resource touched, and the same tool on another resource
    is `risk-not-accepted`; the agent label from the header and from
    `_meta.agent`, both spending one budget.
  - _every refusal code with its fields and a hint_: `risk-not-accepted`
    (`missing_risks`, `executed_slices`; nothing counted, no session born),
    `budget-exhausted` (`risk_id`, `quota`, `consumed`, `period_end`,
    `claim_url` under the public URL), `approval-required` (`risk_id`,
    `fingerprint` equal to the audit hash, `approval_url`, `expires_at`),
    `resource-not-in-mission` (`cited_ref`, `connection`,
    `allowed_resources`; before any risk — the entry has no slice),
    `rate-limited` (`risk_id`, `limit`, `retry_after_seconds`; quota intact),
    `connection-unavailable` (revoked connection, its name, the owner's
    email), `mission-inactive` (revoked, expired; also on `tools/list`).
  - _resource selection_: a selected resource gone stale is refused naming
    it while a hidden one still works; a mission stored `all` with an empty
    list covers nothing, including a resource discovered later, and still
    calls an account-level tool.
  - _structural rejections_ (`-32602`, audit `refused` with no code):
    unknown tool, unplaceable arguments.
  - _upstream_: a provider failure is a tool error and the call stays
    allowed and counted; 401 → refresh → retry with the new credential; 401
    and a rejected refresh → connection `expired`, the agent reads
    `connection-unavailable`, the entry stays `allowed` with
    `upstream_error`, the next call is refused before the budget; 403 → no
    refresh, no expiry; a derived credential served from the cache, dropped
    and re-derived on 401; **the provider's text stays out of the audit**
    (a host-built summary there, the detail to the calling agent; for an
    HTTP error the status is named and nothing of its message).
- **`integration/execution/door-http.test.ts`** (19) — the real GitHub
  plugin on a mocked upstream (`mockFetch`: installation-token mint, branch
  list), driven by the official MCP client (`@modelcontextprotocol/client`)
  whose HTTP goes to the handler:
  - a 2025-era client and a 2026-07-28 client both connect, list the tools
    and call `github__list_branches`; the gateway mints a repository-scoped
    installation token, uses it upstream, and nothing of it reaches the
    client; the installation token is minted once for three calls;
  - the client receives the whole refusal in the JSON-RPC error `data`
    (`resource-not-in-mission`, `risk-not-accepted`), and nothing reaches
    GitHub;
  - the kit's bare `tools/list` gets plain JSON; `GET` / `DELETE` are 405;
  - `tools/list` per provider; `GET /mcp/catalog` (surface, callable set,
    resources with env labels, consumed / remaining per risk), 401 without a
    token, 403 `mission-inactive` for a revoked mission;
  - **credential separation**: no bearer, garbage, unknown prefix, wrong
    secret and a rotated token are all 401; a web session as cookie or as
    bearer and a delegated token (injected resolver) are 403
    `wrong-credential-kind` naming door, presented and expected; a foreign
    `Origin` is 403;
  - argon2 once for a burst and a series, yet a revocation is seen on the
    next call; wrong secrets on a real prefix end in 429 for their sender,
    while a verified agent is not locked out when another address floods its
    prefix, nor when no client address can be resolved; the surface limit
    is per mission, whatever the agent label, with `Retry-After`;
  - **no secret in logs**: the token secret, the installation token, the
    App key, the client secret and the arguments never appear; the prefix
    and a 64-hex `arguments_hash` do.
- **`integration/execution/counters-vs-audit.test.ts`** (4) — **structural,
  spec §10**: 240 calls per seed (three seeds; allowed, refused on every
  dimension, rejected, failing upstream, a 401 repaired by a refresh, bursts
  of up to six concurrent calls from three agent labels) through the door,
  then `countersAgreeWithAudit` reports no mismatch for every accepted risk,
  one audit entry per call, no quota overrun, and the last `remaining_budget`
  equals quota minus counter; a burst of 30 on a quota of 7 → exactly 7
  allowed, 23 `budget-exhausted`.
- **`plugins/github/tests/unit/token-cache.test.ts`** (5) — no cache → a mint
  per call; one mint per repository scope; never served or stored close to
  expiry; lifetime bounded by what is left; `github__mint_install_token`
  never cached.

## Scenarios — Requests

> Covers: spec [`vaubaan-gateway.md`](../spec/vaubaan-gateway.md) §2.3
> (Request states), §3.4 (the claim: creator only, the four answers, the
> event, "a refused or expired claim does not close the mission"), §4.2
> "Request inbox", §6 ("requests are granted only in a human session",
> rate limit on the request page per IP), §7.6. Handbook [[requests]]. ADR
> [[claim-resolutions-as-counter-credits]]. The claim itself is dropped by
> `SessionService.recordCall` (budget scenarios above); these start from its
> refusal.

Unit, beside the code (`apps/gateway/src/server/requests/`, 85 with
`approval.test.ts`, listed under "Scenarios — Approval gate"):

- **`state.test.ts`** (9) — **state machine**: `open → granted | refused |
expired`, the three terminal for every transition; an open request past
  its expiry reads `expired` (boundary instant included) and is not
  decidable; a decided one keeps its state whatever the clock; the request
  URL is `<public_url origin>/r/<id>` and an id cannot leave the prefix.
- **`claim.test.ts`** (37) — the four options, always in the same order,
  each with a one-line consequence naming what stays exhausted and until
  when (recurring and one-off); quota extension bounded by what was
  consumed; the expiry floor; a mission that never expires; revoked /
  orphaned missions leave only the refusal, an expired one only the expiry
  and the refusal; a risk that left the policy; nothing consumed after a
  rollover; `checkClaimDecision` for each resolution and each refusal;
  `parseClaimDecision` for JSON and form fields, a `datetime-local` value
  read as UTC, unknown keys and every malformed body refused.
- **`client-ip.test.ts`** (2) — the request page keys its limit on the
  shared client-address rule, not a copy of it (the rule itself is tested in
  `http/client-ip.test.ts`, "Instance configuration" above); every caller
  shares one key when no proxy is trusted.
- **`events.test.ts`** (6) — one line per event kind, total for unknown
  kinds and missing details; an event with malformed details is shown
  without detail and does not throw.- **`sweeper.test.ts`** (4) — ticks on the interval until stopped; a failing
  pass is logged and the next still runs; passes are not stacked.

Integration:

- **`tests/integration/requests/request-service.test.ts`** (30, `:memory:`
  store, manual clock) — inbox lists the claim with the URL the refusal
  carried, empty for anyone else, drops an overdue request before any
  sweep; **creator-only access**: another user, an unknown id, **a
  beneficiary of a share on the same connection**, a co-owner through the
  owner group → `forbidden`, and a refused decision changes nothing; the
  creator's view (risk line, other risks, period, events, options);
  after a rollover the risk reads un-exhausted; **reset** zeroes every
  counter of the period, records the `reset` event with credits, **the
  replay passes**, admin audit `period-reset`; **extend quota** gives back
  N on the claimed risk only, does not carry over to the next period,
  refuses more than was consumed and leaves the request open, and the
  store never lets a counter go below zero; **extend expiry** moves the
  date while the risk stays exhausted, refuses an earlier date and a
  mission without expiry, and brings a stored-`expired` mission back to
  `active`; **refuse keeps the risk exhausted** until the next period while
  other risks pass; a revoked mission leaves only the refusal; a decided
  request cannot be decided again (`not-open`, one audit entry); a failing
  effect rolls the whole decision back; an overdue request is expired by
  the decision attempt; **the sweep expires unanswered requests** once,
  with an event each, leaves decided ones alone, does not close the
  mission, and erases the sealed arguments of an approval request; an
  approval request gets a neutral view and `unsupported-kind`.
- **`tests/integration/requests/request-handlers.test.ts`** (13, real root)
  — **exhaust → refusal URL → no session: sign-in redirect → non-creator
  403 with one sentence and no detail → creator 303 to the inbox → grants a
  reset → the replay passes**; unknown id and someone else's request are
  the same 403; a co-owner of the connection and the bootstrap operator
  are refused; **the mission token (and any other bearer) is refused on
  `/r/*` and `/api/requests/*`, even next to the creator's session
  cookie**; decide needs the origin check then a session; 422 / 409 / 400
  mapping; the page's form post is redirected back with `?decided=1` or
  `?problem=<code>`; `GET /api/requests`; labels from the plugin catalog;
  **per-IP rate limit on `/r/*`** (429, `Retry-After`) that does not block
  the decision endpoint; the root runs and stops the sweeper.

Not covered here: the approval decision ("Scenarios — Approval gate"
below). The claim URL reaching an MCP client through the execution door is
asserted in "Scenarios — Execution door" (`budget-exhausted`).

## Scenarios — Approval gate

> Covers: spec [`vaubaan-gateway.md`](../spec/vaubaan-gateway.md) §0 (Gate,
> Approval request, Approval), §2.3, §3.5, §4.1 `approval-required`, §4.2
> "Request inbox", §7.7, §8 (the acts), §10 "the approval: binding to the
> exact argument fingerprint, single use, expiry, whole refusal of a
> multi-risk call, gate opening bounded to the period, erasure of arguments
> after decision" and "integration: approval and replay". Handbooks
> [[requests]] ("Approvals"), [[budget-and-sessions]] ("Gates opened for the
> period"), [[missions]] ("Editing a gate"). ADR [[atomic-budget-accounting]]
> (amendment "the approval gate"). Feature P2.1.

Unit:

- **`apps/gateway/tests/unit/server/budget/gates.test.ts`** (9) — **gate
  opening bounded to the period**: nothing opens without an event; an
  opening opens the risk it names for the period it carries, another risk
  stays gated; **the last instant of the period passes, the reload instant
  does not**; an opening granted in the next period opens that one only; a
  later edit of the gate on the mission ends it whatever the new value, an
  edit of another risk does not; **an edit at the very instant of an opening
  wins**; an opening after an edit opens again, in any order of the list;
  events it cannot read (no details, no period end, no risk, a bad
  timestamp, another kind) open nothing; fed to `decide()`: an opened gate
  consumes no approval, the next period needs one again, the budget still
  refuses at zero quota.
- **`apps/gateway/src/server/requests/approval.test.ts`** (27) — the three
  options, always in the same order, each with a one-line consequence (the
  tool, "once, within 10 minutes", the quota and the rate limit; the period
  end in UTC; "approval again from the next period"); a refusal is always
  possible; a revoked / orphaned / expired mission and a risk that left the
  policy take neither a grant nor an opening; a gate already `auto` or
  already open cannot be opened, a grant stays possible; **a mission whose
  single period never ends has no "rest of the period"**; the parser reads
  the three resolutions and refuses anything else, a claim's resolution and
  **any extra key** (nothing can widen what is granted); `formatDelay`.
- **`packages/shared/src/session-events.test.ts`** — the `approval`,
  `gate-opened` (a period end is mandatory) and `gate-changed` shapes, valid
  and malformed. **`packages/gateway-core/tests/unit/errors.test.ts`** — the
  refusal carries `approval_valid_seconds` and a hint naming the same tool,
  the same arguments, the delay and "used once".

Integration, `:memory:` store with a manual clock
(`apps/gateway/tests/integration/requests/approval.test.ts`, 42): the
executor is `SessionService.recordCall`, the creator is `RequestService`.

- **The refusal** — every field: URL, fingerprint, the request's expiry,
  the approval's validity, the replay instruction; nothing decremented; the
  refusal never repeats the arguments; **the arguments are sealed with
  `request:<id>` as associated data** and do not open under another id; a
  replay before the decision points to the same request; **one byte changed
  is a new request with another fingerprint**; the same arguments on another
  tool are a request of their own; **a multi-risk call with one gated risk
  is refused whole**, the ungated risk neither counted nor rate-recorded.
- **The creator's view** — tool, arguments in clear, slices and touched
  risks from the audit entry of the refused call, quota / consumed / left and
  the gate of each, the three options, the session events; without an audit
  entry the slices read "not recorded"; anyone else gets `forbidden` from
  the view and from the three decisions; the inbox names the tool, never the
  arguments.
- **Grant** — **refusal → grant → the identical replay (another key order)
  passes and consumes the approval → the second identical replay is refused
  with a new request**; **the approved action decrements the quota and
  counts in the rate window** (the next one is `rate-limited`); at zero
  quota the claim comes first; **one approval covers a multi-risk call**
  (both risks counted, one request); bound to the exact fingerprint, to the
  tool and to the mission; **expires after the configured delay** (boundary
  instant), and the delay is the operator's; a second gated risk of the same
  call asks in its turn and both approvals are consumed together.
- **Erasure** — on `grant`, `open-gate` and `refuse` **the row's `args_blob`
  and `key_version` are NULL** (read with SQL), `decision_json` names no
  argument, the view shows `arguments: null`; **on expiry the sweeper erases
  the blob, and before it runs nothing opens an overdue request**; a
  decision after the expiry decides nothing and erases; a decision the rules
  refuse writes nothing and leaves the arguments sealed; a decided request
  is not decided again.
- **Refuse** — no approval; the replay asks again.
- **Open the gate for the rest of the period** — a `gate-opened` session
  event, no approval; **`decide()` reads it**: the replay and any other call
  on the risk pass, **within the rate limit and the quota**; another gated
  risk still asks; **after the reload the gate asks again**; opened again in
  the next period it opens that one only; not twice in a period; **an edit
  of the gate on the mission ends the opening**.
- **Mission states** — revoked: a refusal only; a risk that left the policy:
  a refusal only.
- **Audit and logs** — **every decision writes one admin entry**
  (`approval-granted`, `gate-opened`, `request-refused`) naming the creator,
  the request, the tool and the fingerprint; a grant names its approval, an
  opening its period; **the audit, the session events and the logs never
  hold the arguments**, and no row holds a blob once every request is
  closed.

Integration, the real composition root:

- **`tests/integration/requests/approval-access.test.ts`** (29) — **nobody
  but the creator reads the arguments**: an operator, a co-owner of the
  connection through its owner group and another user each get no view, one
  sentence at `/r/<id>` (no argument, tool, mission name, risk or creator),
  an empty inbox, 403 on the three decisions, and nothing on the mission's
  pages; **the bootstrap operator** gets 403 on the three routes; **the
  executor cannot approve its own action** (mission token refused by kind,
  even next to the creator's cookie); another origin is refused; the creator
  decides over JSON (the answer is the summary, tool but no argument) and
  through the page's form (303 `?decided=1`, `?problem=<code>`); after the
  decision the whole audit and the session events hold no argument.
- **`tests/integration/execution/approval-door.test.ts`** (7) — **the
  GitHub plugin's `developer` preset as shipped**, over JSON-RPC on `/mcp`
  with a mocked upstream: a workflow file write on a feature branch (the
  gated `github.workflow-write-via-file` and the ungated
  `github.feature-branch-write`) is refused whole, nothing forwarded; the
  creator's view shows the two slices and both risks; **grant → the
  identical replay reaches the provider, counts on both risks, and its audit
  entry carries `approval_id` → the second replay is refused**; one byte
  changed and `github__delete_file` with the same arguments ask again; a
  file outside `.github/workflows` never meets the gate; the gate opened for
  the period; the gate set to `auto` on the mission; the sealed blob does
  not read as the arguments, and neither audit, events nor logs hold them.
- **`tests/integration/missions/gate.test.ts`** (17) — **the gate edited
  after issuance**: `auto → approval` makes the next call ask and leaves the
  rest of the policy untouched; `approval → auto` lets calls pass and leaves
  the open request open; one `gate-changed` entry with before / after and a
  session event once the session exists; the same gate writes nothing;
  creator only (`not-found` for an operator and another user); a value that
  is not a gate, a risk outside the policy, a revoked mission; the detail's
  `gate_open_until`; `POST /api/missions/:id/gate` 200 / 400 / 404 / 422 /
  409 / 403 / 401.
- **`tests/integration/store/approval-decisions.test.ts`** (16) — migration
  0005 (the `tool` column and the lookup index), `decideApproval` in one
  transaction and its rollback, `getArguments` on an overdue request, the
  open request of a call, `riskEvents`, `setGate`, `latestCall`.
- **`tests/integration/audit/admin-mutations.test.ts`** — **structural**:
  `MissionService.setGate` and `RequestService.decideApproval` are classified
  as mutations, and each resolution of an approval request leaves its act,
  through `decide` and through `decideApproval`.

Not covered: a real provider behind an approved call (never); one request
for a call touching two gated risks (they ask in turn, by decision).

## Scenarios — Audit search, mission session, retention

> Covers: spec [`vaubaan-gateway.md`](../spec/vaubaan-gateway.md) §3.3 (the
> session), §4.2 ("Mission session", "Audit"), §6 ("immutable audit", "no
> secret in logs"), §8 (one entry per call and per administrative act,
> fields, retention). Handbook [[audit]].

Suites under `apps/gateway/tests/integration/audit/` run on the real composition root with the
`:memory:` store and the shipped plugins (`support.ts`). They seed calls the way `CallPipeline`
produces them — `SessionService.recordCall` (session, counters, events, requests) then the
store's audit writer — rather than through the execution door; entries written by the door
itself are asserted in "Scenarios — Execution door".

- **`apps/gateway/src/server/audit/filters.test.ts`** (18, unit) — **audit filters**: every parameter
  read and trimmed; first value of a repeated parameter; decision and kind outside their
  closed sets dropped and reported; unreadable or impossible dates dropped; a reversed
  period ignored; a single day is `[00:00, next 00:00)` UTC; oversized value refused;
  cursor round trip and every malformed cursor refused; `auditQueryString`; `scopeOf` for
  a user, an operator and the bootstrap operator; `withoutArguments`.
- **`audit-query.test.ts`** (22) — **visibility**: a creator sees the calls and acts of their
  missions, another user none; a connection's owner sees the calls made through it by a
  mission they did not create; a member of the owning group sees it, a non-member does
  not; an operator sees every administrative entry and still not other people's calls;
  the bootstrap operator sees administrative entries only; a request's entries belong to
  its mission; **a filter never widens the scope**. **Filters**: mission, connection,
  tool (exact), decision, kind, period, user (email or id, unknown user → nothing),
  combined. **Paging**: page sizes 3/3/1 over seven entries, no entry twice, stable on
  equal timestamps, no further page announced on an exact fit, a write during paging does
  not shift the next page. **No raw arguments**: the argument marker reaches no viewer's
  page; arguments wrongly put in an administrative entry are replaced by `[not shown]`.
  The bootstrap operator is named ("Bootstrap operator") instead of shown by its actor id.
- **`mission-session.test.ts`** (15) — creator only (another user, an operator and an unknown
  id get `null`); before the first call (no session, full budget, gate per risk, catalog
  labels); counted / left / exhausted per risk; past periods kept apart and yesterday's
  exhaustion gone; one-off mission; **open requests by link only** (kind, risk, dates,
  `/requests/<id>`; the sealed arguments exist in the store and are not in the view); decided
  request no longer listed; **a granted claim lowers the counters** (quota extension then
  period reset: counted and left follow the counter, the `extension` / `reset` events carry
  the credits, the decisions are in the mission's audit); agent labels with counts; timeline newest first with tool,
  risks, what is left, refusal code and request; timeline paging; revoked mission keeps
  its history; `eventView` ignores every detail it does not name and shows an event with
  malformed details without detail.
- **`retention.test.ts`** (10) — **the purge removes the entries older than N days and
  nothing else**: older call and act gone with their risk rows, the entry exactly N days
  old and the recent ones intact, seven other tables unchanged; **the triggers still
  forbid `UPDATE` and `DELETE`** on `audit` and `audit_risks` afterwards and the purge
  window is closed; idempotent; the configured number of days is honoured; boot sweep,
  interval, stop; a failing purge is logged and retried; concurrent sweeps share one
  purge; the composition root starts the sweeper with `retention_days` and `close()`
  stops it; default 90 days.
- **`admin-mutations.test.ts`** (20) — **structural: every administrative mutation writes an
  admin audit entry.** The public methods of every class under
  `server/{connections,provider-apps,missions,auth,requests}` are enumerated from the source with
  the TypeScript parser; each must be classified (read, mutation, exempt with a reason),
  with no unclassified method and no stale rule. Each of the 16 mutations is driven on an
  ephemeral instance, must go through the method under test (spy) and leave exactly one
  entry with the expected act, object and acting user: connection created (key and OAuth
  callback), resources discovered, resource edited, connection revoked, mission issued
  (issue and duplicate), rotated, revoked, configuration changed (provider app saved,
  cleared, unverified installations accepted, IdP saved, bootstrap token revoked by the
  first operator sign-in), request decided (`RequestService.decide` refusing,
  `decideClaim` resetting the period — the entries P1.7 writes; none is added here). Plus: a resource edit records `before` / `after` and a save
  that changes nothing records none; a failed discovery is recorded with its reason.

## Scenarios — Community telemetry

> Covers: spec [`vaubaan-gateway.md`](../spec/vaubaan-gateway.md) §9 (opt-in
> per instance, content of a report, what is never sent, validation status on
> each connection), §10 "a telemetry report contains none of the forbidden
> fields", §4.3 (opt-in and collector URL), §8 (the toggle is a configuration
> change). Handbook [[telemetry]]. ADR [[telemetry-collector-shape]]. No test
> reaches a collector: the outbound `fetch` is injected everywhere.

Unit, beside the code (`packages/telemetry/src/`, 53):

- **`report.test.ts`** (24) — **the frozen shape**: the six keys and the four
  outcomes; `createPluginReport` returns a frozen six-key object whatever the
  input smuggles in (`arguments`, `arguments_hash`, `mission_id`,
  `instance_id`); refuses a plugin, version or tool that is not of its shape
  (spaces, a query string, free text), an unknown outcome, an error class on
  a success, none on a failure, free text, a class of another outcome, an
  HTTP class out of range; each named class belongs to one outcome;
  `isPluginReport` by exact keys; `serializeReports` drops what is not a
  vetted report.
- **`queue.test.ts`** (12) — **batching**: one timer for several pushes, the
  flush interval, an immediate flush when a batch is full, at most
  `batchSize` per request, order kept, one request in flight, oldest dropped
  on overflow. **Backoff**: a batch the collector did not take stays and is
  retried after 100, 200, 400, 800 ms then the cap; a full batch does not
  shorten the wait; a `send` that throws is a retry; a refused batch is
  dropped, never resent; the delay formula with jitter; `clear()`, `stop()`.
- **`client.test.ts`** (17) — **disabled → zero network calls** (120 reports
  recorded, the injected `fetch` never called, no warning); **enabled with
  the placeholder collector URL → zero network calls** and exactly one
  warning; the placeholder compared as a URL; a report queued while enabled
  never leaves once telemetry is switched off; the request (JSON array of
  six-key objects, the public key moved from the URL to `apikey` /
  `Authorization`, `Prefer: return=minimal`, redirects refused, no
  credentials, no referrer); 408 / 429 / 5xx and an unreachable collector
  keep the batch; 400 / 401 / 403 / 404 drop it with one warning.

Unit, beside the code (`apps/gateway/src/server/telemetry/`, 46):

- **`outcome.test.ts`** (28) — **outcome classes**: a result is a `success`;
  `isError: true` is `classification-error / executor_refused`; a status
  (`UpstreamAuthError`, numeric `status`), `fetch failed`, Node network and
  timeout codes down the `cause` chain, `AbortError`, a credential refused
  for good are `upstream-error` with their class; `TypeError`, `RangeError`,
  `ReferenceError`, `SyntaxError` and non-`Error` throws are
  `execution-error`; **an error whose `name`, `code`, `status` and message
  are a secret ends as `unspecified`**; a cyclic `cause` terminates;
  `reportOf` yields nothing for a tool the plugin does not declare or a
  version that is not semver.
- **`settings.test.ts`** (7) — **who decides**: off by default; the
  configuration wins for `true` and for `false`, over a stored toggle, and
  the setter throws; the operator's toggle is stored and applied at once; a
  stale view is re-read in the background; an unreadable store keeps the last
  value.
- **`stats.test.ts`** (11) — the `plugin_stats` request (plugin-level rows,
  registered ids, key in headers); nothing on the first read, then the row of
  the running version; cached 6 h; an error status, a non-JSON body, a body
  that is not a list and an unreachable collector show nothing and are not
  retried for 10 min; **no request at all while telemetry is not sending**;
  concurrent refreshes share one request; malformed rows skipped.

Structural (`apps/gateway/tests/unit/structural/`, 10):

- **`telemetry-report-shape.test.ts`** (3) — **spec §10, property-based**:
  three seeds × 400 calls through the real root (`:memory:` store, the door,
  the pipeline, the telemetry module, a mocked collector). Each call draws a
  tool, arguments, an agent label, a caller address and user agent, and one
  of thirteen ways `plugin.execute` can end — a result echoing the arguments,
  an error result, thrown errors carrying the arguments, the provider token
  and a unique message in their message, `name`, `code`, `status`,
  `statusText` and `cause`, thrown strings, objects, `null`, symbols — and
  one call in ten is refused before the plugin. Asserted on everything that
  reached the collector (URL, headers, body): exactly the six keys per
  report; every value from a universe fixed before the first call (the
  plugin's declaration, the build stamp, the closed vocabularies); none of
  the planted values anywhere — argument values, `fingerprintArguments(args)`
  of every call, resource refs and ids, mission, session, user and connection
  ids, the mission token and its prefix, the provider key, agent labels,
  addresses, user agents, the instance's host, provider messages; one report
  per call that reached the plugin, in order, with the expected class; every
  outcome class drawn.
- **`telemetry-collector-schema.test.ts`** (7) — `deploy/collector/schema.sql`
  read as text: the table's columns are an identity, a day and the six report
  keys; `anon` holds `INSERT` on those six columns and one `for insert`
  policy, nothing else; the view runs with its owner's rights and is the only
  thing `anon` reads; the `CHECK` constraints carry the outcomes, error
  classes and shapes exported by `@vaubaan/telemetry`; the per-request limit
  admits a full client batch; the thresholds published in the README are the
  ones of the SQL function; the README documents every field and class.

Integration (`apps/gateway/tests/integration/telemetry/telemetry.test.ts`, 15):

- **Disabled by default** — 61 calls, a failing one included, a flush and a
  statistics refresh: the injected collector `fetch` is never called;
  `telemetry.enabled: false` in the configuration keeps it off and the toggle
  answers `?problem=locked`, storing and auditing nothing.
- **Placeholder collector URL** — enabled by the configuration, then by the
  operator: zero network calls, one `warn` naming the placeholder, state
  `placeholder-collector`.
- **The operator's toggle** — stored as `telemetry.enabled` in
  `instance_config`; only calls made after the opt-in are reported; **one
  `config-changed` entry on `instance-config:telemetry` per change** with
  `before` / `after`, none for a toggle to the same value; switching off
  discards the queue; 401 with no session, 403 for a user who is not an
  operator and for a foreign origin; an invalid value is refused; the stored
  toggle is read at boot.
- **What is reported** — one report per call that reached the plugin, none
  for a risk not accepted, a foreign resource or an unknown tool; `success`,
  `classification-error`, `upstream-error http_503`, `execution-error
type_error` in order; a 401 followed by a successful refresh is one
  `success`; a credential refused for good is `credential_rejected` and the
  now-expired connection reports nothing more; a collector that is down
  does not fail a call; the Admin overview's sample payload has the six keys
  and the collector URL is shown without its key.
- **Validation status** — one `plugin_stats` read, cached, the row of the
  running version; a collector without the endpoint shows nothing.

Elsewhere: `admin-mutations.test.ts` classifies
`TelemetrySettingsService.setEnabled` as a mutation that writes
`config-changed`; `mutation-guard.test.ts` drives
`telemetry.handlers.setEnabled` through every refusal of the guard;
`admin-guard.test.ts` covers the page `/admin/telemetry`; `load.test.ts`
tells an explicit `telemetry.enabled` from an unset one.

## Out of scope for these tests

- **E2E** (Playwright, container smoke) → [`e2e-tests.md`](./e2e-tests.md).
- **UI rendering** (React components) — one static-markup suite only
  (`apps/gateway/tests/unit/app/field.test.tsx`, label binding); the pages
  are walked by Playwright.
- **Accounting rules** (period arithmetic, quota/rate comparison, gates) —
  "Scenarios — Budget and sessions" tests them against the store's
  `decideAndDecrement`.
- **A real identity provider** (Google, Entra ID, Keycloak) — never in the
  automated suite; the manual check is in [`e2e-tests.md`](./e2e-tests.md).

## Known gaps

- **The collector's SQL against PostgREST** — `schema.sql` is checked as text
  here and was applied by hand to a local PostgreSQL 17 (insert as `anon`,
  refused read / update / delete, constraints, limits, the view). Nothing in
  the suite runs a database server, and no test goes through PostgREST: the
  `PT429` → HTTP 429 mapping and the bulk-insert request are taken from its
  documentation.
- **Telemetry classes of the shipped plugins** — the outcome reduction is
  tested on a fixture plugin; no test asserts which class each shipped
  plugin's failures end in (two of them return provider failures as
  `isError` results, reported `classification-error`).

- **Claude Code against a running instance** — never done, by a human or an
  agent. The automated suites drive the door with the official MCP client
  instead (here against the handler, in the browser smoke over HTTP); the
  first session with Claude Code is step 6 of the cutover acceptance
  scenario ([`e2e-tests.md`](./e2e-tests.md)).
- **A ref the connection never discovered** is rejected with the
  classifier's sentence, not with `resource-not-in-mission`; only the
  rejection is tested.
- **`unowned` connections** — the state is tested where it is enforced
  (credential broker, repository, reconnect); nothing puts a connection in
  that state yet, the transition arrives with shares (P2.2).
- **`ssh__exec` end to end** — `execute` runs over a fake `SshTransport`,
  and the real transport is driven against an in-process ssh server on
  loopback (`host-key-pinning.test.ts`). No test reaches a real host, by
  design.

## References

- Spec: [`../spec/vaubaan-gateway.md`](../spec/vaubaan-gateway.md) (v5),
  [`../spec/gateway-risk-model.md`](../spec/gateway-risk-model.md) (risk
  model).
- Handbooks: [[policy-engine]], [[plugin-sdk]], [[gateway-core]],
  [[configuration]], [[store]], [[authentication]], [[budget-and-sessions]],
  [[connections]], [[missions]], [[execution-door]], [[requests]], [[audit]],
  [[telemetry]],
  and the provider handbooks under
  [`../handbook/providers/`](../handbook/providers/README.md).
- CI workflow: [`../workflow/coding-workflow.md`](../workflow/coding-workflow.md)
  — `npm run ci` runs type-check + lint + format:check + build + test (this
  suite).
- E2E (Playwright, container smoke): [`./e2e-tests.md`](./e2e-tests.md).
