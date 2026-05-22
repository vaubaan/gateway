---
title: Audit log — schéma, mutations, lecture, rétention
tracks:
  - supabase/migrations/1000_provider_resource_manager.sql
  - supabase/migrations/1001_audit_log_org_nullable.sql
  - packages/web/src/app/api/crm/v1/me/crypto-key/route.ts
  - packages/web/src/app/api/crm/v1/orgs/route.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/resources/route.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/resources/[rId]/route.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/resources/[rId]/health/route.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/resources/[rId]/refresh/route.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/resources/[rId]/provision/route.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/resources/[rId]/destroy-cloud-resource/route.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/resources/[rId]/access/[key]/route.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/resources/[rId]/access/[key]/rotate/route.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/secret-managers/route.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/secret-managers/[smId]/route.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/mcp-configs/regenerate/route.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/exports/env/route.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/exports/mcp/route.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/exports/cloud-resource-map/route.ts
last_reviewed: 2026-05-22
---

# Audit log — handbook

Documente l'implémentation effective de la table `public.audit_log`
(spec §3.1, §9), son alimentation (toute mutation CRM doit y écrire),
sa lecture (members de l'org), et sa rétention.

## Statut courant

**Implémenté.** La table existe (migration 1000) avec la patch
`organization_id NULLABLE` (migration 1001) pour permettre de logger
des actions hors-org (e.g. `crypto.identity.*`). 19 sites d'écriture
existent à travers les routes REST CRM v1.

Pas encore livré :

- **Helper centralisé** `appendAudit()` — chaque route fait son
  `db.from('audit_log').insert({...})` directement (pattern dupliqué).
  Centraliser dans `@/lib/audit-log/append.ts` est un refactor noté
  pour Phase ≥8.
- **Page UI** `/orgs/:slug/audit?subject=cloud-resource-manager` (spec
  §11.1) — non livrée. Lecture humaine se fait via psql / Supabase
  Studio en attendant.
- **Purge** — aucune rétention en place (spec §9 : "purge à faire
  ultérieurement").

## Schéma

Table `public.audit_log` (migration 1000 + patch 1001) :

| Colonne           | Type                                  | Notes                                                                                                                 |
| ----------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `id`              | `uuid` PK default `gen_random_uuid()` |                                                                                                                       |
| `organization_id` | `uuid` **nullable** (1001)            | FK `organizations.id`. NULL pour les actions hors-org (`crypto.identity.*`).                                          |
| `actor_user_id`   | `uuid`                                | FK `auth.users.id`. Toujours présent (les inserts service-role sans actor sont interdits par convention applicative). |
| `action`          | `text`                                | Identifiant canonique (cf. inventaire ci-dessous).                                                                    |
| `scope`           | `text`                                | Catégorie large (`org`, `resource`, `secret_manager`, `mcp_config`, `export`, `identity`).                            |
| `subject`         | `jsonb`                               | Payload JSON sans cleartext — counts, ids, hashes, refs.                                                              |
| `at`              | `timestamptz` default `now()`         |                                                                                                                       |

Indices : `audit_log_org_at_idx (organization_id, at DESC)` + `audit_log_action_idx (action)`.

### RLS

- `audit_log_select_member` — lecture autorisée pour tout member de
  l'org (`organization_id IN ( ... org_members WHERE user_id = auth.uid())`).
- **Aucune policy `INSERT/UPDATE/DELETE`** — toutes les écritures
  passent obligatoirement par `service-role` côté server (les routes
  REST). C'est l'inverse exact du pattern RLS classique, et c'est
  délibéré (spec §10 : audit immuable côté client).

### Décisions amont

- Le client (browser) ne peut **pas** écrire dans `audit_log` —
  uniquement le serveur via service-role (spec §10).
- Conservation indéfinie en v1 (spec §9). À reconsidérer si la table
  dépasse ~10M rows.

## Inventaire des actions

Actions effectivement émises par le code v1 (17 distinctes, scope
indicatif) :

| Scope                 | Action                                                | Émetteur                                                                  |
| --------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------- |
| `org`                 | `org.created`                                         | `POST /api/crm/v1/orgs`                                                   |
| `resource`            | `resource.registered`                                 | `POST /api/crm/v1/orgs/:orgId/resources`                                  |
| `resource`            | `resource.updated`                                    | `PATCH /api/crm/v1/orgs/:orgId/resources/:rId`                            |
| `resource`            | `resource.deleted`                                    | `DELETE /api/crm/v1/orgs/:orgId/resources/:rId`                           |
| `resource`            | `resource.health.checked`                             | `POST /api/crm/v1/orgs/:orgId/resources/:rId/health`                      |
| `resource`            | `resource.refresh.requested`                          | `POST /api/crm/v1/orgs/:orgId/resources/:rId/refresh`                     |
| `resource`            | `resource.provisioned`                                | `POST /api/crm/v1/orgs/:orgId/resources/:rId/provision`                   |
| `resource`            | `resource.destroyed-cloud-side`                       | `DELETE /api/crm/v1/orgs/:orgId/resources/:rId/destroy-cloud-resource`    |
| `resource.access`     | `resource.access.put`                                 | `PUT /api/crm/v1/orgs/:orgId/resources/:rId/access/:key`                  |
| `resource.access`     | `resource.access.deleted`                             | `DELETE /api/crm/v1/orgs/:orgId/resources/:rId/access/:key`               |
| `resource.access`     | `resource.access.rotate.requested`                    | `POST /api/crm/v1/orgs/:orgId/resources/:rId/access/:key/rotate`          |
| `resource.access`     | `resource.access.exported`                            | `POST /api/crm/v1/orgs/:orgId/exports/env` + `/exports/mcp`               |
| `secret_manager`      | `secret_manager.created`                              | `POST /api/crm/v1/orgs/:orgId/secret-managers`                            |
| `secret_manager`      | `secret_manager.updated`                              | `PATCH /api/crm/v1/orgs/:orgId/secret-managers/:smId`                     |
| `secret_manager`      | `secret_manager.deleted`                              | `DELETE /api/crm/v1/orgs/:orgId/secret-managers/:smId`                    |
| `mcp_config`          | `mcp_config.regenerated`                              | `POST /api/crm/v1/orgs/:orgId/mcp-configs/regenerate` (seulement si diff) |
| `export`              | `cloud_resource_map.exported`                         | `POST /api/crm/v1/orgs/:orgId/exports/cloud-resource-map`                 |
| `identity` (org NULL) | `crypto.identity.created` / `crypto.identity.rotated` | `POST/PATCH /api/crm/v1/me/crypto-key`                                    |

Actions encore à logger (référence — non émises par v1) :

- `resource.access.read` (chaque get effectif côté UI/Runner) — Phase
  ≥8, dépend du runtime Runner.

## Pattern d'écriture

Chaque insert suit la même shape :

```ts
await db.from('audit_log').insert({
  organization_id: orgId, // ou null pour les actions identity
  actor_user_id: session.user.id,
  action: '<canonical-action>',
  scope: '<scope>',
  subject: {
    /* counts, ids, hashes — JAMAIS de cleartext ni sealed_blob */
  },
});
```

Failure mode : si l'insert échoue (rare — DB indispo, RLS bug), un
`console.warn` est émis mais la réponse REST réussit quand même. Le
choix délibéré (spec §9 : "audit best-effort en v1, ne doit pas
bloquer la mutation business").

## ZK invariants sur le `subject`

Le `subject` JSON ne doit contenir **aucun** cleartext secret ni
sealed_blob (spec §10 — "no cleartext logs"). Patterns autorisés :

- Counts (`resource_count`, `mcp_servers_count`).
- IDs opaques (`resource_id`, `admin_resource_id`).
- Hashes (`hash: <sha256-hex>` pour snapshots MCP).
- Refs publiques (`provider_ref`, `child_provider_ref`,
  `rotation_method`).
- Fingerprints publics (`fp` recipient — c'est la pubkey hashée, déjà
  publique côté table `users`).

## Lecture

V1 — pas de page UI. Lecture via psql :

```sh
psql "$DATABASE_URL" -c "
  SELECT at, action, actor_user_id, subject
  FROM audit_log
  WHERE organization_id = '<uuid>'
  ORDER BY at DESC LIMIT 100;
"
```

Pour exploration cross-org (debug ops) : Supabase Studio en
service-role.

## Spec de référence

- `docs/spec/cloud-resource-manager.md` §3.1 — schéma table.
- `docs/spec/cloud-resource-manager.md` §9 — actions canoniques et
  format JSON de l'entrée.
- `docs/spec/cloud-resource-manager.md` §10 — "no cleartext logs".
- `docs/spec/cloud-resource-manager.md` §11.1 — page UI audit (non
  livrée v1).

## Roadmap résiduelle

- Centralisation `appendAudit()` helper (DRY) — Phase ≥8.
- Page UI `/orgs/:slug/audit?subject=cloud-resource-manager` — Phase
  ≥8 (besoin émergent : pas d'urgence tant que la lecture psql suffit
  aux ops).
- Action `resource.access.read` côté Runner — dépend du runtime
  Runner (Phase ≥9).
- Politique de rétention / purge — Phase ≥10 quand la volumétrie le
  justifie.
