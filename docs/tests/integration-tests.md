---
title: Integration tests
status: current
date: 2026-10-13
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
  - packages/gateway-core/tests/
  - apps/gateway/tests/
  - apps/gateway/src/lib/bash/
  - apps/gateway/src/server/
  - apps/gateway/migrations/
  - packages/shared/src/
---

# Integration tests

Vitest, headless. No browser, no Supabase server, no real GitHub /
Vercel / Supabase / Railway / SSH. La discovery est centralisée dans
`vitest.config.ts:22-28` :

```
packages/*/tests/unit/**/*.test.ts
packages/*/tests/integration/**/*.test.ts
plugins/*/tests/unit/**/*.test.ts
packages/*/src/**/*.test.ts
```

Env défaut : `SKIP_LIVE=1` injecté par le runner (`vitest.config.ts:21`) ;
les tests qui peuvent toucher de vrais clouds le respectent et `skip()`
en absence des creds env vars.

## Coverage

| Suite                                                             |                Tests |
| ----------------------------------------------------------------- | -------------------: |
| `packages/policy-engine/tests/unit/slice-dsl.test.ts`             |                   23 |
| `packages/policy-engine/tests/unit/slice-matcher.test.ts`         |                   26 |
| `packages/policy-engine/tests/unit/risk-evaluator.test.ts`        |                   11 |
| `packages/policy-engine/tests/unit/risk-policy.test.ts`           |                    8 |
| `packages/policy-engine/tests/unit/risk-runtime.test.ts`          |                   16 |
| `packages/policy-engine/tests/unit/scope-injection.test.ts`       |                   13 |
| `packages/policy-engine/tests/unit/qualify.test.ts`               |                   21 |
| `packages/plugin-sdk/tests/unit/catalog-loader.test.ts`           |                   19 |
| `packages/plugin-sdk/tests/unit/registry.test.ts`                 |                   10 |
| `packages/plugin-sdk/tests/unit/define-plugin.test.ts`            |                   11 |
| `packages/plugin-sdk/tests/unit/testing-kit.test.ts`              |                   13 |
| `plugins/_template/tests/unit/plugin.test.ts`                     |                   11 |
| `plugins/github/tests/unit/adapter.test.ts`                       |                   18 |
| `plugins/github/tests/unit/data-model.test.ts`                    |                    1 |
| `plugins/github/tests/unit/risk-catalog.test.ts`                  |                   35 |
| `plugins/github/tests/unit/risk-classifier.test.ts`               |                   31 |
| `plugins/github/tests/unit/risk-catalog-sync.test.ts`             |                   18 |
| `plugins/vercel/tests/unit/adapter.test.ts`                       |                   23 |
| `plugins/vercel/tests/unit/data-model.test.ts`                    |                    1 |
| `plugins/vercel/tests/unit/risk-catalog.test.ts`                  |                   57 |
| `plugins/vercel/tests/unit/risk-classifier.test.ts`               |                   32 |
| `plugins/vercel/tests/unit/risk-catalog-sync.test.ts`             |                   19 |
| `plugins/supabase/tests/unit/adapter.test.ts`                     |                   30 |
| `plugins/supabase/tests/unit/data-model.test.ts`                  |                    1 |
| `plugins/supabase/tests/unit/risk-catalog.test.ts`                |                   32 |
| `plugins/supabase/tests/unit/risk-classifier.test.ts`             |                   30 |
| `plugins/supabase/tests/unit/risk-catalog-sync.test.ts`           |                   28 |
| `plugins/railway/tests/unit/adapter.test.ts`                      |                   15 |
| `plugins/railway/tests/unit/data-model.test.ts`                   |                    1 |
| `plugins/railway/tests/unit/risk-catalog.test.ts`                 |                   15 |
| `plugins/railway/tests/unit/risk-classifier.test.ts`              |                   20 |
| `plugins/ssh/tests/unit/data-model.test.ts`                       |                    1 |
| `plugins/ssh/tests/unit/risk-catalog.test.ts`                     |                   10 |
| `plugins/ssh/tests/unit/risk-classifier.test.ts`                  |                   39 |
| `packages/gateway-core/tests/unit/errors.test.ts`                 |                   24 |
| `packages/gateway-core/tests/unit/audit.test.ts`                  |                    6 |
| `packages/gateway-core/tests/unit/cache.test.ts`                  |                    6 |
| `packages/gateway-core/tests/unit/authenticate.test.ts`           |                   11 |
| `packages/gateway-core/tests/unit/pipeline.test.ts`               |                   15 |
| `apps/gateway/tests/unit/lib/gateway/legacy-v4-gateway.test.ts`   |                    4 |
| `packages/gateway-core/tests/unit/risk-gateway.test.ts`           |                    6 |
| `apps/gateway/tests/unit/api/members-post.test.ts`                |        5 (1 skipped) |
| `apps/gateway/tests/unit/api/tokens-preview.test.ts`              |                   12 |
| `apps/gateway/tests/unit/api/tokens-rotate.test.ts`               |          2 (skipped) |
| `apps/gateway/tests/unit/lib/mint/preview.test.ts`                |                    4 |
| `apps/gateway/tests/unit/lib/risk-catalog/loader.test.ts`         |                   12 |
| `apps/gateway/tests/unit/providers/data-model-to-mermaid.test.ts` |                    8 |
| `apps/gateway/tests/unit/providers/plane-filters.test.ts`         |                    5 |
| `apps/gateway/src/lib/bash/parse.test.ts`                         |                   11 |
| `apps/gateway/src/lib/bash/exec.test.ts`                          |                    4 |
| `apps/gateway/src/lib/bash/args.test.ts`                          |                    9 |
| `apps/gateway/src/lib/bash/exec-host.test.ts`                     |                    7 |
| `apps/gateway/src/server/**/*.test.ts` (v5, P0.4)                 |                   61 |
| `apps/gateway/tests/unit/structural/no-hardcoded-config.test.ts`  |                   32 |
| `packages/shared/src/api-key.test.ts`                             |                    6 |
| `packages/shared/src/risk-id.test.ts`                             |                   20 |
| `packages/shared/src/mcp.test.ts`                                 |                   10 |
| `apps/gateway/tests/unit/server/store/ids.test.ts`                |                    6 |
| `apps/gateway/tests/unit/server/store/migrate.test.ts`            |                    8 |
| `apps/gateway/tests/integration/store/schema.test.ts`             |                    6 |
| `apps/gateway/tests/integration/store/audit.test.ts`              |                   12 |
| `apps/gateway/tests/integration/store/identities.test.ts`         |                    7 |
| `apps/gateway/tests/integration/store/connections-shares.test.ts` |                   11 |
| `apps/gateway/tests/integration/store/missions.test.ts`           |                    8 |
| `apps/gateway/tests/integration/store/sessions.test.ts`           |                    9 |
| `apps/gateway/tests/integration/store/requests-approvals.test.ts` |                    8 |
| `apps/gateway/tests/integration/store/delegations.test.ts`        |                    7 |
| `apps/gateway/tests/integration/store/config.test.ts`             |                    4 |
| **TOTAL** (`npm run test`, 2026-10-13, incl. suites not listed)   | **1658 (3 skipped)** |

