---
title: Resources et resource_access — CRUD, RLS, audit
tracks:
  - supabase/migrations/1000_provider_resource_manager.sql
  - packages/web/src/lib/resources/db.ts
  - packages/web/src/lib/validation/resources.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/resources/route.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/resources/[rId]/route.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/resources/[rId]/health/route.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/resources/[rId]/refresh/route.ts
  - packages/web/tests/unit/api/resources.test.ts
last_reviewed: 2026-05-21
---

# Resources et resource_access — handbook

Document l'implémentation effective des tables `public.resources` et
`public.resource_access` (spec §3.1), les endpoints REST `/api/crm/v1`
(spec §6.3-§6.4), et leur écriture/lecture côté UI.

## Statut courant

**Phase 4, wave A (1/2) livré : Resources REST CRUD.**

Le scaffold v1 init avait livré le schéma SQL + indices + RLS sur les
deux tables. La feature `resources-rest-api` (Phase 4, wave A) ajoute
maintenant la totalité des endpoints `GET / POST / GET :rId / PATCH /
DELETE` plus les stubs `POST /health` et `POST /refresh`. La feature
sœur `access-rest-api` (Phase 4, wave A) livre en parallèle les
endpoints sur `resource_access` (voir section "Access" plus bas une
fois mergée).

**À livrer phase 4** :

- Wave A : `access-rest-api` — endpoints `/resources/:rId/access[/:key][/rotate]`.
- Wave B : `<SealedInput>` + pages `/orgs/:slug/resources` et detail.
- Wave C : onboarding + wizard register.

## Décisions amont

- ADR `docs/decisions/rls-minimaliste-2-roles.md` — politique RLS
  member/admin uniquement, granularité fine via crypto.

## Spec de référence

- `docs/spec/cloud-resource-manager.md` §3.1 — schéma des tables.
- `docs/spec/cloud-resource-manager.md` §3.2 — indices.
- `docs/spec/cloud-resource-manager.md` §3.3 — RLS matrix.
- `docs/spec/cloud-resource-manager.md` §6.3-§6.4 — endpoints REST.
- `docs/spec/cloud-resource-manager.md` §7.1-§7.4 — workflows.
- `docs/spec/cloud-resource-manager.md` §11 — UX (pages, patterns).

## Resources REST — `feature/p4-resources-rest-api`

