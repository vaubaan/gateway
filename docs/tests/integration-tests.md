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
  - apps/gateway/src/lib/bash/
  - apps/gateway/src/server/
  - apps/gateway/migrations/
  - packages/shared/src/
---

# Integration tests

Vitest, headless. No browser, no database server, no real GitHub /
Vercel / Supabase / Railway / SSH. Discovery is centralised in
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
[`e2e-tests.md`](./e2e-tests.md)). `apps/gateway/tests/unit/components/**`
runs under `jsdom` (`environmentMatchGlobs`, deprecated by Vitest in favour
of `test.projects`; no component test exists today).

Default environment: `SKIP_LIVE=1` is injected by the runner
(`vitest.config.ts`, `test.env`) and by CI; the legacy tests that could
reach a real cloud honour it and `skip()` when the credential variables
are absent.

## Coverage

| Suite                                                                             |                                        Tests |
| --------------------------------------------------------------------------------- | -------------------------------------------: |
| `apps/gateway/src/lib/bash/exec-host.test.ts` (v4 glue)                           |                                            7 |
| `apps/gateway/tests/integration/auth/oidc-login.test.ts`                          |                                           12 |
| `apps/gateway/tests/integration/budget/pipeline-consistency.test.ts`              |                                            4 |
| `apps/gateway/tests/integration/budget/session-service.test.ts`                   |                                           19 |
| `apps/gateway/tests/integration/compose/boot.test.ts`                             |                                            4 |
| `apps/gateway/tests/integration/connections/connect-flow.test.ts`                 |                                            3 |
| `apps/gateway/tests/integration/standalone-native-addons.test.ts`                 |                                            3 |
| `apps/gateway/tests/integration/standalone-plugin-catalogs.test.ts`               |                                            2 |
| `apps/gateway/tests/integration/store/audit.test.ts`                              |                                           13 |
| `apps/gateway/tests/integration/store/config.test.ts`                             |                                            4 |
| `apps/gateway/tests/integration/store/connections-shares.test.ts`                 |                                           13 |
| `apps/gateway/tests/integration/store/delegations.test.ts`                        |                                            7 |
| `apps/gateway/tests/integration/store/identities.test.ts`                         |                                            7 |
| `apps/gateway/tests/integration/store/missions.test.ts`                           |                                            8 |
| `apps/gateway/tests/integration/store/requests-approvals.test.ts`                 |                                            8 |
| `apps/gateway/tests/integration/store/schema.test.ts`                             |                                            6 |
| `apps/gateway/tests/integration/store/sessions.test.ts`                           |                                           11 |
| `apps/gateway/tests/unit/api/members-post.test.ts`                                |                                5 (1 skipped) |
| `apps/gateway/tests/unit/api/tokens-preview.test.ts`                              |                                           12 |
| `apps/gateway/tests/unit/api/tokens-rotate.test.ts`                               |                                  2 (skipped) |
| `apps/gateway/tests/unit/lib/gateway/legacy-v4-gateway.test.ts`                   |                                            4 |
| `apps/gateway/tests/unit/lib/mint/preview.test.ts`                                |                                            4 |
| `apps/gateway/tests/unit/lib/risk-catalog/loader.test.ts`                         |                                           12 |
| `apps/gateway/tests/unit/providers/data-model-to-mermaid.test.ts`                 |                                            8 |
| `apps/gateway/tests/unit/providers/plane-filters.test.ts`                         |                                            5 |
| `apps/gateway/tests/unit/server/budget/decide.test.ts`                            |                                           15 |
| `apps/gateway/tests/unit/server/budget/fingerprint.test.ts`                       |                                            8 |
| `apps/gateway/tests/unit/server/budget/mission-state.test.ts`                     |                                            7 |
| `apps/gateway/tests/unit/server/budget/period.test.ts`                            |                                            8 |
| `apps/gateway/tests/unit/server/rate-limit/sliding-window.test.ts`                |                                            8 |
| `apps/gateway/tests/unit/server/store/db.test.ts`                                 |                                            2 |
| `apps/gateway/tests/unit/server/store/ids.test.ts`                                |                                            6 |
| `apps/gateway/tests/unit/server/store/migrate.test.ts`                            |                                            9 |
| `apps/gateway/tests/unit/structural/no-hardcoded-config.test.ts` (one per file)   |                                          111 |
| `packages/gateway-core/tests/unit/audit.test.ts`                                  |                                            6 |
| `packages/gateway-core/tests/unit/authenticate.test.ts`                           |                                           11 |
| `packages/gateway-core/tests/unit/cache.test.ts`                                  |                                            6 |
| `packages/gateway-core/tests/unit/errors.test.ts`                                 |                                           28 |
| `packages/gateway-core/tests/unit/pipeline.test.ts`                               |                                           16 |
| `packages/gateway-core/tests/unit/risk-gateway.test.ts`                           |                                            8 |
| `packages/plugin-sdk/tests/unit/catalog-loader.test.ts`                           |                                           22 |
| `packages/plugin-sdk/tests/unit/catalog-path.test.ts`                             |                                            4 |
| `packages/plugin-sdk/tests/unit/define-plugin.test.ts`                            |                                           12 |
| `packages/plugin-sdk/tests/unit/env-of.test.ts`                                   |                                            3 |
| `packages/plugin-sdk/tests/unit/registry.test.ts`                                 |                                           10 |
| `packages/plugin-sdk/tests/unit/testing-kit.test.ts`                              |                                           14 |
| `packages/policy-engine/tests/unit/qualify.test.ts`                               |                                           26 |
| `packages/policy-engine/tests/unit/risk-evaluator.test.ts`                        |                                           18 |
| `packages/policy-engine/tests/unit/risk-policy.test.ts`                           |                                            9 |
| `packages/policy-engine/tests/unit/risk-runtime.test.ts`                          |                                           18 |
| `packages/policy-engine/tests/unit/scope-injection.test.ts`                       |                                           13 |
| `packages/policy-engine/tests/unit/slice-dsl.test.ts`                             |                                           23 |
| `packages/policy-engine/tests/unit/slice-matcher.test.ts`                         |                                           29 |
| `packages/shared/src/api-key.test.ts`                                             |                                            6 |
| `packages/shared/src/mcp.test.ts`                                                 |                                           10 |
| `packages/shared/src/risk-id.test.ts`                                             |                                           20 |
| `plugins/_template/tests/unit/plugin.test.ts`                                     |                                           12 |
| `plugins/cloudflare-dns/tests/unit/data-model.test.ts`                            |                                            9 |
| `plugins/cloudflare-dns/tests/unit/plugin.test.ts` (v5)                           |                                           31 |
| `plugins/cloudflare-dns/tests/unit/risk-catalog.test.ts`                          |                                           30 |
| `plugins/cloudflare-dns/tests/unit/risk-classifier.test.ts` (v4, kept until P1.6) |                                           25 |
| `plugins/github/tests/unit/adapter.test.ts` (v4, kept until P1.6)                 |                                           18 |
| `plugins/github/tests/unit/data-model.test.ts`                                    |                                            1 |
| `plugins/github/tests/unit/execute.test.ts` (v5)                                  |                                           18 |
| `plugins/github/tests/unit/plugin.test.ts` (v5)                                   |                                           13 |
| `plugins/github/tests/unit/risk-classifier.test.ts` (v4, kept until P1.6)         |                                           31 |
| `plugins/gmail/tests/unit/data-model.test.ts`                                     |                                            5 |
| `plugins/gmail/tests/unit/plugin.test.ts` (v5)                                    |                                           25 |
| `plugins/gmail/tests/unit/q-parser.test.ts`                                       |                                           19 |
| `plugins/gmail/tests/unit/risk-catalog.test.ts`                                   |                                           43 |
| `plugins/gmail/tests/unit/risk-classifier.test.ts` (v4, kept until P1.6)          |                                           32 |
| `plugins/railway/tests/unit/adapter.test.ts` (v4, kept until P1.6)                |                                           22 |
| `plugins/railway/tests/unit/data-model.test.ts`                                   |                                            1 |
| `plugins/railway/tests/unit/plugin.test.ts` (v5)                                  |                                           25 |
| `plugins/railway/tests/unit/risk-catalog.test.ts`                                 |                                           15 |
| `plugins/railway/tests/unit/risk-classifier.test.ts` (v4, kept until P1.6)        |                                           20 |
| `plugins/resend/tests/unit/adapter.test.ts` (v4, kept until P1.6)                 |                                           12 |
| `plugins/resend/tests/unit/data-model.test.ts`                                    |                                            6 |
| `plugins/resend/tests/unit/plugin.test.ts` (v5)                                   |                                           40 |
| `plugins/resend/tests/unit/risk-catalog.test.ts`                                  |                                           32 |
| `plugins/resend/tests/unit/risk-classifier.test.ts` (v4, kept until P1.6)         |                                           46 |
| `plugins/ssh/tests/unit/bash-args.test.ts` (moved from the app)                   |                                            9 |
| `plugins/ssh/tests/unit/bash-exec.test.ts` (moved from the app)                   |                                            4 |
| `plugins/ssh/tests/unit/bash-parse.test.ts` (moved from the app)                  |                                           11 |
| `plugins/ssh/tests/unit/data-model.test.ts`                                       |                                            1 |
| `plugins/ssh/tests/unit/plugin.test.ts` (v5)                                      |                                           96 |
| `plugins/ssh/tests/unit/risk-classifier.test.ts` (v4, kept until P1.6)            |                                           39 |
| `plugins/stripe/tests/unit/adapter.test.ts` (v4, kept until P1.6)                 |                                           11 |
| `plugins/stripe/tests/unit/data-model.test.ts`                                    |                                            8 |
| `plugins/stripe/tests/unit/execute.test.ts` (v4, kept until P1.6)                 |                                           16 |
| `plugins/stripe/tests/unit/plugin.test.ts` (v5)                                   |                                           28 |
| `plugins/stripe/tests/unit/risk-catalog.test.ts`                                  |                                           17 |
| `plugins/stripe/tests/unit/risk-classifier.test.ts` (v4, kept until P1.6)         |                                           39 |
| `plugins/supabase/tests/unit/adapter.test.ts` (v4, kept until P1.6)               |                                           30 |
| `plugins/supabase/tests/unit/data-model.test.ts`                                  |                                            1 |
| `plugins/supabase/tests/unit/plugin.test.ts` (v5)                                 |                                           22 |
| `plugins/supabase/tests/unit/risk-catalog.test.ts`                                |                                           33 |
| `plugins/supabase/tests/unit/risk-classifier.test.ts` (v4, kept until P1.6)       |                                           30 |
| `plugins/upstash-redis/tests/unit/adapter.test.ts` (v4, kept until P1.6)          |                                           16 |
| `plugins/upstash-redis/tests/unit/data-model.test.ts`                             |                                            1 |
| `plugins/upstash-redis/tests/unit/plugin.test.ts` (v5)                            |                                           24 |
| `plugins/upstash-redis/tests/unit/risk-catalog.test.ts`                           |                                           49 |
| `plugins/upstash-redis/tests/unit/risk-classifier.test.ts` (v4, kept until P1.6)  |                                           30 |
| `plugins/vercel/tests/unit/adapter.test.ts` (v4, kept until P1.6)                 |                                           23 |
| `plugins/vercel/tests/unit/data-model.test.ts`                                    |                                            1 |
| `plugins/vercel/tests/unit/plugin.test.ts` (v5)                                   |                                           23 |
| `plugins/vercel/tests/unit/risk-catalog.test.ts`                                  |                                           60 |
| `plugins/vercel/tests/unit/risk-classifier.test.ts` (v4, kept until P1.6)         |                                           31 |
| `apps/gateway/src/server/**/*.test.ts` (v5, P0.4 + P0.R + P1.1)                   |                                          111 |
| **TOTAL** (`npm run test`, 2026-10-13, P1.2-align)                                | **1931 (8 skipped without a build, 3 with)** |

