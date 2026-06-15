---
title: Integration tests
status: current
date: 2026-06-15
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

Vitest, ~3s total. No browser, no Supabase server, no real GitHub /
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
en absence de la creds env vars.

## Coverage (645 passing + 5 skipped, ~3s)

| Suite                                                              |               Tests | Latency |
| ------------------------------------------------------------------ | ------------------: | ------: |
| `packages/policy-engine/tests/unit/slice-dsl.test.ts`              |                  23 |    ~8ms |
| `packages/policy-engine/tests/unit/slice-matcher.test.ts`          |                  26 |   ~12ms |
| `packages/policy-engine/tests/unit/risk-evaluator.test.ts`         |                  10 |    ~6ms |
| `packages/policy-engine/tests/unit/risk-policy.test.ts`            |                  25 |   ~11ms |
| `packages/policy-engine/tests/unit/risk-runtime.test.ts`           |                   9 |    ~7ms |
| `packages/policy-engine/tests/unit/scope-injection.test.ts`        |                  12 |    ~6ms |
| `packages/providers/github/tests/unit/adapter.test.ts`             |                  18 |   ~66ms |
| `packages/providers/github/tests/unit/risk-catalog.test.ts`        |                  35 |   ~21ms |
| `packages/providers/github/tests/unit/risk-classifier.test.ts`     |                  31 |   ~10ms |
| `packages/providers/github/tests/unit/risk-catalog-sync.test.ts`   |                  18 |   ~12ms |
| `packages/providers/vercel/tests/unit/adapter.test.ts`             |                  23 |   ~17ms |
| `packages/providers/vercel/tests/unit/risk-catalog.test.ts`        |                  58 |   ~24ms |
| `packages/providers/vercel/tests/unit/risk-classifier.test.ts`     |                  32 |   ~15ms |
| `packages/providers/vercel/tests/unit/risk-catalog-sync.test.ts`   |                  19 |   ~12ms |
| `packages/providers/supabase/tests/unit/adapter.test.ts`           |                  30 |   ~19ms |
| `packages/providers/supabase/tests/unit/risk-catalog.test.ts`      |                  32 |   ~29ms |
| `packages/providers/supabase/tests/unit/risk-classifier.test.ts`   |                  30 |    ~9ms |
| `packages/providers/supabase/tests/unit/risk-catalog-sync.test.ts` |                  28 |   ~15ms |
| `packages/providers/railway/tests/unit/adapter.test.ts`            |                  15 |   ~33ms |
| `packages/providers/railway/tests/unit/risk-catalog.test.ts`       |                  16 |   ~11ms |
| `packages/providers/railway/tests/unit/risk-classifier.test.ts`    |                  20 |   ~12ms |
| `packages/providers/ssh/tests/unit/risk-catalog.test.ts`           |                  13 |    ~8ms |
| `packages/providers/ssh/tests/unit/risk-classifier.test.ts`        |                  39 |   ~11ms |
| `packages/mcp-gateway/tests/unit/risk-gateway.test.ts`             |                   6 |   ~10ms |
| `packages/web/tests/unit/api/members-post.test.ts`                 |       5 (1 skipped) |  ~600ms |
| `packages/web/tests/unit/api/mgmt-tokens-preview.test.ts`          |                  12 |    ~7ms |
| `packages/web/tests/unit/api/mgmt-tokens-delete.test.ts`           |         2 (skipped) |       — |
| `packages/web/tests/unit/api/tokens-rotate.test.ts`                |         2 (skipped) |       — |
| `packages/web/tests/unit/lib/approvals/mint.test.ts`               |                   3 |  ~115ms |
| `packages/web/tests/unit/lib/approvals/email-token.test.ts`        |                   6 |   ~21ms |
| `packages/web/tests/unit/lib/mint/preview.test.ts`                 |                   4 |    ~6ms |
| `packages/web/tests/unit/lib/risk-catalog/loader.test.ts`          |                  12 |   ~10ms |
| `packages/web/src/lib/bash/parse.test.ts`                          |                  11 |    ~9ms |
| `packages/web/src/lib/bash/exec.test.ts`                           |                   4 |    ~4ms |
| `packages/web/src/lib/bash/args.test.ts`                           |                   9 |    ~5ms |
| `packages/web/src/lib/bash/exec-host.test.ts`                      |                   7 |    ~5ms |
| `packages/shared/src/api-key.test.ts`                              |                   5 |  ~107ms |
| **TOTAL**                                                          | **645 (5 skipped)** |     ~3s |

## Run

```bash
npm run test                              # full suite, headless
npm run test:watch                        # file-watcher mode for local dev
npx vitest run packages/policy-engine     # one package
```

## Scénarios — Policy engine (v4 risk-based)

