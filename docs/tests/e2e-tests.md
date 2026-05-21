---
title: E2E Tests Plan
tracks:
  - packages/web/src/lib/crypto/identity-store.ts
  - packages/web/src/lib/crypto/use-user-identity.ts
  - packages/web/src/components/identity/UnlockIdentityDialog.tsx
  - packages/web/src/components/identity/IdentityGate.tsx
  - packages/web/src/components/identity/SignOutButton.tsx
last_reviewed: 2026-05-21
---

# E2E Tests Plan

## Statut courant

**Squelette vide.** Aucun scénario E2E n'est implémenté en v1 init —
seul un test fumé `tests/e2e/smoke.spec.ts` (marqué `test.skip`) est
livré pour valider que Playwright est correctement câblé. Ce fichier
liste les scénarios qui seront ajoutés au fil des phases (cf. spec
§12.3 et `.claude/build-plans/init.json` `out_of_scope_for_init`).

## Périmètre

Les tests E2E exécutent des golden paths bout-en-bout : navigateur
Chromium piloté par Playwright contre une instance Next.js live + une
Supabase de test + de **vraies APIs Provider** (GitHub, Vercel,
Supabase Cloud).

Posture explicite **"no mock"** (spec §12.3) : un E2E qui passe ⇒ la
chaîne fonctionne contre un _vrai_ provider, dans les mêmes conditions
que la prod.

Ce qui **n'est pas** testé ici :

- Les interactions inter-modules sans navigateur → integration
  (`integration-tests.md`).
- Les contrats TypeScript purs → unit (`packages/*/tests/unit/`).

## Stack

- **Framework** : Playwright (cf. `playwright.config.ts`).
- **Browser** : Chromium uniquement en v1 (cf.
  `playwright.config.ts` projects).
- **Web app** : Next.js dev server local (`npm run dev`) ou déployé
  en preview Vercel selon le contexte d'exécution.
- **Supabase** : projet dédié à dériver (potentiellement le même
  prod en v1 init, ou un projet `cloud-resource-manager-e2e` plus
  tard).
- **Env vars** : `.env.test` (gitignored, cf. `.gitignore`).

## Conventions

### Org / project de test dédié par Provider

Chaque CloudProvider maintient un compte dédié **vauban-e2e**, séparé
de la prod, avec ses creds dans `.env.test` (cf. spec §12.3) :

| Provider   | Org/team/account                         | Vars `.env.test`                                               |
| ---------- | ---------------------------------------- | -------------------------------------------------------------- |
| infisical  | workspace `vauban-e2e` (Cloud Free tier) | `INFISICAL_TEST_WORKSPACE_ID`, `INFISICAL_TEST_API_TOKEN`      |
| github     | github.com/vauban-e2e                    | `GITHUB_TEST_PAT_READ`, `GITHUB_TEST_PAT_ADMIN` (`repo:admin`) |
| vercel     | team `vauban-e2e`                        | `VERCEL_TEST_TEAM_ID`, `VERCEL_TEST_ACCESS_TOKEN`              |
| supabase   | org `vauban-e2e`                         | `SUPABASE_TEST_ORG_REF`, `SUPABASE_TEST_ACCESS_TOKEN`          |
| cloudflare | account `vauban-e2e`                     | `CLOUDFLARE_TEST_ACCOUNT_ID`, `CLOUDFLARE_TEST_API_TOKEN`      |

### Naming des ressources transitoires

Toute ressource créée en cours de test (repo, project, deploy token,
secret) suit le naming canonique :

```
vauban-e2e-<testfile-hash6>-<run-uuid8>
```

Exemple : `vauban-e2e-a3f1c2-9b2dc714`. Permet (a) un cleanup ciblé
en `afterEach`, (b) au sweeper de retrouver les orphelins.

### Cycle de vie d'un test E2E