## Run

```bash
npm run test                              # full suite, headless
npm run test:watch                        # file-watcher mode for local dev
npx vitest run packages/policy-engine     # one package
```

## Scénarios — Policy engine (v4 risk-based)

> Couvre : `docs/spec/gateway-risk-model.md` §3 (DSL), §4 (catalog),
> §8 (runtime). Handbook : [[policy-engine]].

- **`slice-dsl.test.ts`** — `parseSlice` happy path + branches d'erreur
  (missing provider/action, invalid action, unterminated bracket, empty
  bracket, double dot, list with empty entry) ; `serializeSlice` roundtrip
  (simple, glob, list, wild-rec, exemples canoniques de la spec).
- **`slice-matcher.test.ts`** — `matches` simple/wild/list/glob, `covers`
  (`**` vs `*` partial order), `intersects` symétrique avec glob × glob,
  asymétriques sur `wild-rec`.
- **`risk-evaluator.test.ts`** — `risksTouchedBy` (code read, feature
  branch, merge-protected + fallback, branch-protection, provider
  mismatch → vide), `risksTouchedByAll` (union dédupliquée, ordre stable),
  `indexCatalog` (rejette pattern wrong provider + unparseable),
  `findRiskEntry`.
- **`risk-policy.test.ts`** — `checkAcceptableInEnv` (no-env,
  env-not-in-list, ok) + `prepareCatalog` (dup-id, regex fail, fallback
  warning through the injectable `warn`, `hasFallbackRisk`).
