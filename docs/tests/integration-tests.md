---
title: Integration tests
status: current
date: 2026-06-16
tracks:
  - vitest.config.ts
  - packages/policy-engine/tests/
  - packages/providers/github/tests/
  - packages/providers/vercel/tests/
  - packages/providers/supabase/tests/
  - packages/providers/railway/tests/
  - packages/providers/ssh/tests/
  - packages/mcp-gateway/tests/
  - packages/web/tests/
  - packages/web/src/lib/bash/
  - packages/shared/src/
---

# Integration tests

Vitest, headless. No browser, no Supabase server, no real GitHub /
Vercel / Supabase / Railway / SSH. La discovery est centralisée dans
`vitest.config.ts:22-28` :

```
packages/*/tests/unit/**/*.test.ts
packages/*/tests/integration/**/*.test.ts
packages/providers/*/tests/unit/**/*.test.ts
packages/*/src/**/*.test.ts
```

Env défaut : `SKIP_LIVE=1` injecté par le runner (`vitest.config.ts:21`) ;
les tests qui peuvent toucher de vrais clouds le respectent et `skip()`
en absence des creds env vars.

## Coverage

| Suite                                                              |               Tests |
| ------------------------------------------------------------------ | ------------------: |
| `packages/policy-engine/tests/unit/slice-dsl.test.ts`              |                  23 |
| `packages/policy-engine/tests/unit/slice-matcher.test.ts`          |                  26 |
| `packages/policy-engine/tests/unit/risk-evaluator.test.ts`         |                  11 |
| `packages/policy-engine/tests/unit/risk-policy.test.ts`            |                   7 |
| `packages/policy-engine/tests/unit/risk-runtime.test.ts`           |                  12 |
| `packages/policy-engine/tests/unit/scope-injection.test.ts`        |                  12 |
| `packages/policy-engine/tests/unit/qualify.test.ts`                |                  15 |
| `packages/providers/github/tests/unit/adapter.test.ts`             |                  18 |
| `packages/providers/github/tests/unit/data-model.test.ts`          |                   1 |
| `packages/providers/github/tests/unit/risk-catalog.test.ts`        |                  35 |
| `packages/providers/github/tests/unit/risk-classifier.test.ts`     |                  31 |
| `packages/providers/github/tests/unit/risk-catalog-sync.test.ts`   |                  18 |
| `packages/providers/vercel/tests/unit/adapter.test.ts`             |                  23 |
| `packages/providers/vercel/tests/unit/data-model.test.ts`          |                   1 |
| `packages/providers/vercel/tests/unit/risk-catalog.test.ts`        |                  57 |
| `packages/providers/vercel/tests/unit/risk-classifier.test.ts`     |                  32 |
| `packages/providers/vercel/tests/unit/risk-catalog-sync.test.ts`   |                  19 |
| `packages/providers/supabase/tests/unit/adapter.test.ts`           |                  30 |
| `packages/providers/supabase/tests/unit/data-model.test.ts`        |                   1 |
| `packages/providers/supabase/tests/unit/risk-catalog.test.ts`      |                  32 |
| `packages/providers/supabase/tests/unit/risk-classifier.test.ts`   |                  30 |
| `packages/providers/supabase/tests/unit/risk-catalog-sync.test.ts` |                  28 |
| `packages/providers/railway/tests/unit/adapter.test.ts`            |                  15 |
| `packages/providers/railway/tests/unit/data-model.test.ts`         |                   1 |
| `packages/providers/railway/tests/unit/risk-catalog.test.ts`       |                  15 |
| `packages/providers/railway/tests/unit/risk-classifier.test.ts`    |                  20 |
| `packages/providers/ssh/tests/unit/data-model.test.ts`             |                   1 |
| `packages/providers/ssh/tests/unit/risk-catalog.test.ts`           |                  10 |
| `packages/providers/ssh/tests/unit/risk-classifier.test.ts`        |                  39 |
| `packages/mcp-gateway/tests/unit/gateway.test.ts`                  |                   4 |
| `packages/mcp-gateway/tests/unit/risk-gateway.test.ts`             |                   6 |
| `packages/web/tests/unit/api/members-post.test.ts`                 |       5 (1 skipped) |
| `packages/web/tests/unit/api/tokens-preview.test.ts`               |                  12 |
| `packages/web/tests/unit/api/tokens-rotate.test.ts`                |         2 (skipped) |
| `packages/web/tests/unit/lib/mint/preview.test.ts`                 |                   4 |
| `packages/web/tests/unit/lib/risk-catalog/loader.test.ts`          |                  12 |
| `packages/web/tests/unit/providers/data-model-to-mermaid.test.ts`  |                   8 |
| `packages/web/tests/unit/providers/plane-filters.test.ts`          |                   5 |
| `packages/web/src/lib/bash/parse.test.ts`                          |                  11 |
| `packages/web/src/lib/bash/exec.test.ts`                           |                   4 |
| `packages/web/src/lib/bash/args.test.ts`                           |                   9 |
| `packages/web/src/lib/bash/exec-host.test.ts`                      |                   7 |
| `packages/shared/src/api-key.test.ts`                              |                   6 |
| **TOTAL**                                                          | **655 (3 skipped)** |

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
  warn). Post drop-confirm, plus de `seedDefaultGate`.
- **`risk-runtime.test.ts`** — `evaluateCall` allow (feature-branch +
  fallback, read code), deny (missing risk, explicit deny, empty slices,
  no catalog match), multi-slice (all risks covered, missing one fails),
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

## Scénarios — MCP gateway (v4)

> Couvre : handbook [[mcp-gateway]]. Spec : `gateway-risk-model.md` §8.

- **`unit/risk-gateway.test.ts`** (6) — `evaluateCallForToken` pure :
  allow happy path, deny avec missing risks, classify-denied (plugin
  rejet structurel), no-catalog (fail-closed), multi-slice union,
  denied_risks shadow l'acceptance.
- **`unit/gateway.test.ts`** (4) — orchestration `McpGateway.callTool` :
  audit shape sur erreur upstream (adapter standard + self-contained →
  audit `denied` avec reason `upstream-error`), missing binding
  (classifier OK mais binding absent → denied avec reason
  `binding-missing`), happy path (audit `allowed`).

> **À étendre.** Auth + cache + single-use consume sont couverts
> indirectement par l'E2E `scripts/e2e-mint-flow.mjs`. Plan : étoffer
> `gateway.test.ts` pour couvrir auth (parse `Bearer`, hit/miss cache,
> argon2id verify, expiry, single-use consume + race), audit
> `slices_executed/risks_touched/token_accepted_risks_snapshot` shape.

## Scénarios — Web routes & libs

> Couvre : handbook [[web-app]].

`packages/web/tests/unit/`. Les routes Next.js sont importées directement
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

`packages/web/src/lib/bash/` (les `.test.ts` vivent à côté du
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
  pour `packages/web/tests/unit/components/**`).

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
  [[escalation]], [[web-app]].
- Workflow CI : [`../workflow/coding-workflow.md`](../workflow/coding-workflow.md)
  — `npm run ci` lance type-check + lint + format:check + test (cette suite) + build.
- E2E (Playwright) : [`./e2e-tests.md`](./e2e-tests.md).