Skipped: `members-post` (1), `tokens-rotate` (2), both legacy v4, and the
five standalone tests (`standalone-native-addons` 3,
`standalone-plugin-catalogs` 2) when `.next/standalone` is absent —
`npm run ci` builds first, so they run there. The plugin rows reflect the
ten plugins on the v5 SDK (P1.2, aligned by P1.2-align); the v4 `adapter`
and `risk-classifier` suites are kept until P1.6 deletes the legacy
exports they cover.

## Run

```bash
npm run test                              # full suite, headless
npm run test:watch                        # file-watcher mode for local dev
npx vitest run packages/policy-engine     # one package
```

## Scenarios — Policy engine (v4 model, v5 runtime)

> Covers: `docs/spec/gateway-risk-model.md` §3 (DSL), §4 (catalog), §8
> (runtime). Handbook [[policy-engine]]. The package is a v5 dependency of
> gateway-core and the plugin SDK; only the deprecated `bindings` bridge is
> v4.

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
- **`risk-runtime.test.ts`** — `evaluateCall` allow (feature branch +
  fallback, read code), deny (missing risk, explicit deny, empty slices,
  no catalog match), multi-slice (all risks covered, one missing fails),
  env qualification through `resourceEnvResolver` (staging vs prod
  resource, `acceptable_in_envs` runtime filter), no resolver →
  unqualified, deprecated `bindings` input through the legacy bridge, every
  denial carries `code: 'risk-not-accepted'`, `evaluateCallSimple` happy
  path.
