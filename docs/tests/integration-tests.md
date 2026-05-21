---
title: Integration Tests Plan
tracks:
  - packages/core/tests/unit/crypto/kdf.test.ts
  - packages/core/tests/unit/crypto/keypair.test.ts
  - packages/core/tests/unit/crypto/wrap.test.ts
  - packages/core/tests/unit/crypto/sealed-box.test.ts
  - packages/core/tests/unit/crypto/recipient-defaults.test.ts
  - packages/web/tests/unit/api/me-crypto-key.test.ts
  - packages/web/tests/unit/validation/crypto-key.test.ts
  - packages/web/tests/unit/api/recipients.test.ts
  - packages/crm-catalog/tests/unit/providers/github.test.ts
  - packages/crm-catalog/tests/unit/providers/vercel.test.ts
  - packages/crm-catalog/tests/unit/providers/supabase-cloud.test.ts
  - packages/crm-catalog/tests/unit/registry.test.ts
  - packages/web/tests/unit/api/catalog.test.ts
last_reviewed: 2026-05-21
---

# Integration Tests Plan

## Statut courant

**Squelette vide.** Aucun scénario d'intégration n'est encore implémenté
en v1 init. Ce fichier pose la structure pour que les phases ultérieures
(2-7, cf. `.claude/build-plans/init.json`) y déposent leurs scénarios
dans le même commit que le code testé (doc-first, cf. `AGENTS.md`).

## Périmètre

Les tests d'intégration du Cloud Resource Manager (CRM) couvrent les
interactions inter-modules **sans navigateur** : route handlers Next.js,
helpers `@supabase/ssr`, policies RLS, recipient list crypto, audit
log writers. Tout tourne dans un seul process Node.js + une instance
Supabase de test (locale via `supabase start`, ou container éphémère
en CI).

Ce qui **n'est pas** testé ici :

- Le rendu UI / l'interaction utilisateur → couvert par les E2E
  (`docs/tests/e2e-tests.md`).
- Les contrats `ResourceKind` / `SecretManager` purs (sans DB) →
  couverts par les unit tests à côté du code
  (`packages/*/tests/unit/`).
- Les appels APIs Provider externes (GitHub, Vercel, Supabase Cloud
  côté provider) → couverts uniquement par les E2E (spec §12.3 "no
  mock").

## Stack

- **Framework** : Vitest (cf. `vitest.config.ts`).
- **DB de test** : Supabase local stack (`supabase start`) ou
  container éphémère en CI. Les migrations sous
  `supabase/migrations/` sont appliquées au démarrage.
- **Mocks / fixtures cardinales** : à définir au fur et à mesure.
  Aucune fixture committée en v1 init.
- **Env vars cardinales** : à définir (probable `SUPABASE_TEST_URL`,
  `SUPABASE_TEST_SERVICE_ROLE_KEY`).

## Conventions

- **Naming** : `*.int.test.ts` à côté des modules concernés, ou
  `packages/<name>/tests/integration/*.test.ts`. À figer dans une
  ADR ou ici quand les premiers tests d'intégration arrivent.
- **Structure** : un fichier par feature CRM testée (par exemple
  `resources.int.test.ts`, `resource-access.int.test.ts`,
  `audit-log.int.test.ts`).
- **Fixtures** : helpers `createTestOrg()`, `createTestUser()`,
  `signInAs(user)` à factoriser sous `packages/web/tests/fixtures/`
  quand le premier scénario en a besoin.
- **Cleanup** : chaque test rollback sa transaction ou drop son org
  de test. Cible : aucun état partagé entre tests.

## Scénarios couverts

_Aucun scénario en v1 init._

Les scénarios suivants seront ajoutés au fil des phases (cf.
`docs/spec/cloud-resource-manager.md §12.2`) :

### Crypto ZK (phase 2)

> Couvrira: `docs/spec/cloud-resource-manager.md` §4.

**Livré dans `feature/api-me-crypto-key`** — wave B, phase 2. Tests
unit avec mock du client Supabase (fichier
`packages/web/tests/unit/api/me-crypto-key.test.ts`). Les vrais tests
d'intégration "instance Supabase de test + RLS effective" attendent
encore le harnais d'intégration (pending — voir trous connus).

- [x] `GET sans session` → 401.
- [x] `GET sans row` → 404.
- [x] `POST {payload valide}` → 201 + row créée + audit
      `user.crypto-key.created` (org-less).
- [x] `GET après POST` → 200 + payload identique (modulo encoding).
- [x] `POST avec params Argon2id trop faibles` → 400
      `kdf_params_too_weak`.
- [x] `POST sur row déjà existante` → 409.
- [x] `PATCH rotate-password` (sans `replace`) → 200, pubkey
      inchangée, audit `user.crypto-key.rotated-password`.
- [x] `PATCH replace=true` → 200, pubkey remplacée, audit
      `user.crypto-key.replaced-identity` avec `old_fingerprint`.
- [x] `PATCH` sans row → 404.
- [x] Invariant ZK : aucun byte de wrapped_sk / kdf_salt / public_key
      ne fuit dans `audit_log.subject`.
- [x] Validation (`tests/unit/validation/crypto-key.test.ts`) : tailles
      des bytea, regex fingerprint, accept defaults Argon2id, refus
      des params trop faibles, refus alg ≠ `argon2id`.

**TODO — vrais tests d'intégration (instance Supabase de test)** :

- `me-crypto-key.int.test.ts` — créer un user via service-role,
  signIn, exécuter le contrat HTTP complet contre un projet Supabase
  de test, vérifier que la RLS bloque effectivement un user A qui
  PATCHerait la row d'un user B. _Pending : harnais
  d'intégration Supabase (env vars `SUPABASE_TEST_URL` /
  `SUPABASE_TEST_SERVICE_ROLE_KEY` à câbler ; spec §12.2)._