```
1. test setup    : load .env.test, génère run-uuid
2. test body     : provision via Admin → resource créée chez provider
                   + row CRM persistée
3. test asserts  : metadata, sealed_blob, RLS, audit row
4. afterEach     : destroyChild côté provider + DELETE Vauban
                   (idempotent ; sweeper finit le job si crash)
5. afterAll      : si tous les afterEach OK, no-op
```

### Sweeper (cron CI nightly)

Workflow `.github/workflows/nightly.yml` (stub en v1 init).

- Liste les ressources `vauban-e2e-*` côté chaque provider, supprime
  celles de plus de 24h.
- Exécuté hors heures ouvrées, alerte Telegram si > N orphelins
  (signal de crashs E2E non-cleanés).

### Coût et rate-limit

Chaque scénario est conçu pour **1 cycle create→destroy par run**.
Pas de boucles. La somme des coûts attendue est négligeable (les
providers ciblés ont tous des tiers free pour le test).

## Scénarios couverts

_Aucun scénario implémenté en v1 init._

Les scénarios suivants (spec §12.3) seront ajoutés au fil des phases :

- [ ] **register-org-resource** — Register OrgResource (kind
      `<provider>-org`) → health check → unseal.
      Spec §7.1.
      Phase 4 wave C livre la stack côté code (`/sign-up` →
      `/onboarding` → `/orgs/:slug/resources/new` wizard → POST
      `/resources` + PUT `/access/:key`). Playwright E2E à câbler
      contre un projet Supabase de test et un PAT GitHub jetable —
      pending un harness sur le workflow GitHub Actions.
- [ ] **provision-via-org-admin** — Register OrgResourceAdmin →
      register OrgResource → provision ProjectResource via Admin →
      assert provider-side création effective.
      Spec §7.2, §7.3. **Phase 6 wave C livre l'UI** (`<ProvisionWizard>`)
      et les endpoints REST ; l'E2E reste à câbler contre un projet
      GitHub/Vercel/Supabase de test.
- [ ] **rotate-admin-mediated** — Rotation Access en
      `admin-mediated` → assert ancien token invalidé côté provider,
      nouveau token valide.
      Spec §0.1, §7.4. **Phase 6 wave C livre l'UI**
      (`<RotateAccessButton>`) + le dispatcher REST ; l'E2E contre
      vrais providers attend le harness GH Actions.
- [ ] **destroy-cloud-resource** — Click `Destroy cloud resource`
      sur une project Resource provisionnée via Admin → confirm
      type-name → assert provider-side suppression effective + row
      CRM supprimée + audit `resource.destroyed-cloud-side`.
      Spec §6.5, §7.3. Phase 6 wave C livre le bouton ; l'E2E
      contre vrais providers attend le harness GH Actions.
- [ ] **rotate-manual-fallback** — Lance une rotation
      `admin-mediated` sur une clé non-supportée (`SUPABASE_SERVICE_ROLE_KEY`,
      `VERCEL_TOKEN` project-scoped, ou GitHub PAT App-only) →
      assert que l'UI bascule sur le flow manual paste avec
      `err.setupDocs` rendu. Phase 6 wave C couvre ce chemin en
      unit tests ; l'E2E contre vrais providers attend le harness.
- [ ] **export-env-project-variant** — Export `.env` pour
      `(project, variant)` → fichier téléchargé, lignes attendues
      présentes, secrets en placeholder pour les blobs
      non-decryptables.
      Spec §7.5. **Phase 7 livre l'UI**
      (`<DotenvExportButton>` sur la page
      `/orgs/:slug/projects/:projectSlug/exports`) et les
      endpoints REST (`/exports/env`) ; l'E2E doit naviguer vers
      la page, sélectionner le variant `staging` via
      `<VariantSelector>`, cliquer Download .env, et asserter que
      le `<a download>` a déclenché un fichier avec les bonnes
      lignes (et placeholders `# UNAVAILABLE: ...` quand l'user
      n'est pas recipient). Couvert en unit tests
      `packages/web/tests/unit/components/exports.test.tsx`.
- [ ] **export-cloud-resource-map** — Sur la page
      `/orgs/:slug/exports`, cliquer "Download
      cloud-resource-map.json" → assert (i) le fichier téléchargé
      est un JSON `version: 1` listant chaque Resource avec sa
      `secret_manager: { kind, name }` et ses `access_keys` ;
      (ii) **aucun champ `sealed_blob` ni `ct` ni cleartext**
      n'apparaît nulle part dans le JSON (assert via
      `JSON.stringify(body).includes(...) === false`).
      Spec §6.7.1. **Phase 7 livre l'UI**
      (`<CloudResourceMapButton>`) + l'endpoint
      (`/exports/cloud-resource-map`). Couvert en unit tests
      (route + bouton).