- **`scope-injection.test.ts`** — `injectionPlanFor` (github owner/repo,
  vercel projectId + teamId, supabase project_ref; null with 0 or 2+
  bindings, null on a malformed resource_ref), `stripInjectedArgs` (removes
  properties and required, no-op when nothing applies, no mutation),
  `mergeInjectedArgs` (fills missing, caller override wins, empty string
  counts as missing).
- **`qualify.test.ts`** (21) — `isEnvScopedEntry` (true when
  `acceptable_in_envs` is non-empty), `qualifyRiskId` (injects `[env]`
  before the first `.`, idempotent, no-op when account-scoped, env-scoped
  cases via `test.each`), `unqualifyRiskId` (strip + idempotent), round-trip
  property, `resourceEnvResolver` / `noEnvResolver` (ref match, provider
  mismatch, no env label).

## Scenarios — Plugin SDK (v5)

> Covers: `docs/spec/vaubaan-gateway.md` §5 (plugins), §3.2 (presets), §10
> (structural tests: at least one preset per plugin, every preset entry a
> risk of its own catalog, never a wildcard). ADR
> [[plugin-contract-and-credential-spec]]. Handbook [[plugin-sdk]].

- **`catalog-loader.test.ts`** — loads the `acme` fixture YAML (provider,
  `catalog_version`, date scalar kept as a string, optional fields,
  presets with default gate); collected, path-qualified errors: duplicate
  id, malformed id, id of another provider, malformed slice pattern,
  missing fallback (error, or accepted with `requireFallback: false`),
  zero presets (error, or accepted with `requirePresets: false`), preset
  entry referencing a foreign or unknown risk, env-qualified entry on a
  non-env-scoped risk or outside `acceptable_in_envs`, wildcard or
  sentinel in a preset entry, non-integer budget or unknown gate,
  deprecated risk in a preset, unknown keys and bad enum values, provider
  slug, YAML syntax error naming the source; the fallback rules (exactly
  one entry by flag, pattern or id; `fallback: false` opts out; a preset
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
  missing functions; `expectCredentialKind`; `normalizeArgsIfEnabled`
  (off by default, on with the flag, no hook no change).
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
- **`plugins/_template/tests/unit/plugin.test.ts`** — the four kit
  assertions on the template, classifier cases (named workspace, single
  resource default, ambiguous or malformed workspace, malformed id,
  unknown tool, slice round-trip), `execute` and `discoverResources`
  against `mockFetch` (bearer header, PATCH body, 401 →
  `UpstreamAuthError`).
- **`plugins/upstash-redis/tests/unit/plugin.test.ts`** (P1.2h, handbook
  [[providers/upstash-redis]]) — the four kit assertions with one sample
  per tool (21 tools, every named risk reached; the fallback left out on
  purpose); presets (`read-only`, `developer` key-level on `development` /
  `staging` only, `operator` approval gates, no preset carries the
  fallback); classifier conventions: `databaseId` resolved against the
  mission's resources (single-database default, ambiguous / missing /
  foreign / malformed refused, account-level tools need none), `execute`
  routed on the Redis verb (read, write, FLUSH marker, unknown verb
  catch-all, empty or non-array command), keys that are not slice idents
  (`session:1`, braces, globs) and multi-key DEL fall back to `[*]`, slice
  round-trip; environment resolved from the database resource label via
  `resourceEnvResolver` (account-rooted slices: single label or null);
  credential spec (`email` non-secret, `api_key` secret, `upstashAuth`
  kind / field / pattern checks); `execute` against `mockFetch` (Basic
  auth on the Management API, REST tokens redacted from answers, data
  tool reads `rest_url` + `rest_token` then POSTs the command with the
  Bearer, SET flags, refusals before any network call, 401/403 →
  `UpstreamAuthError` on both surfaces, 500 and malformed arguments as
  `isError`); `discoverResources` (one resource per database, metadata
  without tokens, `env` left to the owner, 200 cap with a logger
  warning, 403 → `UpstreamAuthError`). The v4 suites `risk-classifier`
  (30, through the `classifyUpstashRedisV4` shim), `risk-catalog` (49,
  lint on the YAML) and `adapter` (16) run unchanged until P1.6.

## Scenarios — Shared (v5 additions)

- **`risk-id.test.ts`** — `parseRiskId` both forms, hyphenated provider
  and dotted name, eleven malformed inputs rejected; `formatRiskId`
  round-trip and null/empty env; `baseRiskId`; `isProviderId`;
  `isExplicitRiskId` (wildcards rejected).
- **`mcp.test.ts`** — `toolPrefixFor` / `splitToolName` (hyphen ↔
  underscore, first separator only, malformed names); the eight refusal
  codes of spec §4.1 and §6; `isRefusalCode`.

## Scenarios — Provider plugins (v5 SDK)

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
reaches a provider.** The v4 `adapter` and `risk-classifier` suites are kept
unchanged on the `@deprecated` exports until P1.6 deletes them; the YAML ↔ TS
sync suites are gone with the TypeScript catalog twins. Counts per plugin are
the `plugins/<id>` totals of the table above.

**Template** (12) — `plugin.test.ts`: the kit on the scaffold, a classifier
case per convention (ref from the arguments, single-resource default,
ambiguity denied), `execute` against `mockFetch`, the catalog path resolved
with `catalogPathNextTo` and present on disk.

**GitHub** (81) — `plugin.test.ts` (13): structural kit, catalog coverage of
every declared tool, the fallback lint, presets `read-only` / `developer` /
`release-manager`, the `app-install` credential spec. `execute.test.ts`
(18): installation token minting (JWT → `access_tokens`), per-call
repository scoping, Octokit dispatch over the injected fetch,
`UpstreamAuthError`, `github__mint_install_token`, paged resource discovery.
`risk-classifier` (31, v4 cases kept through the shim), `adapter` (18, v4),
`data-model` (1). No `envOf`: the catalog has no env-scoped risk.

**Vercel** (138) — `plugin.test.ts` (23): kit (every named risk touched),
project resolution against the mission's resources, `vercelEnvOf` and the
plugin's `envOf` composed with `envResolverFor` (the slice's `env[prod]`
wins over an owner label, an env-less slice falls back to it), `api-key`
credential spec, `execute` (rewrap of mcp.vercel.com and the custom REST
tools) and `discoverResources` against `mockFetch`. `risk-catalog` (60):
YAML structural validation, every pattern parses, coverage lint, saliency
checks. `risk-classifier` (31, v4), `adapter` (23, v4), `data-model` (1).

**Supabase** (116) — `plugin.test.ts` (22): kit with one sample per tool
(44 tools; `row-write-one`, `db-role-write`, `extension-write` and
`auth.bulk-user-write` knowingly unreached), presets, `oauth2` credential
spec (PKCE, Basic client auth, `refreshable` with no plugin `refresh`),
`execute` (read-only `execute_sql`) and `discoverResources` against
`mockFetch`. `risk-catalog` (33): loaded shape, posture-sensitive entries,
coverage lint, cardinality mutual exclusion, decision-level spot checks.
`risk-classifier` (30, v4), `adapter` (30, v4), `data-model` (1).