- **`risk-runtime.test.ts`** — `evaluateCall` allow (feature-branch +
  fallback, read code), deny (missing risk, explicit deny, empty slices,
  no catalog match), multi-slice (all risks covered, missing one fails),
  env qualification through `resourceEnvResolver` (staging vs prod
  resource, `acceptable_in_envs` runtime filter), no resolver → unqualified,
  deprecated `bindings` input through the legacy bridge,
  `evaluateCallSimple` happy.
- **`scope-injection.test.ts`** — `injectionPlanFor` (github owner/repo,
  vercel projectId+teamId, supabase project_ref ; null si 0/2+ bindings,
  null si resource_ref malformé), `stripInjectedArgs` (retire properties
  - required, no-op si rien, no-mutate), `mergeInjectedArgs` (fill
    missing, caller-override wins, empty string = missing).
- **`qualify.test.ts`** (15) — `isEnvScopedEntry` (true si
  `acceptable_in_envs` non vide), `qualifyRiskId` (inject `[env]` avant
  le premier `.`, idempotent, no-op si account-scoped, env-scoped
  cases via `test.each`), `unqualifyRiskId` (strip + idempotent),
  round-trip property.

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
  slug, YAML syntax error naming the source.
- **`registry.test.ts`** — ids in registration order, `has/get/require`,
  `providerForTool` (exact name, prefix rule for unlisted tools, null),
  `toolDeclarations`, `labels`, `idEnum` (non-empty tuple, throws when
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
- **`testing-kit.test.ts`** — `assertCatalogCoverage` passes on the
  fixture and reports touched/untouched risks; fails on a tool without
  sample, a sample for an undeclared tool, an unexpected or missing
  classifier denial, a slice no risk matches; `PluginAssertionError`
  carries every finding. `assertNoWildcard` on id lists (`*`, `all`),
  catalogs and plugins; `assertPresetsValid`; `assertPluginWellFormed`.
  `mockFetch`: routing by method and URL, recorded calls and JSON bodies,
  unmatched request rejects, status codes driving `UpstreamAuthError`,
  `times` and `pending()`, `Request` objects and `Headers`.
- **`plugins/_template/tests/unit/plugin.test.ts`** — the four kit
  assertions on the template, classifier cases (named workspace, single
  resource default, ambiguous or malformed workspace, malformed id,
  unknown tool, slice round-trip), `execute` and `discoverResources`
  against `mockFetch` (bearer header, PATCH body, 401 →
  `UpstreamAuthError`).

## Scenarios — Shared (v5 additions)

- **`risk-id.test.ts`** — `parseRiskId` both forms, hyphenated provider
  and dotted name, eleven malformed inputs rejected; `formatRiskId`
  round-trip and null/empty env; `baseRiskId`; `isProviderId`;
  `isExplicitRiskId` (wildcards rejected).
- **`mcp.test.ts`** — `toolPrefixFor` / `splitToolName` (hyphen ↔
  underscore, first separator only, malformed names); the eight refusal
  codes of spec §4.1 and §6; `isRefusalCode`.

## Scénarios — Provider adapters + risk catalogs

Chaque provider compte 4-5 suites (adapter + data-model + risk-catalog +
risk-classifier + risk-catalog-sync).

> Couvre : `docs/handbook/providers/{github,vercel,supabase,railway-ssh}.md` +
> [[github-provider]], [[vercel-provider]], [[railway-provider]],
> [[bash-provider]]. ADRs touchés : [[rewrap-official-mcps]],
> [[vercel-augment-with-rest-tools]], [[mint-install-token-credential]],
> [[railway-rewrap-remote-mcp]].

**GitHub** (103) — `adapter` (18) : auth + JIT JWT exchange + executeCall

- `mint_install_token` (purpose mapping + repoFullName validation).
  `data-model` (1) : la structure mermaid se rend correctement.
  `risk-catalog` (35) : schema YAML (provider, fields, vector 6D, fallback,
  ids uniques, slices parseables) + lint coverage par tool (au moins une
  entrée fine + une entrée hors fallback pour chaque write).
  `risk-classifier` (31) : classifyV4 par tool kind (read code, write
  feature branch, merge protected, branch protection, etc.).
  `risk-catalog-sync` (18) : YAML ↔ TS export sync (provider, count,
  ordre, contenu entrée par entrée).

**Vercel** (132) — `adapter` (23) : mint long-lived + executeCall avec
teamId injection + custom REST tools (update_project_settings,
upsert_env_var GET no-body, delete_env_var DELETE no-body).
`data-model` (1). `risk-catalog` (57) : schema + lint coverage (15
risks × assertions sur vector + acceptable_in_envs).
`risk-classifier` (32) : classifyV4 (env-vars cross-env, plaintext.R
sur decrypt=true, bypass-token credential mint).
`risk-catalog-sync` (19).

**Supabase** (121) — `adapter` (30) : 4 planes (db, storage, auth, functions)

- wrapper read-only sur `execute_sql` (Postgres `BEGIN READ ONLY`).
  `data-model` (1). `risk-catalog` (32). `risk-classifier` (30).
  `risk-catalog-sync` (28).

**Railway** (51) — `adapter` (15) : mint + refresh near-expiry +
persistRefresh callback + validateBinding (UUID check + whoami liveness).
`data-model` (1). `risk-catalog` (15). `risk-classifier` (20) :
`upsert-variables replace=true` émet la slice destructive,
`railway-agent` émet 2 slices parallèles (account + wildcard catch-all).

**SSH** (50) — `data-model` (1). `risk-catalog` (10). `risk-classifier`
(39) : forme de slice `ssh.host[X].command.R|W` + mapping rings → risk
catalog. L'adapter SSH brut (`sshExec`, `humanizeConnError`) reste
testé indirectement via les tests bash.

**Resend** (149) — `adapter` (12) : mintUpstreamToken (decode + error),
validateBinding (GET /domains, fallback displayName, 401 error),
executeCall (wire-through + describe_zones metadata pass),
classifyV4 delegation, availableTools (25 count, resend\_\_ prefix).
`data-model` (9) : entity graph integrity — plane count, envScopable
on account, domain hierarchy, audience/contact/broadcast hierarchy,
synthetic markers (to-zone, recipient-count), unbounded entities,
entity count (10).
`risk-catalog` (63) : YAML structural validation (16 risks, required
fields, RiskId regex, uniqueness, 6D vector validity, fallback exists,
caps/infra_limits on broadcast-send and send-batch, irreversible risks,
acceptable_in_envs), pattern parsing, prepareCatalog roundtrip,
coverage lint (every tool covered by non-fallback risk), risksTouchedBy
sanity checks.
`risk-catalog-sync` (19) : YAML ↔ TS export sync (provider, risk count,
ids order, per-entry label/reason/matches/vector/acceptable_in_envs/
caps/infra_limits).
`risk-classifier` (46) : reads (email, domains, audiences, contacts,
broadcasts), writes (to-zone classification for internal/allowlist/
external, worst-case mixed recipients, multi-recipient count, cc/bcc
inclusion, batch sends with 3 slices, domains CRUD, audiences, contacts,
broadcasts lifecycle), attachment denial (v1), describe_zones synthetic
tool, binding propagation (prod/staging/empty resource_ref), denials
(unknown tool, no binding, wrong provider), spec §7.2 multi-slice
examples.

## Scenarios — gateway-core (v5)

> Covers: handbook [[gateway-core]]. Spec: `vaubaan-gateway.md` §4.1, §6,
> §8, §10 ("structured refusals", "credential separation");
> `gateway-risk-model.md` §8. English section, written by feature P0.5;
> the rest of this file is rewritten at P1.9.

`packages/gateway-core/tests/unit/`, vitest, no network, no store.

- **`risk-gateway.test.ts`** (6) — the pure decision core
  `evaluateCallForToken`: allow, deny with missing risks, classify-denied,
  no-catalog (fail closed), multi-slice union, denied_risks shadow.
  Unchanged since v4.
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
  future `expires_at`), `checkConnectionAvailable`; `CallPipeline`: happy
  path with the full audit entry, inactive mission refused before anything
  else, `resource-not-in-mission` before any risk evaluation, expired
  connection, `risk-not-accepted` through the real decision core with the
  budget untouched, structural rejections without a code, budget refusal
  with no upstream call, approval id carried to the audit, upstream
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

