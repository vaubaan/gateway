---
title: Integration Tests Plan
tracks: []
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
  `/me/crypto-key`, round-trip wrap/unwrap.
- `recipient-list-compute.int.test.ts` — endpoint
  `/access/:key/recipients`, RLS-aware.

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

- **Aucun scénario implémenté à ce jour.** C'est attendu — la phase
  init ne livre que le squelette.
- Tous les scénarios listés ci-dessus seront ajoutés dans le commit
  qui livre la feature correspondante (doc-first, cf. `AGENTS.md`).

## Références

- Spec : `../spec/cloud-resource-manager.md` §12.2.
- E2E plan : `e2e-tests.md`.
- Handbooks à compléter en parallèle des tests :
  `../handbook/crypto-zk.md`, `../handbook/resources-and-access.md`,
  `../handbook/audit-log.md`.