> Couvre : `docs/spec/gateway-risk-model.md` §3 (DSL), §4 (catalog),
> §6 (project policy), §8 (runtime). Handbook : [[policy-engine]].

- **`slice-dsl.test.ts`** (23) — `parseSlice` happy + error (missing
  provider/action, invalid action, unterminated bracket, empty bracket,
  double dot, list with empty entry, list with glob inside accepted) ;
  `serializeSlice` roundtrip (simple, glob, list, wild-rec, canonical
  spec examples).
- **`slice-matcher.test.ts`** (26) — `matches` simple/wild/list/glob,
  `covers` (`**` vs `*` partial order), `intersects` symétrique avec
  glob × glob, asymétriques sur `wild-rec`.
- **`risk-evaluator.test.ts`** (10) — `risksTouchedBy` (code read,
  feature branch, merge-protected + fallback, branch-protection, provider
  mismatch → vide), `risksTouchedByAll` (union dédupliquée, ordre stable),
  `indexCatalog` (rejette pattern wrong provider + unparseable),
  `findRiskEntry`.
- **`risk-policy.test.ts`** (25) — `resolveEffectiveGate` (env-scoped
  wins, global, catalog default, unknown → deny), `checkAcceptableInEnv`
  (no-env, env-not-in-list, ok), `requiresAdminToOverrideDenyAllow`
  (posture, secret-W, pii-W, plain), `seedDefaultGate` (chaque branche),
  `prepareCatalog` (dup-id, regex fail, fallback warn).
- **`risk-runtime.test.ts`** (9) — `evaluateCall` allow (feature-branch +
  fallback, read code), deny (missing risk, explicit deny, empty slices,
  no catalog match), multi-slice (all risks covered, missing one fails),
  `evaluateCallSimple` happy.
- **`scope-injection.test.ts`** (12) — `injectionPlanFor` (github
  owner/repo, vercel projectId+teamId, supabase project_ref ; null si
  0/2+ bindings, null si resource_ref malformé), `stripInjectedArgs`
  (retire properties + required, no-op si rien, no-mutate),
  `mergeInjectedArgs` (fill missing, caller-override wins, empty string
  = missing).

## Scénarios — Provider adapters + risk catalogs

Chaque provider compte 4 suites (adapter + risk-catalog +
risk-classifier + risk-catalog-sync). Total : 414 tests.

> Couvre : handbooks [[github-provider]], [[vercel-provider]],
> [[railway-provider]], [[bash-provider]] + les v4 handbooks dans
> `docs/handbook/providers/`. ADRs touchés : [[rewrap-official-mcps]],
> [[vercel-augment-with-rest-tools]], [[mint-install-token-credential]],
> [[railway-rewrap-remote-mcp]].

**GitHub** (102) — adapter (18) : auth + JIT JWT exchange + executeCall

- mint_install_token (purpose mapping + repoFullName validation).
  risk-catalog (35) : catalog shape, lint coverage, 6D vector consistency.
  risk-classifier (31) : classifyV4 par tool kind (read code, write feature
  branch, merge protected, branch protection, etc.). risk-catalog-sync (18) :
  YAML ↔ TS export sync + chaque tool MCP émet ≥1 slice qui matche ≥1 entrée.

**Vercel** (132) — adapter (23) : mint long-lived + executeCall avec
teamId injection + custom REST tools (update_project_settings,
upsert_env_var GET no-body, delete_env_var DELETE no-body). risk-catalog
(58) : la suite la plus dense (15 risks × 4-5 assertions sur vector +
default_gate + acceptable_in_envs). risk-classifier (32) : classifyV4
(env-vars cross-env, plaintext.R sur decrypt=true, bypass-token credential
mint). risk-catalog-sync (19).

**Supabase** (120) — adapter (30), risk-catalog (32), risk-classifier
(30), risk-catalog-sync (28). Couvre les 4 planes (`db`, `storage`,
`auth`, `functions`) + le risk `bulk-row-write`.

**Railway** (51) — adapter (15) : mint + refresh near-expiry +
persistRefresh callback + validateBinding (UUID check + whoami liveness).
risk-catalog (16). risk-classifier (20) : `upsert-variables replace=true`
émet la slice destructive, `railway-agent` émet 3 slices parallèles.

**SSH** (52) — risk-catalog (13), risk-classifier (39). Couvre la
forme de slice `ssh.host[X].command.R|W` + le mapping rings → risk
catalog. L'adapter SSH brut (`sshExec`, `humanizeConnError`) reste
testé indirectement via les tests bash.

## Scénarios — MCP gateway (v4)

> Couvre : handbook [[mcp-gateway]]. Spec : `gateway-risk-model.md` §8.

