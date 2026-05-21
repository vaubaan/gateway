---
title: Resources et resource_access — CRUD, RLS, audit
tracks:
  - supabase/migrations/1000_provider_resource_manager.sql
  - packages/web/src/lib/resource-access/db.ts
  - packages/web/src/lib/validation/sealed-blob.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/resources/[rId]/access/route.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/resources/[rId]/access/[key]/route.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/resources/[rId]/access/[key]/rotate/route.ts
  - packages/web/tests/unit/api/resource-access.test.ts
last_reviewed: 2026-05-21
---

# Resources et resource_access — handbook

Document l'implémentation effective des tables `public.resources` et
`public.resource_access` (spec §3.1), les endpoints REST `/api/crm/v1`
(spec §6.3-§6.4), et leur écriture/lecture côté UI.

## Statut courant

**Phase 4, wave A (1/2) livré : Access REST CRUD.**

La feature sœur `resources-rest-api` (Phase 4, wave A) livre en
parallèle les endpoints `/orgs/:orgId/resources`. La section
"Resources REST" du handbook (mergée séparément) documente ce volet.

**À livrer phase 4** :

- Wave A : `resources-rest-api` — endpoints `/orgs/:orgId/resources`
  (parallel feature).
- Wave B : `<SealedInput>` + pages `/orgs/:slug/resources` et detail.
- Wave C : onboarding + wizard register.

## Décisions amont

- ADR `docs/decisions/rls-minimaliste-2-roles.md` — politique RLS
  member/admin uniquement, granularité fine via crypto.

## Spec de référence

- `docs/spec/cloud-resource-manager.md` §3.1 — schéma des tables.
- `docs/spec/cloud-resource-manager.md` §3.3 — RLS matrix.
- `docs/spec/cloud-resource-manager.md` §4.3 — `SealedBlobV1`.
- `docs/spec/cloud-resource-manager.md` §6.4 — endpoints REST access.
- `docs/spec/cloud-resource-manager.md` §7.1, §7.4 — workflows write /
  rotate.

## Access REST — `feature/p4-access-rest-api`

Préfixe : `/api/crm/v1/orgs/:orgId/resources/:rId/access`. Le segment
`:orgId` accepte UUID ou slug (mêmes règles que la feature sœur).
RLS-gated via `resource_access_select_member` (R) et
`resource_access_{insert,update,delete}_admin` (W).

Toutes les routes sont `dynamic = 'force-dynamic'` + `Cache-Control:
no-store` — un sealed_blob n'a aucune raison de transiter par un
cache intermédiaire.

### Format on-disk

`resource_access.sealed_blob` est une colonne **bytea** (cf. migration
1000). On y stocke les **bytes UTF-8 du JSON canonique** `SealedBlobV1`
(spec §4.3) :

```jsonc
{
  "v": 1,
  "recipients": [{ "fp": "<32-hex>", "ct": "<base64 of crypto_box_seal output>" }],
}
```

Les helpers `sealedBlobToBytea` et `byteaToSealedBlob`
(`packages/web/src/lib/resource-access/db.ts`) font la conversion à la
frontière Postgres. La colonne reste opaque côté serveur ; la
recipient list à l'intérieur est lisible en clair par toute session
qui a un SELECT sur la row — c'est le contrat spec §4.4
(fingerprints publics, ciphertexts secrets).

### Endpoints

| Verbe  | Path                                       | RLS       | Status nominaux             |
| ------ | ------------------------------------------ | --------- | --------------------------- |
| GET    | `/access`                                  | member    | 200 / 401 / 404             |
| GET    | `/access/:key`                             | member    | 200 / 401 / 404             |
| PUT    | `/access/:key`                             | admin (W) | 200 / 400 / 401 / 403 / 404 |
| DELETE | `/access/:key`                             | admin (W) | 200 / 401 / 403 / 404       |
| POST   | `/access/:key/rotate` (stub, voir Phase 6) | member    | 202 / 401 / 404             |

### `GET /access`

Retourne **uniquement le résumé** : `{ key, description, rotated_at,
recipient_count }`. Pas de `sealed_blob`. Le `recipient_count` est
calculé en parsant la colonne `bytea` côté serveur (le client n'a pas
besoin du blob entier pour afficher la list page). Test : aucun champ
`ct` dans la réponse (`expect(JSON.stringify(body)).not.toContain('"ct"')`).

### `GET /access/:key`

Retourne le blob canonique : `{ key, description, rotated_at,
sealed_blob: { v: 1, recipients: [...] } }`. Un member RLS-visible
peut le récupérer ; il ne pourra **déchiffrer** que les `recipients`
qui matchent son fingerprint (spec §3.3 footnote — granularité fine
côté crypto, pas côté SQL).