- `recipient-list-compute.int.test.ts` — endpoint
  `/access/:key/recipients`, RLS-aware.
  - **Couverture unit livrée** dans
    `packages/web/tests/unit/api/recipients.test.ts` (Supabase
    client mocké, 6 scénarios passants) :
    - [x] 401 sans session.
    - [x] 404 quand la resource n'est pas visible (RLS empty).
    - [x] defaults pour une resource non-admin (2 members avec
          keypair) — 2 entrées avec `user_id`, `public_key`
          (base64) et `fingerprint`.
    - [x] defaults pour une resource org-admin — idem (phase 2
          stub, pas de runner à exclure).
    - [x] exclusion d'un member sans `user_crypto_keys` row.
    - [x] décodage du `bytea` au wire format Postgres `\x<hex>`.
  - **Integration RLS-aware** (TODO wave B / wave C une fois le
    harness Supabase test prêt). Setup à câbler :
    1. service-role test helper (`SUPABASE_PROD_URL` +
       `SUPABASE_PROD_SERVICE_ROLE_KEY` en local) crée 1 org, 2
       users + sessions, insère `org_members`, génère 2 keypairs
       via `@crm/core/crypto` et insère `user_crypto_keys`,
       insère 1 `secret_managers` (FK obligatoire pour
       `resources.secret_manager_id NOT NULL`), insère 2
       `resources` (une `is_admin=false`, une `is_admin=true`).
    2. signIn comme un user → JWT → invoke `GET /api/.../recipients`
       via le handler (import direct + fake session) ou via un
       Next test server.
    3. Scénarios RLS-aware : (a) member voit ses pairs, (b)
       non-member → 404, (c) admin resource n'inclut pas le
       runner même si on en simule un (futur), (d) un user
       sans `user_crypto_keys` ligne est exclu.
    4. Cleanup en `afterAll` (delete users → cascade).

**Unit-level (livré dans `feature/crypto-core-lib`)** — couvre les
primitives pures de `@crm/core/crypto` (KDF Argon2id, X25519 keypair,
secretbox wrap, multi-recipient sealed-box, defaults). Fichiers sous
`packages/core/tests/unit/crypto/`:

- `kdf.test.ts` — determinism + refus de params trop faibles + refus
  de salt mal taillé.
- `keypair.test.ts` — tailles, format fingerprint sha256(pub)[..16]
  hex, unicité.
- `wrap.test.ts` — roundtrip `wrap` / `unwrap`, refus de mauvaise
  KEK, détection de tampering.
- `sealed-box.test.ts` — multi-recipient (3 users), non-recipient
  reçoit `null`, tampering détecté.
- `recipient-defaults.test.ts` — règle §4.4 (members ± runner selon
  `org-admin`).

### Catalogue providers (phase 3)

> Couvrira: spec §5.1, §5.3, §6.1.

**Unit-level — `feature/kinds-github`** :
`packages/crm-catalog/tests/unit/providers/github.test.ts` couvre les
3 kinds GitHub (`github-org`, `github-org-admin`, `github-repo`) :