**Railway** (83) — `plugin.test.ts` (25): kit (the nine named risks touched,
no fallback hit), `classifyRailway` on `Resource[]` (project and environment
resolution, denials), `oauth2` credential spec (PKCE, `resourceIndicator`,
`prompt=consent`, no plugin `refresh`), `executeRailway` (rewrap of
mcp.railway.com with the stripped tool name, GraphQL variable tools) and
`discoverRailwayResources` against `mockFetch`. `risk-catalog` (15): shape,
`prepareCatalog`, runtime `risksTouchedBy`, coverage. `risk-classifier`
(20, v4), `adapter` (22, v4), `data-model` (1).

**SSH** (160) — `plugin.test.ts` (96): kit (every catalog risk touched by
one `ssh__exec` sample); presets `read-only` / `developer` / `operator`
(developer never touches prod, packages, destructive or sudo; no preset
references the fallback); `classifySsh`: host resolution against the
mission's resources (single host default, explicit ref, foreign / ambiguous
/ malformed denied), read vs write, `secret-file` marker, `destructive` /
`package` / `service` / `privilege` markers, `sudo` on a whitelisted verb
stays a read, mixed lines touch both sides, substitutions and file
redirections force `W`, `2>&1` does not, quotes honoured; runtime
qualification through `resourceEnvResolver` (`ssh[prod].exec-destructive`
missing → denied; unlabelled host never qualifies a write);
`splitCommandLine`; `isDestructive` / `isPackageInstall` /
`isServiceControl` tables; credential spec (`ssh-key`, four fields with
patterns, `sshTarget` narrowing and refusals); `fingerprintOf` /
`hostKeyMatches` (OpenSSH SHA256 form, padding tolerated); `execute` over a
fake `SshTransport` (default and clamped timeout, abort signal, non-zero
exit is not an error, refusals before any connection, `UpstreamAuthError` /
`SshHostKeyMismatchError` / timeout propagate, wrong credential kind);
`discoverResources` (probe → one resource with uname facts, failing probe
tolerated, auth failure propagates). `bash-{parse,exec,args}` (24): the v4
parser suites moved unchanged from `apps/gateway/src/lib/bash`.
`risk-classifier` (39, v4), `data-model` (1). No test opens a socket.

**Resend** (136) — `plugin.test.ts` (40): kit, the `from` domain as the
resource, recipient zones and counts, batch sends, domains / segments /
contacts, broadcasts verified against the named segment, misc denials,
`execute` and `discoverResources` against `mockFetch`, `api-key` credential
spec and presets `read-only` / `developer` / `marketing-operator` /
`domain-admin`. `risk-catalog` (32): shape (caps kept on the bulk entries,
exact irreversible set, only the exfiltration risk env-scoped, no preset on
the fallback, the two deprecated v4 ids) and slice → risk resolution.
`risk-classifier` (46, v4), `adapter` (12, v4), `data-model` (6).

**Upstash Redis** (120) — `plugin.test.ts` (24): kit (every named risk
touched, no fallback hit), database resolution against the mission's
resources and verb routing of `execute`, environment from the owner label
of the database resource, `api-key` credential spec (email + Management API
key), `execute` (REST tokens redacted) and `discoverResources` against
`mockFetch`. `risk-catalog` (49): YAML validation, pattern parsing, coverage
lint, saliency checks. `risk-classifier` (30, v4), `adapter` (16, v4),
`data-model` (1).

**Stripe** (119) — `plugin.test.ts` (28): kit (every named risk touched, no
fallback hit), resource resolution and `modeOf` (ref suffix, metadata, env
label), argument handling, `execute` (form-encoded REST v1) and
`discoverResources` (one resource per mode) against `mockFetch`, `api-key`
credential spec. `risk-catalog` (17): 16 named risks + fallback at catalog
v3, every risk env-scoped on the mode, no preset carries the fallback, caps
and infra limits on `refund-create` / `payout-create`, slice → risk
resolution including the `payment-intent.W` side effect of
`create_subscription` resolving to `subscription-create` and a novel write
to the fallback alone. `risk-classifier` (39, v4), `execute.test.ts` (16,
v4 REST dispatcher), `adapter` (11, v4), `data-model` (8).

**Cloudflare DNS** (95) — `plugin.test.ts` (31): kit (15 tools, every risk
touched), zone resolution (single zone default, explicit `zone_id`, foreign
provider denied), record writes with the `critical` / `delete` overlays,
`isCriticalRecord` / `recordSensitivity`, `execute` (pre-flight read on
`update_record`) and `discoverResources` (one resource per zone) against
`mockFetch`, `api-key` credential spec and presets `read-only` /
`dns-operator` / `zone-admin`. `risk-catalog` (30): shape, `prepareCatalog`,
coverage lint, `risksTouchedBy` sanity checks (a categorized write never
touches the fallback; `zone-delete` only on the zone itself).
`risk-classifier` (25, v4), `data-model` (9).

**Gmail** (124, experimental) — `plugin.test.ts` (25): kit, the experimental
shape (`experimental: true`, version below 1.0, no tool exposed), coverage
through a tool-exposing variant of the plugin (`bulk-label-write` knowingly
unreached), mailbox selection (none, foreign, ambiguous), `oauth2`
credential spec (Google, PKCE, `client_secret_post`, offline consent, no
plugin `refresh`), `discoverResources` and the structured `not_implemented`
answer of `execute` against `mockFetch`, presets `read-only` / `developer`.
`risk-catalog` (43): loaded catalog lint, pattern parsing, per-tool
coverage, `risksTouchedBy` spot checks. `risk-classifier` (32, v4),
`q-parser` (19), `data-model` (5).

## Scenarios — gateway-core (v5)

> Covers: handbook [[gateway-core]]. Spec: `vaubaan-gateway.md` §4.1, §6,
> §8, §10 ("structured refusals", "credential separation");
> `gateway-risk-model.md` §8.

`packages/gateway-core/tests/unit/`, vitest, no network, no store.

- **`risk-gateway.test.ts`** (8) — the pure decision core
  `evaluateCallForToken`: allow, deny with missing risks and
  `code: 'risk-not-accepted'`, classify-denied, no-catalog (fail closed),
  denied_risks shadow, the classifier receives `(tool, args, resources)`,
  environment qualification from the adapter's `envOf` first (a derived
  env wins over the owner label, an abstaining hook falls back to it), then
  the mission's resources, and an explicit `envResolver` overriding both,
  `denyResponseBody`. The decision is
  unchanged since v4; its inputs are the v5 `Resource[]` and the plugin's
  `classify` (P0.R).