## Scénarios — Web routes & libs

> Couvre : handbook [[web-app]].

`apps/gateway/tests/unit/`. Les routes Next.js sont importées directement
(pas de fetch), les supabase clients mockés.

- **`api/members-post.test.ts`** (5) — `POST /api/v1/members` : unauth
  rejected ; validation 400 (missing orgSlug, invalid email, missing
  body fields) ; 409 si user déjà membre.
- **`api/tokens-preview.test.ts`** (12) — `POST /api/v1/tokens/preview` :
  `resolveRiskRow` (unknown risk → blocked, catalog undefined → blocked,
  env-scoped qualification, parent inherited path, account-scoped
  passthrough, env hors `acceptable_in_envs`, parent missing risk,
  null parent → optimistic inherited) ; `computePreview` (ok=false si
  une row n'est pas acceptable, ok=true si toutes le sont, rejet de
  risk hors bindings, expansion par binding, une row par
  (risk, binding)). Source de vérité du wire mint post drop-confirm.
- **`api/tokens-rotate.test.ts`** (2 — _skipped_) — auth Bearer
  setup à débloquer.
- **`lib/mint/preview.test.ts`** (4) — `computeMintPreview` :
  inherited + acceptable → ok=true, parent missing → not_inherited,
  binding env hors `acceptable_in_envs` → not_acceptable, null parent
  → optimistic inherited.