- [x] Contrat ResourceKind respecté (id, provider, kindClass,
      displayName, rotationMethod, accessSchema, healthTestCmd,
      egressHosts).
- [x] `github-org-admin` narrow vers `OrgResourceAdminKind` et déclare
      `manages = ['github-repo']`.
- [x] Provider operations (`createChild`, `destroyChild`,
      `listChildren`, `rotateChildAccess`) throw le marker
      `phase-6: …` (Phase 6 livrera les vraies impl).
- [x] `setupDocs` markdown >100 chars, mentions des sections
      attendues (fine-grained PAT, scopes admin, admin-mediated).
- [x] `healthTestCmd` interpole les champs metadata sans jamais
      embarquer la cleartext du token.
- [x] `mcpFragment` conforme à la shape `McpServerFragment` (cf.
      `.mcp.json` racine) — image `ghcr.io/github/github-mcp-server`,
      env `GITHUB_PERSONAL_ACCESS_TOKEN`.
- [x] `egressHosts` non-vide pour les kinds non-project.
- [x] Pas de cleartext `github_pat_…` dans les labels /
      descriptions / env mcpFragment.

**Unit-level — `feature/kinds-vercel`** :
`packages/crm-catalog/tests/unit/providers/vercel.test.ts` couvre les
3 kinds Vercel (`vercel-team`, `vercel-team-admin`,
`vercel-project`) :

- [x] Contrat ResourceKind respecté (id, provider, kindClass,
      displayName, rotationMethod, accessSchema, healthTestCmd,
      egressHosts).
- [x] `vercel-team-admin` narrow vers `OrgResourceAdminKind` et
      déclare `manages = ['vercel-project']`.
- [x] Provider operations (`createChild`, `destroyChild`,
      `listChildren`, `rotateChildAccess`) rejettent avec le marker
      `phase-6: …` (Phase 6 livrera les vraies impl).
- [x] `setupDocs` markdown >100 chars, mentions des sections
      attendues (token creation, team id, admin role).
- [x] `healthTestCmd` interpole les champs metadata sans jamais
      embarquer la cleartext du token.
- [x] `mcpFragment` conforme à la shape HTTP remote (`{ type:
'http', url: 'https://mcp.vercel.com/' }`, cf. `.mcp.json`
      racine).
- [x] `egressHosts` non-vide pour les kinds non-project, couvre
      `api.vercel.com` et `mcp.vercel.com`.
- [x] `vercel-project` déclare les 3 clés (`VERCEL_TOKEN`,
      `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`) avec regex appropriées
      (`prj_…`, `team_…`).

**Unit-level — `feature/kinds-supabase`** :
`packages/crm-catalog/tests/unit/providers/supabase-cloud.test.ts`
couvre les 3 kinds Supabase Cloud (`supabase-org`,
`supabase-org-admin`, `supabase-project`) :

- [x] Contrat ResourceKind respecté (id, provider, kindClass,
      displayName, rotationMethod, accessSchema, healthTestCmd,
      egressHosts).
- [x] `supabase-org-admin` narrow vers `OrgResourceAdminKind` et
      déclare `manages = ['supabase-project']`.
- [x] Provider operations (`createChild`, `destroyChild`,
      `listChildren`, `rotateChildAccess`) rejettent avec le marker
      `phase-6: …` (Phase 6 livrera les vraies impl Management API).
- [x] `setupDocs` markdown >100 chars, mentions des sections
      attendues (PAT creation, org slug, Owner/Administrator,
      service_role rotation).
- [x] `healthTestCmd` interpole l'org slug ou le project URL sans
      jamais embarquer la cleartext du PAT.
- [x] `supabase-project.healthTestCmd` n'utilise **jamais**
      `$SUPABASE_SERVICE_ROLE_KEY` (un healthcheck passif ne doit pas
      leak le service_role).
- [x] `mcpFragment` conforme à la shape stdio (`npx`, args
      référençant `@supabase/mcp-server-supabase` avec
      `--access-token ${SUPABASE_ACCESS_TOKEN}` en placeholder, cf.
      `.mcp.json` racine). Pas de PAT cleartext (`^sbp_…`) dans les
      args.
- [x] `egressHosts` non-vide pour les kinds non-project. Pour
      `supabase-project`, inclut le hostname `<projectRef>.supabase.co`
      dérivé de metadata.
- [x] `supabase-project` déclare les 5 clés (`SUPABASE_URL`,
      `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
      `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_REF`) avec regex
      appropriées (`https://[a-z]{20}\.supabase\.co`, JWT format
      `eyJ.eyJ.…`, project ref `[a-z]{20}`).

