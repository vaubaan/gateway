---
title: Integration Tests Plan
tracks:
  - packages/core/tests/unit/crypto/kdf.test.ts
  - packages/core/tests/unit/crypto/keypair.test.ts
  - packages/core/tests/unit/crypto/wrap.test.ts
  - packages/core/tests/unit/crypto/sealed-box.test.ts
  - packages/core/tests/unit/crypto/recipient-defaults.test.ts
  - packages/web/tests/unit/api/recipients.test.ts
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

- `crypto-keypair-bootstrap.int.test.ts` — GET/PUT
  `/me/crypto-key`, round-trip wrap/unwrap. _Pending wave B
  (endpoints non encore livrés)._
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