- **`lib/risk-catalog/loader.test.ts`** (12) — `__setCatalogForTests`
  seam (clear, set, override, undefined) + `qualifyRiskId` /
  `unqualifyRiskId` (round-trip, account-scoped passthrough,
  already-qualified defensive).
- **`providers/data-model-to-mermaid.test.ts`** (8) — rendu mermaid
  `erDiagram` du data-model : header, kebab-case ids, env suffix,
  cardinalités bounded/unbounded, plane filter via `planeSlug`,
  root ORG binding, classDef unique.
- **`providers/plane-filters.test.ts`** (5) — `risksForPlane`
  (entités plane-uniques, wildcards inclus partout, plane inconnu →
  vide) + `toolsForPlane` (single-plane provider → tous les tools,
  multi-plane → filtre par `toolPlanes`).

## Scénarios — Bash provider (lib)

> Couvre : handbook [[bash-provider]].

`apps/gateway/src/lib/bash/` (les `.test.ts` vivent à côté du
code) :

- **`parse.test.ts`** (11) — `parseAnnotatedBash` : happy path
  multi-rings ; chaque branche de rejet (`rings` manquant, ring inconnu,
  action invalide, `@vaubaan-arg` sans nom, pas de tool annoté) ;
  private helpers ignorés ; `@vaubaan-arg` typing.
- **`exec.test.ts`** (4) — `buildToolInvocation` : base64 + `bash -s --` ;
  échappement POSIX single-quote ; args vides ; content multi-ligne ;
  intégration `parse → build`.
- **`args.test.ts`** (9) — `materializeArgs` : required + no default
  → error ; required + default → default (rescue) ; optional + default ;
  optional + no default → '' ; present raw stringify ; integer typing ;
  empty string treated as missing ; order positional.
- **`exec-host.test.ts`** (7) — `loadHostByIdInOrg` /
  `loadHostBySlugInOrg` + `execOnHost` : check org-scope ; bytea→PEM
  decode ; `sshExec` happy path ; propagation des erreurs SSH ; pas de
  host trouvé.

## Scénarios — Shared lib

> Couvre : `packages/shared/src/` — bibliothèque utilitaire partagée.
> Tests unitaires purs.