- **`errors.test.ts`** (24) — the eight refusal codes: exactly eight in
  `REFUSAL_CODES`, one builder sample per code, every field of every code,
  `hint` non-empty and serializable, `isRefusal` guard, JSON-RPC mapping
  (`-32603`, refusal in `data`, code in the message).
- **`audit.test.ts`** (6) — `hashArguments` is sha256 truncated to 16 hex
  (known vector for `{}`), deterministic, null/undefined ≡ `{}`;
  `MemoryAuditWriter` over call and administrative entries; a call entry
  carries every spec §8 field.
- **`cache.test.ts`** (6) — `MemoryCacheClient`: TTL expiry, delete, bound
  evicts the oldest, re-set refreshes age, expired swept before a live
  eviction, invalid bound rejected.
- **`authenticate.test.ts`** (11) — credential separation: door table,
  `checkDoor` on every mismatch (mission token at management, delegated
  token at execution, session at either) → `wrong-credential-kind` with
  door/presented/expected; `parseBearer`; `DoorAuthenticator` end to end;
  unknown bearer → `AuthError`, not a refusal.
- **`pipeline.test.ts`** (15) — `checkMissionActive` (status, passed and
  future `expires_at`), `checkConnectionAvailable`; `CallPipeline` over a
  context built from the shared types (`ConnectionResource`, policy entry
  list, one-off period): happy path with the full audit entry, inactive
  mission refused before anything else, `resource-not-in-mission` before
  any risk evaluation, expired connection, `risk-not-accepted` through the
  real decision core fed with the resources of the target connection and
  the budget untouched, structural rejections without a code, budget
  refusal with no upstream call, approval id carried to the audit, upstream
  failure after allow (`decision: allowed`, `upstream_error`), audit write
  failure propagates.

Legacy v4 orchestration (`McpGateway`), moved to
`apps/gateway/tests/unit/lib/gateway/legacy-v4-gateway.test.ts` (4):
upstream-error audit shape, missing binding, happy path. Deleted with the
v4 app code at P1.6.

> **Gaps.** The budget stage, the resource stage and the upstream stage
> are interfaces with test stubs; their real implementations and tests are
> P1.3, the authority feature and P1.2. Spec §10 "budget" and "approval"
> bullets are therefore still open.

## Scenarios — Web routes & libs (legacy v4, deleted in Phase 1)

> Covers: handbook [[web-app]] (legacy). These suites test the v4 SaaS
> routes (Supabase clients mocked, org-scoped bindings) and go with the v4
> app code when P1.6 replaces `/mcp` and the UI.

`apps/gateway/tests/unit/`. The Next.js routes are imported directly (no
fetch); the Supabase clients are mocked.

- **`api/members-post.test.ts`** (5, 1 skipped) — `POST /api/v1/members`:
  unauthenticated rejected; validation 400 (missing orgSlug, invalid email,
  missing body fields); 409 when the user is already a member.
- **`api/tokens-preview.test.ts`** (12) — `POST /api/v1/tokens/preview`:
  `resolveRiskRow` (unknown risk → blocked, undefined catalog → blocked,
  env-scoped qualification, parent inherited path, account-scoped
  passthrough, env outside `acceptable_in_envs`, parent missing the risk,
  null parent → optimistic inherited); `computePreview` (ok=false when one
  row is not acceptable, ok=true when all are, risk outside the bindings
  rejected, expansion per binding, one row per (risk, binding)).
- **`api/tokens-rotate.test.ts`** (2, skipped) — the Bearer auth setup
  was never unblocked; deleted with the v4 routes.
- **`lib/mint/preview.test.ts`** (4) — `computeMintPreview`: inherited +
  acceptable → ok=true, parent missing → not_inherited, binding env outside
  `acceptable_in_envs` → not_acceptable, null parent → optimistic
  inherited.
- **`lib/risk-catalog/loader.test.ts`** (12) — `__setCatalogForTests` seam
  (clear, set, override, undefined) + `qualifyRiskId` / `unqualifyRiskId`
  (round trip, account-scoped passthrough, already-qualified defensive).
- **`providers/data-model-to-mermaid.test.ts`** (8) — mermaid `erDiagram`
  rendering of the data model: header, kebab-case ids, env suffix,
  bounded/unbounded cardinalities, plane filter via `planeSlug`, root ORG
  binding, unique classDef.
- **`providers/plane-filters.test.ts`** (5) — `risksForPlane`
  (plane-unique entities, wildcards included everywhere, unknown plane →
  empty) + `toolsForPlane` (single-plane provider → every tool, multi-plane
  → filtered by `toolPlanes`).

## Scenarios — Bash provider (lib, legacy v4)

> Covers: handbook [[bash-provider]]. Goes with the SSH plugin migration
> (P1.2).

`apps/gateway/src/lib/bash/` (the `.test.ts` files sit next to the code):

- **`parse.test.ts`** (11) — `parseAnnotatedBash`: multi-ring happy path;
  every rejection branch (missing `rings`, unknown ring, invalid action,
  `@vaubaan-arg` without a name, no annotated tool); private helpers
  ignored; `@vaubaan-arg` typing.
- **`exec.test.ts`** (4) — `buildToolInvocation`: base64 + `bash -s --`;
  POSIX single-quote escaping; empty args; multi-line content; `parse →
build` integration.
- **`args.test.ts`** (9) — `materializeArgs`: required + no default →
  error; required + default → default (rescue); optional + default;
  optional + no default → ''; present raw stringify; integer typing; empty
  string treated as missing; positional order.
- **`exec-host.test.ts`** (7) — `loadHostByIdInOrg` / `loadHostBySlugInOrg`
  - `execOnHost`: org-scope check; bytea → PEM decode; `sshExec` happy path;
    SSH error propagation; no host found.

## Scenarios — Shared (legacy helper)

- **`api-key.test.ts`** (6) — `generateApiKey` / `parseApiKey` /
  `hashApiKey` / `verifyApiKey`; the prefix is preserved; the v4
  `vbn_mgmt_` form is rejected. The v5 additions are listed above.

## v5 — Instance configuration, crypto, composition root (P0.4)

> Covers: spec §4.3 (instance configuration, admin rule), §6 (encryption
> at rest, no secret in logs), §10 structural "no configuration value is
> hard-coded". Handbook [[configuration]], ADR
> [[docker-image-and-config-format]]. Co-located under
> `apps/gateway/src/server/**` (English, v5).

- **`config/load.test.ts`** (27) — minimal env-only configuration with
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
  `previous_keys` duplicate version, `*_FILE` alone and both-set error.