### `PUT /access/:key`

Body :

```jsonc
{
  "sealed_blob": { "v": 1, "recipients": [{ "fp": "...", "ct": "..." }] },
  "description": "optional human-readable label",
}
```

(Le client peut aussi poster le blob "à la racine" — le validateur
détecte la forme `{ sealed_blob }` automatiquement.)

Validation stricte (`packages/web/src/lib/validation/sealed-blob.ts`) :

- `v` est exactement `1` (literal type).
- `recipients` est un array non-vide (≥ 1 entry).
- Pas de doublon de fingerprint.
- Chaque `fp` matche `^[0-9a-f]{32}$`.
- Chaque `ct` est base64 valide ET décode à ≥ 48 bytes (taille
  minimale d'un `crypto_box_seal` envelope = 32 bytes ephemeral pubkey
  - 16 bytes MAC = 48 minimum).
- La clé d'URL `:key` matche `^[A-Z][A-Z0-9_]*$` (env-var style,
  cohérent avec `kind.accessSchema` du catalog).

Côté DB on fait un **upsert** sur `(resource_id, key)` (UNIQUE en
migration 1000). `rotated_at = now()` à chaque PUT.

Audit log : `resource.access.put`, `subject = { recipient_count }`.
**Jamais** de `ct` dans le log (vérifié par test :
`expect(JSON.stringify(audit_row)).not.toContain('"ct"')`).

Erreurs DB :

- `42501` (RLS denial) → 403.
- Autre → 500.

### `DELETE /access/:key`

Détache la row du sealed_blob. Snapshot pour le `recipient_count`
d'audit, second probe pour différencier 404 de 403. Audit
`resource.access.deleted`, même subject que PUT.

### `POST /access/:key/rotate` (stub Phase 4)

Lit `kind.rotationMethod` depuis le catalog et retourne 202 avec :

```jsonc
{
  "status": "pending-runner",
  "rotation_method": "self|admin-mediated|manual",
  "next_step": "runner-self-rotation|admin-rotate-child|operator-action",
  "message": "rotation dispatch lands Phase 6",
}
```

Audit `resource.access.rotate.requested`, `subject = { rotation_method }`.
Phase 6 livrera le dispatch réel (Runner pour `self`, parent admin
pour `admin-mediated`, redirect vers setupDocs pour `manual`).

## Garanties ZK et audit

**ZK invariant** (spec §2.3) : aucun cleartext de secret ne transite
côté serveur. Le validateur `parseSealedBlob` ne décode les `ct` que
pour en mesurer la taille minimale ; il ne les loggue jamais.

**Audit** : seuls `{ resource_id, key, kind, scope, recipient_count }`
sont écrits — testé en grep dans
`packages/web/tests/unit/api/resource-access.test.ts` :

```ts
expect(JSON.stringify(auditRow)).not.toContain('"ct"');
```

**Pas de service-role** : toutes les queries portent la session de
l'user. Aucun fichier sous
`packages/web/src/app/api/crm/v1/orgs/[orgId]/resources/[rId]/access/`
ne lit `SUPABASE_SERVICE_ROLE_KEY` (audit grep).

## Tests

`packages/web/tests/unit/api/resource-access.test.ts` (17 scénarios) :

- `GET /access` : 401 sans session, summary correct + `recipient_count`
  exact, aucun `ct` dans la réponse.
- `GET /access/:key` : 404 si absent, shape canonique `v=1` retournée.
- `PUT /access/:key` : upsert OK + audit, refus `v != 1`, recipients
  vides, fp non-hex, ct trop court, ct non-base64, key URL en
  lowercase, RLS 403 simulé, round-trip PUT → GET équivalence exacte.
- `DELETE /access/:key` : 200 + audit, 404 si absent.
- `POST /:key/rotate` : 202 + `rotation_method=manual` pour
  `github-org`, `admin-mediated` + `admin-rotate-child` pour
  `github-repo` (project kind).

Tests integration RLS-aware contre vrai Supabase : TODO
`docs/tests/integration-tests.md` ("Resources CRUD (phase 4)").

## Roadmap d'implémentation

Phase 4 du roadmap (cf. build plan `phase-4-resources-crud.json`) :

- [ ] Wave A — `resources-rest-api` : endpoints §6.3 (parallel feature).
- [x] **Wave A — `access-rest-api`** : endpoints §6.4 livrés.
- [ ] Wave B — `<SealedInput>` + pages list / detail.
- [ ] Wave C — onboarding + wizard register Resource.