- [ ] **rbac-member-cannot-patch** — Un `member` non-admin ne peut
      pas PATCH une Resource ; assert 403.
      Spec §3.3, §8.
- [ ] **re-seal-membership-change** — Ajouter un member, assert
      `recipients_stale=true` sur les blobs, déclencher re-seal,
      assert blobs déchiffrables par le new member.
      Spec §4.5. Phase 5 livre l'UI banner + le handler `runReseal` ;
      le trigger sur INSERT `org_members` arrive en Phase 6+.
- [ ] **connect-infisical-wizard** — Connexion d'un workspace
      Infisical : ouvrir `/orgs/:slug/secret-managers/new`, remplir
      `workspace_id` + `endpoint` + `(clientId, clientSecret)`,
      cocher recipients, seal, submit. Assert : 201 POST
      `/secret-managers`, row visible dans la list page avec
      badge `default` si coché, **0 `clientSecret` cleartext dans
      Network panel et 0 `localStorage`/`sessionStorage`/`IndexedDB`
      write touché côté browser**.
      Spec §5.2, §6.2, §11.1.
- [ ] **crypto-identity-first-login** — User vient de signer up, tape
      son password dans `UnlockIdentityDialog`. Assert : POST
      `/api/crm/v1/me/crypto-key` part avec un body `public_key`,
      `fingerprint`, `wrapped_private_key`, `kdf_salt` en base64 ; row
      `user_crypto_keys` créée ; `IdentityGate` rend ensuite les
      children. Aucun `localStorage` / `sessionStorage` / `IndexedDB`
      n'a été touché côté browser (assert via `await page.evaluate(...)`).
      Spec §4.1 steps 1-6 + §4.1.1.
- [ ] **crypto-identity-unlock-at-relogin** — User existant, sk
      cachée dans `identityStore` après unlock. Reload tab ⇒ store
      vide (memory only) ⇒ dialog re-apparaît ⇒ tape password
      correct ⇒ unwrap OK ⇒ assert `identity.fingerprint` matche
      celui de la row Supabase. Re-tape un mauvais password ⇒
      message d'erreur "wrong password" affiché, pas de fuite du
      password lui-même dans le DOM ou la console.
      Spec §4.1 step 4.
- [ ] **crypto-identity-logout-wipes-memory** — User unlocked,
      clique `SignOutButton`. Assert : `identityStore.get()`
      retourne `null` **avant** que `supabase.auth.signOut()` ne
      complete (l'ordre compte — la sk doit être wipée d'abord).
      Re-navigue : la page protégée force un nouveau prompt unlock,
      pas de cache résiduel.
      Spec §4.1.1.

## Trous connus

- **Aucun scénario implémenté à ce jour.** C'est attendu — phase init.
- Le **sweeper** est un stub `echo` dans
  `.github/workflows/nightly.yml`. Sera concretisé phase 8 (cf.
  build plan `out_of_scope_for_init`).
- Pas de couverture **mobile** : Playwright tourne Chromium desktop
  uniquement en v1. Si une feature CRM exige du touch, l'étendre.

## Références

- Spec : `../spec/cloud-resource-manager.md` §12.3.
- Integration plan : `integration-tests.md`.
- Workflow CI : `../workflow/coding-workflow.md`.
- Stub workflow nightly : `../../.github/workflows/nightly.yml`.