- **`config/duration.test.ts`** (2) — `30s 10m 24h 7d`; rejects the rest.
- **`crypto/aead.test.ts`** (12) — round trip and `keyVersion` stamp, fresh
  nonce, **AD mismatch** (other connection id) fails, tampered blob,
  short blob, unknown format byte, empty and unicode plaintext, empty
  connection id; **`key_version` honoured**: v2 encryptor opens v1 blobs
  through `previous_keys`, seals with v2, v1 cannot open v2, unknown
  version names `encryption.previous_keys`, right version wrong key fails;
  `deriveConnectionKey` deterministic and distinct per id and per master
  key.
- **`logging/logging.test.ts`** (5) — mission token prefix kept, secret
  dropped; configured secrets replaced longest-first and JSON-escaped;
  JSON line shape with bindings; level threshold and stderr routing.
- **`compose/compose.test.ts`** (15) — `buildRoot` from configuration
  alone over the `:memory:` store (schema v1, empty registry); the store
  receives the root's encryptor and a `RegistryCatalogIndex` (base ids,
  env-qualified ids within `acceptable_in_envs`, unknown provider,
  wildcard refused) and is closed with the root; provider apps are a
  warning while no plugin is registered and a `ConfigError` naming
  `providers.<id>` and `VAUBAAN_PROVIDER_<ID>_*` (exit 78) once a plugin
  is; `checkProviderApps` passes on matching or absent apps; no secret in
  the boot log; `getRoot` builds once and shares the promise, forgets a
  failed build; `bootOrExit` exits 78 naming the key, 1 on other failures,
  nothing on success; `MemoryRateLimiter` window and reset, `MemoryCache`
  TTL and eviction, `MemorySessionStore`.
- **`http/healthz.test.ts`** (3) — 200 with build stamps and store kind
  (`memory`) and no configuration value, 503 degraded on store ping
  failure, 503 unavailable when the root cannot be built.
- **`tests/integration/compose/boot.test.ts`** (4) — the production
  wiring against a temporary SQLite file: the database is created, the
  migrations applied (`schema_version` 1, one `schema_migrations` row),
  the store pings and `/healthz` reports `{ kind: 'sqlite', status: 'ok' }`,
  the boot log carries `store opened`; a store secret is sealed with the
  encryptor built from the configuration (blob not clear text, current
  `key_version`) and reopens after a second boot without re-migrating; a
  risk id the registry does not know is refused
  (`UnknownRiskIdError`); an unreadable `store.path` exits 1 with a
  message naming `store.path` and `VAUBAAN_STORE_PATH`.
- **`apps/gateway/tests/unit/structural/no-hardcoded-config.test.ts`**
  (one test per scanned file, 56 at P0.R) — no literal URL, Supabase ref, GitHub /
  Stripe / mission token, private key or JWT in `apps/gateway/src/server`,
  `instrumentation.ts`, `app/healthz`, `next.config.ts`, `deploy/`,
  `scripts/`, `.github/workflows`; only `telemetry-default.ts` and
  `deploy/config/*.example*` are exempt. Scope widens as v4 code is deleted;
  P1.4 added the Connections and Provider apps pages and their components
  (111 files at P1.4).