`unit/risk-gateway.test.ts` (6) — `evaluateCallForToken` pure :
allow happy path, deny avec missing risks, classify-denied (plugin
rejet structurel), no-catalog (fail-closed), multi-slice union,
denied_risks shadow l'acceptance.

> **Trou v1-drop.** L'ancienne suite `gateway.test.ts` (14 tests
> auth/cache/audit) et `integration/{lifecycle,scope-injection}.test.ts`
> (10 tests E2E supabase-mocked) ont été supprimées avec le wire v1.
> Le code de `gateway.ts` est couvert :
>
> - **À l'unitaire** par `risk-gateway.test.ts` (decision pure).
> - **À l'E2E** par `scripts/e2e-mint-flow.mjs` qui drive une vraie
>   base supabase + un mock MCP call.
>   À ré-écrire en Vitest pour la v4 — voir §Trous connus.

## Scénarios — Web routes & libs

> Couvre : handbooks [[web-app]], [[approvals]].

`packages/web/tests/unit/`. Les routes Next.js sont importées directement
(pas de fetch), les supabase clients mockés.

- **`api/members-post.test.ts`** (5) — `POST /api/v1/members` : unauth
  rejected ; validation 400 (missing orgSlug, invalid email, missing
  body fields) ; 409 si user déjà membre.
- **`api/mgmt-tokens-preview.test.ts`** (12) — `POST /api/v1/mgmt/tokens/preview` :
  les 12 scénarios gate-resolution (all-allow, mix confirm/allow, contains
  deny, project policy override, env-scoped override, unknown risk,
  binding env propagation, etc.). Source de vérité du wire mint v4.
- **`api/mgmt-tokens-delete.test.ts`** (2 — _skipped_) — auth Bearer
  setup à débloquer.
- **`api/tokens-rotate.test.ts`** (2 — _skipped_) — idem.
- **`lib/approvals/mint.test.ts`** (3) — `mintForApproval` /
  `decideApproval` happy path + decision idempotence + denied case.
- **`lib/approvals/email-token.test.ts`** (6) — HMAC sign/verify
  (`signEmailToken` + `verifyEmailToken`) : roundtrip, expired token,
  tampered signature, wrong secret, malformed payload.
- **`lib/mint/preview.test.ts`** (4) — `computeMintPreview` :
  all-allow, mix allow+confirm, contains deny (blocked), honors project
  policy override (allow → deny).
- **`lib/risk-catalog/loader.test.ts`** (12) — `__setCatalogForTests`
  seam, `qualifyRiskId` (env null/empty/scoped/account/already-qualified/
  no-entry), `unqualifyRiskId` (strip + idempotent).

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

- **`api-key.test.ts`** (5) — `generateApiKey` / `parseApiKey` /
  `hashApiKey` / `verifyApiKey` ; preserve le prefix.

> Le test `capability.test.ts` (28 tests v1 sur `parseCapability` /
> `formatCapability` / `isGranted`) a été supprimé avec le drop v1
> (commit `chore(v1-drop)`) — le wire ne porte plus de tuples
> capability.

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

- ⚠️ **MCP gateway core (`gateway.ts`) non-unit-testé** — la suite
  v1 (`gateway.test.ts` + integration) a été supprimée avec le pivot.
  Il faut ré-écrire des tests v4 qui exercent auth + cache + single-use
  - audit row shape (`slices_executed`, `risks_touched`,
    `token_accepted_risks_snapshot`). Couverture actuelle = `risk-gateway.test.ts`
  - E2E `scripts/e2e-mint-flow.mjs`.
- ⚠️ **`mgmt-tokens-delete` + `tokens-rotate`** sont _skipped_
  — setup auth Bearer à débloquer.
- ⚠️ **`approvals/{channel,manual,telegram,email,index}`** — 5 modules
  non couverts directement (`mint.test.ts` et `email-token.test.ts`
  couvrent une partie). Couverture indirecte via `mgmt-tokens-preview` et
  l'E2E. Candidat priorité haute.
- ⚠️ **`bash` adapter MCP wiring** — pas encore implémenté
  (`build.ts:251-254`). Les invocations passent par le REST shortcut ;
  pas de test gateway de bout-en-bout pour `bash__*`.

## Références

- Spec : [`../spec/gateway-risk-model.md`](../spec/gateway-risk-model.md)
  (v4 risk-based, source de vérité du modèle d'autorisation).
- Handbooks liés : [[policy-engine]], [[mcp-gateway]], [[github-provider]],
  [[vercel-provider]], [[railway-provider]], [[bash-provider]],
  [[approvals]], [[web-app]].
- Workflow CI : [`../workflow/coding-workflow.md`](../workflow/coding-workflow.md)
  — `npm run ci` lance type-check + lint + format:check + test (cette suite) + build.
- E2E (Playwright) : [`./e2e-tests.md`](./e2e-tests.md).