**Wave B — `feature/catalog-registry-and-endpoint`** (livré) :

`packages/crm-catalog/tests/unit/registry.test.ts` — 15 invariants
structurels (spec §12.4 + v1 allowlist) :

- [x] `CATALOG` ship 9 entries, frozen, ids uniques.
- [x] `kindClass` ∈ `{org, project, org-admin}`,
      `rotationMethod` ∈ `{self, admin-mediated, manual}`.
- [x] Tout `org-admin` déclare `manages` non-vide, et chaque id de
      `manages` résout vers un kind `kindClass='project'`.
- [x] Tout `org` est `rotationMethod='manual'` (spec §0.1).
- [x] Tout `id` matche `/^[a-z][a-z0-9-]*$/`,
      `provider` ∈ allowlist v1 `{github, vercel, supabase-cloud}`.
- [x] Tout `setupDocs` ≥ 100 chars, tout `accessSchema` non-vide.
- [x] `findKind` retourne `undefined` pour un id inconnu et un
      pointeur référentiellement identique pour deux lookups.

`packages/web/tests/unit/api/catalog.test.ts` — 10 assertions sur
les handlers Next.js :

- [x] `GET /catalog` → 200 + 9 kinds, sans aucune fonction sur le
      wire (`healthTestCmd`, `mcpFragment`, `listChildren`, etc.
      absents).
- [x] Chaque kind du payload list a un schema minimum (id, provider,
      kindClass, displayName, setupDocs ≥ 100, accessSchema non-vide,
      rotationMethod valide, egressHosts array).
- [x] Les `org-admin` du payload portent `manages` non-vide.
- [x] Les ids exposés == v1 inventory (`{github-…, vercel-…, supabase-…}`).
- [x] Header `Cache-Control: public, max-age=…`.
- [x] `GET /catalog/:kindId` → 200 sur known, setupDocs markdown,
      `manages` pour org-admin.
- [x] `GET /catalog/nope` → 404 `{ error: 'unknown_kind', kindId }`.
- [x] Le single-kind path filtre aussi les fonctions.

### Resources CRUD (phase 4)

> Couvrira: spec §3.1, §3.3, §6.3, §6.4.

- `resources-crud.int.test.ts` — POST/GET/PATCH/DELETE sur
  `resources` avec RLS member vs admin.
- `resource-access-put.int.test.ts` — PUT d'un `sealed_blob`,
  validation du format multi-recipient.
- `resource-access-rls.int.test.ts` — un member fetch le blob
  mais ne peut déchiffrer que les recipient-listed.

### SecretManagers (phase 5)

> Couvrira: spec §5.2, §6.2.

- `secret-managers-crud.int.test.ts` — registration Infisical,
  is_default partial unique constraint.

### Provisioning + Rotation (phase 6)

> Couvrira: spec §6.5, §7.3, §7.4.

- `provision-via-admin.int.test.ts` — POST `/provision` crée la
  row child + check du `admin_resource_id` link.
- `rotate-access-dispatch.int.test.ts` — endpoint rotate retourne
  `rotationMethod`, 409 si admin-mediated sans admin attached.

### MCPConfigs + Exports (phase 7)

> Couvrira: spec §6.6, §6.7.

- `mcp-config-upsert.int.test.ts` — UPSERT sur l'index unique
  `(org, project, variant)`.
- `export-env-filter-by-variant.int.test.ts` — sélection des
  Resources visibles à `(project, variant)` selon spec §7.5.

### Audit log (transverse)

> Couvrira: spec §9.

- `audit-log-on-mutation.int.test.ts` — toute mutation CRM crée
  une row `audit_log` ; le browser ne peut pas insérer.

## Trous connus

- **Pas d'integration test RLS-aware** sur le recipient list endpoint
  encore : la couverture côté handler est unit (Supabase mocké). Le
  TODO est balisé dans la section "Crypto ZK (phase 2)" ci-dessus.
- Tous les autres scénarios listés ci-dessus seront ajoutés dans le
  commit qui livre la feature correspondante (doc-first, cf.
  `AGENTS.md`).

## Références

- Spec : `../spec/cloud-resource-manager.md` §12.2.
- E2E plan : `e2e-tests.md`.
- Handbooks à compléter en parallèle des tests :
  `../handbook/crypto-zk.md`, `../handbook/resources-and-access.md`,
  `../handbook/audit-log.md`.