- **`apps/gateway/tests/integration/standalone-native-addons.test.ts`** (3,
  P0.6) — reads the build output and is skipped when `.next/standalone` is
  absent (CI builds before testing): the `/healthz` route handler trace lists
  the `argon2` and `better-sqlite3` `.node` binaries; a Node process started
  inside the standalone tree resolves both packages from the standalone
  `node_modules` (not the repository's), hashes with argon2 and runs a query
  on an in-memory SQLite database.

Container smoke (`deploy/docker/smoke.sh`, CI job `docker`): see
[`e2e-tests.md`](./e2e-tests.md).

## v5 — Human authentication: OIDC, web session, bootstrap, admin rule (P1.1)

> Covers: spec §0 (Operator, User, Group, IdP), §4.2 Administration, §4.3
> (IdP block, bootstrap token, admin rule), §6 "human authentication"
> (short sessions bound to the origin, origin check on every mutation), §7.1,
> §10 integration "simulated IdP" and structural "authority recomputed from
> current membership". Handbook [[authentication]], ADR
> [[oidc-relying-party-and-web-session]].

- **`server/auth/claims.test.ts`** (8) — groups claim as array (trimmed,
  de-duplicated, non-strings dropped), as space/comma/semicolon delimited
  string, absent or of another type; default and custom (Entra-style)
  mapping; email lower-cased, `name` → display name; missing `sub` /
  `email` fail closed naming the claim(s) (`LoginError` `claims-missing`);
  allowed email domains (empty list = any, case-insensitive, no `@`).
- **`server/auth/admin-rule.test.ts`** (5) — group match, email match
  (case-insensitive), neither, either half of a combined rule,
  `describeAdminRule` without secrets.
- **`server/auth/origin.test.ts`** (5) — matching `Origin`; another origin,
  scheme or the internal host refused; `Referer` fallback; neither header
  or `Origin: null` refused; 403 body `origin-mismatch`.
- **`server/auth/session-service.test.ts`** (5) — cookie attributes
  (`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age`), malformed values
  ignored; user session created / read / destroyed; **absolute expiry** at
  `SESSION_TTL_MS` (8 h); pending logins apart from sessions, single use,
  10-minute TTL.
- **`server/auth/bootstrap.test.ts`** (3) — exact token accepted while
  active, variants refused; `unavailable` without a configured token;
  revocation persisted in `instance_config`, durable across services,
  idempotent (first timestamp kept), token refused afterwards.
- **`server/auth/idp-settings.test.ts`** (6) — none until saved, then read
  back from the store (`source: store`); client secret **sealed**
  (`secret_blob`, associated data `instance_config:idp.client_secret`);
  blank secret keeps the stored one; every problem reported at once, http
  issuer only with `allowInsecureIssuer`; file configuration wins and makes
  the service read-only; `splitList`.
- **`server/auth/handlers.test.ts`** (2) — `safeReturnTo`: same-origin
  paths kept; URLs, `//host`, `/\host` and relative junk fall back.
- **`server/session/sqlite-session-store.test.ts`** (6) — round trip,
  unknown id, TTL expiry and sweep on write, overwrite of value and
  expiry, non-positive TTL refused, durability across handles on the same
  database.
- **`tests/integration/auth/oidc-login.test.ts`** (12) — the composition
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
  12. sessions are rows of `web_sessions`.

## Scenarios — Crypto (app-level encryption) — legacy v4

> The v4 `provider-secrets.test.ts` moved to
> `apps/gateway/src/server/crypto/aead.test.ts` (P0.4) and tests the v5
> per-connection scheme; `apps/gateway/src/lib/crypto/index.ts` is now a
> shim over it. ADR [[per-org-encryption-app-level]] is legacy.

## Scenarios — Store (v5, embedded SQLite)

> Covers: spec [`vaubaan-gateway.md`](../spec/vaubaan-gateway.md) §2, §3.3,
> §3.5, §6 ("encryption at rest", "authoritative, atomic counting",
> "immutable audit"), §8, §10 (structural tests). Handbook [[store]]. ADR
> [[embedded-store-sqlite-and-migrations]]. Every suite runs on an
> ephemeral `:memory:` store with the real `0001_schema.sql`, a
> `ManualClock`, a `StubEncryptor` and a five-id `SetCatalogIndex`
> (`apps/gateway/src/server/store/testing.ts`); the two file-based cases
> use a temp directory.

- **`unit/server/store/ids.test.ts`** (6) — UUIDv7 canonical form and
  version/variant bits, embedded millisecond timestamp, ordering across
  milliseconds, strict monotonicity of 5k ids within one process (counter
  in `rand_a`), 10k uniqueness, rejection of non-v7 ids.
- **`unit/server/store/migrate.test.ts`** (8) — `NNNN_name.sql` loading
  and ordering, malformed file name rejected, duplicate version rejected,
  idempotent re-run, incremental apply of a new file, checksum
  immutability of an applied file (boot refused), full rollback of a
  failing file (nothing recorded, no table left), shipped `0001_schema`.
- **`integration/store/schema.test.ts`** (6) — the 28 tables of the plan
  exist; every table is `STRICT`; the store satisfies the composition root's
  `Store` port (`kind`, `ping()`, `close()`); boot against an empty file sets WAL,
  `foreign_keys`, `synchronous=NORMAL` and reopens without re-migrating;
  two writers on one file serialize under `BEGIN IMMEDIATE` (second gets
  `SQLITE_BUSY` while the lock is held, succeeds after commit);
  `VACUUM INTO` backup is a readable single file with no `-wal`.
- **`integration/store/audit.test.ts`** (12) — gateway-core
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
- **`integration/store/identities.test.ts`** (7) — users: upsert from
  IdP creates then refreshes (email, last login), lookups, removal and
  reactivation; groups: `getOrCreate` idempotent, atomic membership
  replacement and `groupsOf`, single add/remove, FK rejection of a
  non-user member.
- **`integration/store/connections-shares.test.ts`** (11) — connection
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
- **`integration/store/sessions.test.ts`** (9) — session born on first
  call and never recreated; **N=50 concurrent `decideAndDecrement` on
  quota 1 → exactly one allow**, 49 refusals, one counter at 1; a call
  touching N risks decrements N counters and a refusal none; new period
  starts at zero; a thrown decider rolls back the session creation;
  in-transaction approval consumption is single-use; request drop and
  extra events from inside the refusal transaction; `resetCounters` and
  `listEvents` since/limit; **structural check**: `session_counters`
  consumed == allowed audit touches after a mixed run.
- **`integration/store/requests-approvals.test.ts`** (8) — approval
  request arguments sealed with `request:<id>` as associated data and
  readable only through `getArguments`; approval requires tool and
  fingerprint; decision erases the blob and a second decision is refused;
  sweeper expires open requests and erases blobs; inbox lists only the
  creator's open requests. Approvals: single-use and bound to the exact
  fingerprint and risk, expiry, one approval per request.
- **`integration/store/delegations.test.ts`** (7) — public client with
  de-duplicated redirect URIs, consent listing, single-use and expiring
  codes, refresh-token rotation chain (`revoked_at`, `replaced_by_id`),
  access token found only while live and delegation active, delegation
  revocation cascades to tokens, mission issued by delegation records
  the delegation id.
- **`integration/store/config.test.ts`** (4) — clear values overwrite,
  secrets sealed with `instance_config:<key>` and `key_version` stamped,
  a key is a value or a secret never both, delete.

> **Not covered here, by design.** The accounting rules (period
> arithmetic, quota/rate comparison, gate handling) are the budget's
> `decide` callback, tested in the section below against this primitive.
> The real `Encryptor` (XChaCha20-Poly1305, per-blob KDF,
> `apps/gateway/src/server/crypto/`) has its own suite; the store's stub
> only reproduces the port's associated-data and key-version contract.

## Scenarios — Budget and sessions (v5, P1.3)

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
> gated `approval`; daily period anchored 2026-10-13).

- **`unit/server/budget/period.test.ts`** (8) — `periodIndex` at the
  anchor, the last millisecond, the boundary (belongs to the next period),
  a week later, before the anchor (period 0); zero, negative, fractional
  length and malformed anchor refused; `currentPeriod` for a recurring
  mission (start = counters key, end = reload), a one-off mission (single
  open-ended period at the anchor, whatever `now`), an anchor spelled with
  an offset normalised to canonical ISO; `periodSpecOf` borrowing the
  stored anchor for a one-off `Period`.
- **`unit/server/budget/fingerprint.test.ts`** (8) — recursive key
  sorting with array order kept, `undefined` members dropped and array
  holes as `null`, `toJSON` (dates), primitives, `NaN` → `null`, BigInt
  refused; sha256 hex of the canonical JSON against a computed vector, key
  order ignored but one value change not, `undefined`/`null` arguments =
  `{}`, contrast with gateway-core's order-sensitive `hashArguments`.
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
- **`integration/budget/session-service.test.ts`** (19) — session born on
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
  session); `stateOf` with rollover, expiry and stored statuses.
- **`integration/budget/pipeline-consistency.test.ts`** (4) — the
  `BudgetStage` inside the real `CallPipeline` with `SqliteAuditWriter` and
  stub resource / risk / upstream stages: after a mixed run (allowed,
  allowed-then-upstream-failed, exhausted, approval-required, a concurrent
  burst of 8 with a window of 5, a later exhausted multi-risk call, one
  more allowed) **`SUM(session_counters) == COUNT(audit allowed)` per risk**
  via the reusable `countersAgreeWithAudit`; **an allowed call that fails
  upstream keeps its credit** (`decision: allowed`, `upstream_error`,
  next call `budget-exhausted`); a one-off mission's open-ended period
  (anchor read from the store); a mission with no session yet reports zero
  everywhere.

## v5 — Connections, resources, provider apps (P1.4)

> Covers: spec §0 (Connection, Resource), §2.3 connection states, §4.2
> Connections and Administration, §6 (encryption at rest, anti-replay and
> anti-redirect, per-user rate limit on connection flows), §7.2. Handbook
> [[connections]], ADR [[connect-driver-and-resource-curation]]. No test
> reaches a provider: outbound HTTP is `mockFetch`, which rejects any
> request no route covers; plugins are `fixturePlugin()` (one
> `CredentialSpec` per kind) except in `shipped-providers.test.ts`.

Unit, co-located under `apps/gateway/src/server/connections/` and
`apps/gateway/src/server/provider-apps/` (102):