Préfixe : `/api/crm/v1/orgs/:orgId/resources`. Le segment `:orgId` accepte
**soit l'UUID** soit le **slug** de l'organisation (UI vs M2M). RLS
gate la résolution : `findOrgIdBySlugOrId()` retourne `null` si l'user
n'est pas membre, qu'on remappe vers `404 { error: 'not_found' }` (la
même réponse qu'une org inexistante — pas de surface de probing).

Toutes les routes sont `dynamic = 'force-dynamic'` (lectures session-
qualifiées) avec `Cache-Control: no-store`.

### Endpoints

| Verbe  | Path                                         | RLS effective      | Status codes nominaux             |
| ------ | -------------------------------------------- | ------------------ | --------------------------------- |
| GET    | `/orgs/:orgId/resources`                     | member (R)         | 200 / 401 / 404                   |
| POST   | `/orgs/:orgId/resources`                     | admin (W)          | 201 / 400 / 401 / 403 / 404 / 409 |
| GET    | `/orgs/:orgId/resources/:rId`                | member (R)         | 200 / 401 / 404                   |
| PATCH  | `/orgs/:orgId/resources/:rId`                | admin (W)          | 200 / 400 / 401 / 403 / 404 / 409 |
| DELETE | `/orgs/:orgId/resources/:rId`                | admin (W)          | 200 / 401 / 403 / 404             |
| POST   | `/orgs/:orgId/resources/:rId/health` (stub)  | member (R) + audit | 202 / 401 / 404                   |
| POST   | `/orgs/:orgId/resources/:rId/refresh` (stub) | member (R) + audit | 202 / 401 / 404                   |

### `GET /orgs/:orgId/resources?scope=&project=&variant=&kind=&isAdmin=`

Liste les Resources visibles à l'user (RLS `resources_select_member`).
Filtres optionnels — spec §6.3 :

- `scope` ∈ `{org, project}`.
- `project` (UUID, alias `project_id`).
- `variant` (slug).
- `kind` (id du `ResourceKind`).
- `isAdmin` ∈ `{true, false}`.

Réponse `{ resources: ResourceRow[] }` ordonnée par `created_at desc`.

### `POST /orgs/:orgId/resources`

Body :

```jsonc
{
  "kind": "github-org", // resolved via @crm/catalog/findKind
  "name": "acme-gh", // slug ^[a-z0-9](-?[a-z0-9])*$
  "project_id": "<uuid?>", // requis ssi kind.kindClass='project'
  "variant": "staging|prod|...|null",
  "provider_ref": "acme",
  "metadata": { "org": "acme" },
  "console_url": "https://github.com/acme",
  "setup_docs_url": "...",
  "admin_resource_id": "<uuid?>", // ssi scope='project' (spec §3.1)
  "secret_manager_id": "<uuid?>", // sinon org default
}
```

Le validateur (`packages/web/src/lib/validation/resources.ts`) reproduit
**en amont** les check constraints de migration 1000 — slug regex, scope
cohérent avec project_id, admin-only-on-project — pour surfacer un 400
propre plutôt qu'un round-trip Postgres. `is_admin` est dérivé de
`kind.kindClass` (`org-admin` ⇒ `true`, sinon `false`), comme l'exige
le check `resources_admin_is_org_scoped`.

Si l'org n'a pas de `secret_managers` row avec `is_default=true` et que
le body n'épingle pas explicitement un `secret_manager_id`, la route
renvoie `400 { error: 'no_default_secret_manager' }`. Wave-C
(`onboarding`) provisionne un default au moment de la création d'org.

Audit log : ligne `resource.registered`, `scope = { resource_id, kind,
scope }`, `subject = { name, variant }`. Le `audit_log.organization_id`
est le même que celui de la Resource (pas null comme pour
`user.crypto-key.*` du §4).

Erreurs DB mappées :

- `23505` (unique_violation sur `(org, project_id, name)`) → 409 `conflict`.
- `23514` (check_violation) → 400 `check_constraint_violation` (filet de
  sécurité si une nouvelle contrainte SQL n'est pas reflétée dans le
  validateur côté serveur).
- `42501` (insufficient_privilege RLS) → 403 `forbidden`.
- Autre → 500 `database_error`.

### `PATCH /orgs/:orgId/resources/:rId`

Mêmes garanties. Le validateur **refuse explicitement** la mutation de
`kind`, `scope`, `project_id`, `admin_resource_id`, `is_admin`,
`provider_name`, `organization_id`, `secret_manager_id` — pour changer
l'un de ceux-ci il faut détacher (DELETE) et re-register (POST).

Champs mutables : `name`, `variant`, `provider_ref`, `console_url`,
`setup_docs_url`, `metadata` (écrit dans `provider_metadata`), `status`
(énumération `pending|active|failed|detached`).

Si RLS renvoie 0 rows (PostgREST avale silencieusement) la route fait
une **seconde probe** pour différencier `404` (row absent) de `403`
(row existe mais membre, pas admin). Audit : `resource.updated`,
`subject = { fields: [...keys] }`.

### `DELETE /orgs/:orgId/resources/:rId`

`DELETE` détache la row Vauban — **ne touche pas au provider**. Spec
§6.5 réserve l'effet provider-side à `/destroy-cloud-resource` (Phase 6).
La route snapshot la row avant le delete pour pouvoir auditer
`resource.deleted` avec `subject = { name, variant }` et différencier
404 (snapshot vide) de 403 (snapshot OK mais delete sans effet).

### `POST /:rId/health` et `POST /:rId/refresh` (stubs Phase 4)

Response `202 { status: 'pending-runner' }`. Audit `resource.health.requested`
ou `resource.refresh.requested`. Le dispatch réel sur le Runner arrive
en Phase 6 quand l'integration côté CAR sera disponible.

## Garanties ZK / audit

Le handler ne stocke **jamais** de sealed_blob — c'est la responsabilité
de la feature `access-rest-api` (livrée en parallèle). Les seules
inputs sensibles ici sont les metadata du provider, qui ne contiennent
**aucune** credential (validé par les tests `accessSchema` côté catalog,
Phase 3).

Aucun service-role n'est utilisé dans le route handler — toutes les
queries portent la session de l'user et RLS fait la gating.
`packages/web/src/lib/resources/db.ts` ne touche jamais à
`SUPABASE_SERVICE_ROLE_KEY` (audit grep `service-role` doit rester vide
sur ce dossier).

## Tests

`packages/web/tests/unit/api/resources.test.ts` (17 scénarios) :

- GET : 401 sans session, 404 quand org absente, list + filtre `scope=org`.
- POST : 201 register `github-org` (audit `resource.registered` écrit),
  refus `unknown_kind`, refus `scope/project_id` mismatch (project kind
  sans project_id, org kind avec project_id), refus slug invalide
  (uppercase), `no_default_secret_manager` quand l'org n'en a pas, 403
  quand RLS denie l'insert, `is_admin=true` automatique pour
  `github-org-admin`.
- PATCH : 200 update + audit, 400 sur tentative de change `kind`.
- DELETE : 200 + audit `resource.deleted`, 404 si resource absent.
- Stubs health / refresh : 202 `pending-runner` + audit.

Le client Supabase est faké via une in-memory store dans le test (voir
`makeFakeDb()`). Les tests RLS-aware contre un vrai Supabase de test
sont planifiés dans `docs/tests/integration-tests.md` ("Resources CRUD
(phase 4) – TODO integration").

## Roadmap d'implémentation

Phase 4 du roadmap (cf. build plan `phase-4-resources-crud.json`) :

- [x] **Wave A — `resources-rest-api`** : endpoints §6.3 livrés.
- [ ] Wave A — `access-rest-api` : endpoints §6.4 (parallel feature).
- [ ] Wave B — `<SealedInput>` + pages list / detail.
- [ ] Wave C — onboarding + wizard register Resource.