- **`api-key.test.ts`** (6) — `generateApiKey` / `parseApiKey` /
  `hashApiKey` / `verifyApiKey` ; preserve le prefix.

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
- **`compose/compose.test.ts`** (12) — `buildRoot` from configuration
  alone; injected store/registry and warning for an unknown provider id;
  no secret in the boot log; `getRoot` builds once and shares the promise,
  forgets a failed build; `bootOrExit` exits 78 naming the key, 1 on other
  failures, nothing on success; `MemoryRateLimiter` window and reset,
  `MemoryCache` TTL and eviction, `MemorySessionStore`, `EmptyPluginRegistry`.
- **`http/healthz.test.ts`** (3) — 200 with build stamps and store kind and
  no configuration value, 503 degraded on store ping failure, 503
  unavailable when the root cannot be built.
- **`apps/gateway/tests/unit/structural/no-hardcoded-config.test.ts`**
  (one test per scanned file, 32 at P0.4) — no literal URL, Supabase ref, GitHub /
  Stripe / mission token, private key or JWT in `apps/gateway/src/server`,
  `instrumentation.ts`, `app/healthz`, `next.config.ts`, `deploy/`,
  `scripts/`, `.github/workflows`; only `telemetry-default.ts` and
  `deploy/config/*.example*` are exempt. Scope widens as v4 code is deleted.
- **`apps/gateway/tests/integration/standalone-native-addons.test.ts`** (3,
  P0.6) — reads the build output and is skipped when `.next/standalone` is
  absent (CI builds before testing): the `/healthz` route handler trace lists
  the `argon2` and `better-sqlite3` `.node` binaries; a Node process started
  inside the standalone tree resolves both packages from the standalone
  `node_modules` (not the repository's), hashes with argon2 and runs a query
  on an in-memory SQLite database.

Container smoke (`deploy/docker/smoke.sh`, CI job `docker`): see
[`e2e-tests.md`](./e2e-tests.md).

## Scénarios — Crypto (app-level encryption) — legacy v4

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
> arithmetic, quota/rate comparison, gate handling) are feature P1.3 and
> will test their own `decide` callback against this primitive. The real
> `Encryptor` (XChaCha20-Poly1305, per-blob KDF, `apps/gateway/src/server/crypto/`)
> has its own suite; the store's stub only reproduces the port's
> associated-data and key-version contract.

## Hors-scope ces tests

- **E2E avec vrais clouds** (Playwright) → cf.
  [`e2e-tests.md`](./e2e-tests.md).
- **E2E mint flow** (Node + vraie DB supabase + mock MCP) →
  `scripts/e2e-mint-flow.mjs`. Drivable depuis CI mais pas dans la suite
  Vitest.
- **RLS sur Supabase** — testée à `apply-prod` time côté
  `0001_init.sql` ; à porter en Supabase test container quand un
  cas d'usage l'exige.
- **UI rendering** (composants React) — pas wiré (config
  `environmentMatchGlobs: jsdom` prête côté `vitest.config.ts:30`
  pour `apps/gateway/tests/unit/components/**`).

## Trous connus

- **MCP gateway auth + cache + single-use** — `gateway.test.ts` couvre
  les audit shapes (B1 upstream-error, B2 binding-missing, happy).
  Reste à couvrir : auth (parse Bearer, hit/miss cache, argon2id verify,
  expiry, single-use atomic consume + race), validation des champs
  audit (`slices_executed`, `risks_touched`,
  `token_accepted_risks_snapshot`).
- **`tokens-rotate`** est _skipped_ — setup auth Bearer à débloquer.
- **`bash` adapter MCP wiring** — pas encore implémenté
  (`build.ts:251-254`). Les invocations passent par le REST shortcut ;
  pas de test gateway de bout-en-bout pour `bash__*`.

## Références

- Spec : [`../spec/gateway-risk-model.md`](../spec/gateway-risk-model.md)
  (v4 risk-based, source de vérité du modèle d'autorisation).
- Handbooks liés : [[policy-engine]], [[mcp-gateway]], [[github-provider]],
  [[vercel-provider]], [[railway-provider]], [[bash-provider]],
  [[escalation]], [[web-app]], [[store]].
- Workflow CI : [`../workflow/coding-workflow.md`](../workflow/coding-workflow.md)
  — `npm run ci` lance type-check + lint + format:check + test (cette suite) + build.
- E2E (Playwright) : [`./e2e-tests.md`](./e2e-tests.md).