- **`oauth2.test.ts`** (15) — authorization URL (code flow, state, S256
  challenge, RFC 7636 appendix B vector, resource indicator, extra
  parameters that cannot override the core ones, PKCE required when the
  spec says so); code exchange with `client_secret_basic` (form-encoded
  Basic), `client_secret_post`, public client; `resource` on the token
  request; `expires_in` and comma-delimited scopes; a rejected grant
  carries the provider's `error: description` and never the client
  secret; an error body under HTTP 200; 5xx / network / missing
  `access_token` are not rejections; refresh rotates the refresh token,
  keeps it when none is returned, is a rejection without one.
- **`service.test.ts`** (24) — the connect driver per credential kind:
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
  - `app-install`: installation URL with the state, installation id
    stored, the plugin receives the app's private key; replay, missing id
    ("awaiting approval"), malformed id and an installation the provider
    rejects store nothing;
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
    `provider-mismatch`; `connection-revoked`), revoke (terminal, blob
    erased, idempotent, audited once);
  - resources: **owner label, display name, hidden flag and list settings
    survive a re-discovery** while provider facts are refreshed; a
    vanished resource is marked stale (first date kept) and cleared when
    it returns; a plugin-set environment is read-only and follows the
    plugin, an invalid plugin label is dropped; edits are validated
    before any write; a failed refresh changes nothing; a rejected
    credential that cannot be refreshed expires the connection.
- **`credentials.test.ts`** (12) — `resolve` hands the decrypted secret
  and an app config without the client secret; a token inside the 60 s
  skew is refreshed, the rotated refresh token is persisted (sealed again)
  and presented at the next refresh; a non-active connection is refused;
  no expiry / no refresh token → used as is; concurrent refreshes run one
  grant; `invalid_grant` → `expired` + `UpstreamAuthError`; 503 → still
  `active`; missing app configuration → still `active`; api key and
  oauth2 without refresh token → `expired`; a revocation during the
  refresh is never undone; a plugin `refresh()` replaces the generic
  grant; a rejecting plugin refresh expires, any other failure does not.
- **`pending.test.ts`** (7) — state single use, bound to the user, burnt
  by a foreign attempt, malformed / unknown refused, TTL, two concurrent
  callbacks → exactly one; notices read once by their web session.
- **`input.test.ts`** (17) — field reading; `resolveReturnTo` (nine
  refused shapes including userinfo, port and scheme tricks); names;
  environment labels; editable metadata keys; list parsing.
- **`codec-and-keypair.test.ts`** (12) — the four `CredentialSecret` kinds
  round-trip, malformed stored text refused; the generated ed25519 key is
  parsed by `ssh2`, matches its public line and signs.
- **`shipped-providers.test.ts`** (4) — the plugins the image ships:
  registered once; every provider-app field is expressible in the mounted
  configuration; redirect-flow providers are offered only once their app
  is configured, forms need nothing; a valid https redirect with state,
  PKCE, resource indicator and extra parameters for each.
- **`provider-apps/service.test.ts`** (11) — fields per credential kind;
  one entry per plugin; a secret sealed under
  `instance_config:provider_apps.<id>.<field>` and never returned; blank
  keeps the stored secret; every problem at once; the client secret goes
  to the host only (an `app-install` plugin keeps its private key);
  missing fields named; **the mounted configuration wins** and makes the
  provider read-only; an incomplete file block is not completed from the
  store; clear.

Integration:

- **`tests/integration/store/connections-shares.test.ts`** (+2, P1.4) —
  `syncDiscoveredResources` at the repository (merge rule, stale, plugin
  label that stops being set, name handed back to discovery) and the
  conditional transitions `refreshCredential` / `markExpired` /
  `reconnect` / `revoke` (a revoked connection is never brought back).
- **`tests/integration/connections/connect-flow.test.ts`** (3) —
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
     session.

Not covered here: the pages themselves (server components; walked by hand,
see [`e2e-tests.md`](./e2e-tests.md)), a real provider, and
`connection-unavailable` refusals of missions on a revoked connection
(P1.6).

## Out of scope for these tests

- **E2E** (Playwright, container smoke) → [`e2e-tests.md`](./e2e-tests.md).
- **UI rendering** (React components) — not wired; the `jsdom` environment
  is configured for `apps/gateway/tests/unit/components/**` but no test
  exists.
- **Gate opened for the period** (spec §3.5 `gate-opened` event): the pure
  `decide()` accepts `opened_gates`, but no code records or reads the event
  yet (P2.1), so only the unit test exercises it.
- **Accounting rules** (period arithmetic, quota/rate comparison, gates) —
  feature P1.3 tests them against the store's `decideAndDecrement`.
- **A real identity provider** (Google, Entra ID, Keycloak) — never in the
  automated suite; the manual check is in [`e2e-tests.md`](./e2e-tests.md).

## Known gaps

- **Door, resource and upstream stages** of the v5 pipeline are interfaces
  with test stubs (P1.6, authority feature, P1.2); the v4 `McpGateway` auth
  path (Bearer parse, cache, argon2id verify, single-use consume) is not
  re-tested beyond `legacy-v4-gateway.test.ts` (4) and is deleted at P1.6.
  Its v5 counterpart is `authenticate.test.ts`.
- **`tokens-rotate`** is skipped (legacy v4, see above).
- **Four plugin suites fail on `v5` at the P1.1 rebase (2026-10-13):**
  `plugins/cloudflare-dns/tests/unit/plugin.test.ts` (1),
  `plugins/cloudflare-dns/tests/unit/risk-catalog.test.ts` (2) and
  `plugins/gmail/tests/unit/plugin.test.ts` (1) — the fallback risk is still
  reported next to the categorised one, i.e. these plugins predate the
  P1.2-SDK "fallback only when uncategorized" rule. Owned by the plugin
  migrations, not by the authentication feature.
- **`bash__*` end to end** — the v4 bash adapter is only reached through
  the REST shortcut; the v5 path is `ssh__exec` over a fake `SshTransport`
  in `plugins/ssh` (P1.2i). No test opens a socket, by design.

## References

- Spec: [`../spec/vaubaan-gateway.md`](../spec/vaubaan-gateway.md) (v5),
  [`../spec/gateway-risk-model.md`](../spec/gateway-risk-model.md) (risk
  model).
- Handbooks: [[policy-engine]], [[plugin-sdk]], [[gateway-core]], [[store]],
  [[budget-and-sessions]], [[configuration]]; legacy [[mcp-gateway]], [[github-provider]],
  [[configuration]], [[authentication]]; legacy [[mcp-gateway]], [[github-provider]],
  [[vercel-provider]], [[railway-provider]], [[bash-provider]],
  [[escalation]], [[web-app]].
- CI workflow: [`../workflow/coding-workflow.md`](../workflow/coding-workflow.md)
  — `npm run ci` runs type-check + lint + format:check + build + test (this
  suite).
- E2E (Playwright, container smoke): [`./e2e-tests.md`](./e2e-tests.md).
