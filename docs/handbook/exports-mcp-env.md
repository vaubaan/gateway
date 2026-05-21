---
title: Exports — .env, mcp.json, cloud-resource-map
tracks:
  - 'feature/p7-mcp-config-regen'
  - 'feature/p7-exports-rest'
last_reviewed: 2026-05-21
---

# Exports — .env, mcp.json, cloud-resource-map — handbook

Documente l'implémentation effective des 3 exports CRM (spec §6.6, §6.7,
§7.5) :

- Régénération `mcp.json` (`mcp_configs` table).
- Export `.env` (sealed blobs renvoyés au browser, unseal côté client).
- Export `mcp.json` + `.env` compagnon.
- Export `cloud-resource-map.json` consommé par le CAR.

## Statut courant

Phase 7 wave A1 (MCP regen) **livrée**. Wave A2 (exports REST) +
wave B (UI) à venir dans des commits suivants — ce handbook est mis à
jour au fil de l'eau.

## MCP regenerate (spec §6.6)

### Endpoints REST

- `GET  /api/crm/v1/orgs/:orgId/mcp-configs?project=<uuid>&variant=<slug>`
  — liste les snapshots vivants (`mcp_configs`) visibles à l'utilisateur
  par RLS. Filtres optionnels `project` et `variant`. Pas de pagination
  (v1 garde 1 snapshot par scope, cf spec §14.1).
- `POST /api/crm/v1/orgs/:orgId/mcp-configs/regenerate` —
  body : `{ scope: 'org' | 'project', scopeId?: uuid, variant?: slug }`.
  Calcule l'union des Resources visibles → compose le `mcp.json` →
  UPSERT.

Routes : `packages/web/src/app/api/crm/v1/orgs/[orgId]/mcp-configs/`.

### Sélection des Resources visibles (`resolveScopedResources`)

`packages/web/src/lib/mcp/resolve-scope.ts` implémente la résolution
spec §7.5 :

- `scope='org'` : toute la table `resources` filtrée par
  `organization_id`. Si `variant` est fourni, on ajoute le filtre
  PostgREST `or(variant.eq.<v>,variant.is.null,scope.eq.org)` — les
  Resources `scope='org'` sont toujours visibles, indépendamment du
  variant.
- `scope='project'` : union de
  - `(project_id=P AND (variant=v OR variant IS NULL))`
  - `(organization_id=org(P) AND scope='org')`

L'union est faite côté JS (deux SELECTs, dedup par `id`) parce que
PostgREST n'expose pas d'`UNION` direct. La sortie est triée par
`id ASC` pour que le composer produise un snapshot byte-stable.

### `composeMcpConfig` (pure)

`packages/core/src/mcp/compose.ts` — function pure (zéro I/O, zéro
clock, zéro random). Inputs :

- `resources` : liste déjà filtrée par `resolveScopedResources`.
- `env.findKind(id)` : callback injecté par l'appelant (web) qui
  délègue à `@crm/catalog.findKind`. Décorrélation volontaire pour
  garder `@crm/core` libre d'une dépendance runtime sur le catalogue
  (la dep graph reste `web → catalog → core`).

Algo :

1. Pour chaque Resource visible, lookup `kind` via `env.findKind`.
2. Skip silencieux si `kind === undefined`, si `kind.mcpFragment` est
   absent (kinds sans intégration MCP — ex. `github-repo`), si le
   fragment retourne `null` (kind métadonnée invalide), ou si le kind
   throw (defensive).
3. Slot le fragment sous `mcpServers[<resource.name>]`. Collision sur
   le nom (deux Resources homonymes dans des projets différents lors
   d'un export org) → suffixe `-<resource.id>` (déterministe,
   loss-less).
4. Scanne `args` + `env` du fragment pour extraire les placeholders
   `${KEY}` (regex `[A-Z_][A-Z0-9_]*`). Chaque placeholder est ajouté
   au `envManifest.keys` avec `{ key, source_resource_id, source_kind }`.
   Dédup par `(rid, key)`.

Sortie : `{ mcpJson: { mcpServers: ... }, envManifest: { keys: [...] } }`.

### Idempotence

Le handler `regenerate/route.ts` :

1. Calcule le nouveau snapshot via `composeMcpConfig`.
2. Récupère l'existant via une requête `.is('project_id', null)`/`.eq`
   adaptée à NULL (les `(project_id NULL, variant NULL)` collisionnent
   avec eux-mêmes via l'index `NULLS NOT DISTINCT` de la migration
   1000).
3. Compare les snapshots via `snapshotsByteEqual` (canonical JSON :
   clés triées, valeurs récursives).
4. Si égaux → no-op : réponse `{ regenerated: false, mcp_config:
<existing>, hash }`, `generated_at` non modifié, **aucune entrée
   audit_log**.
5. Sinon → UPSERT `(org, project_id, variant)`, log `mcp_config.regenerated`
   avec `subject: { hash, resource_count, mcp_servers_count }` —
   **jamais le snapshot lui-même** (ZK : un snapshot peut contenir des
   metadata d'org ou d'admin tokens shape).

Hash = SHA-256 hex de la canonical JSON de `{ mcp_snapshot, env_snapshot }`.

### Décisions amont

- Les exports renvoient toujours des sealed_blobs ; jamais de cleartext
  servi par une route Vauban (cf. spec §6.7, §10). C'est une
  conséquence directe de l'invariant ZK formalisé dans
  `docs/decisions/crypto-libsodium-sealed-box-multi-recipient.md`.
- Le regenerate UPSERT — pas d'historique. Si l'audit a besoin de
  diff, il refait `compose` à partir des Resources actuelles vs le
  snapshot stocké (out-of-band tool, hors v1).

## Spec de référence

- `docs/spec/cloud-resource-manager.md` §1 (vision exports).
- `docs/spec/cloud-resource-manager.md` §3.1 — schéma `mcp_configs`.
- `docs/spec/cloud-resource-manager.md` §6.6 — MCPConfigs API.
- `docs/spec/cloud-resource-manager.md` §6.7 — Exports API.
- `docs/spec/cloud-resource-manager.md` §6.7.1 — schéma
  `cloud-resource-map`.
- `docs/spec/cloud-resource-manager.md` §7.5 — workflow d'export
  `.env` pour `(project, variant)`.

## Exports REST (.env / mcp / cloud-resource-map)

Les 3 endpoints suivent un pattern partagé :

1. Auth via `db.auth.getUser()` → 401 sans session.
2. Lookup org via `findOrgIdBySlugOrId` → 404 si invisible RLS.
3. Parse + valide le body via `@/lib/validation/exports`.
4. Résout les Resources visibles via
   `resolveScopedResources` (cf. section MCP regen ci-dessus).
5. Joint les `resource_access` via
   `resolveAccessBlobsForResources` (sealed_blobs uniquement).
6. Sérialise via les helpers purs dans `@/lib/exports/serialize`.
7. Audit log `resource.access.exported` (env+mcp) ou
   `cloud_resource_map.exported` — counts seulement, jamais de blob.

### `POST /exports/env`

Body : `{ scope, scopeId?, variant?, format='dotenv'|'json' }`.
Réponse : `{ format, entries: [{ key, source_resource_id,
source_resource_name, source_kind, sealed_blob, recipient_fingerprints }] }`.

Le browser :

1. Itère sur `entries`.
2. Pour chaque sealed_blob, essaie `unsealAs(blob, fp, identity)`.
3. Concat `${key}=${cleartext}` (dotenv) ou pair (json). Si unseal
   échoue → ligne placeholder `# UNAVAILABLE: <key> (request access
from admin)`.

### `POST /exports/mcp`

Body : `{ scope, scopeId?, variant? }`.
Réponse :

- `mcp_json` — résultat de `composeMcpConfig(...)`.
- `env_manifest` — manifest des placeholders `${KEY}`.
- `env_dotenv_template` — `.env-mcp` skeleton avec placeholders
  (utile pour preview UI / fallback quand aucun unseal n'est possible).
- `env_entries` — pour chaque manifest entry, le sealed_blob (`null`
  si l'Access manque côté DB).

Le browser : (i) écrit `mcp.json` comme tel ; (ii) résout
`${KEY}` → cleartext via unseal côté client puis écrit le `.env-mcp`
compagnon.

### `POST /exports/cloud-resource-map`

Body : `{}` (toujours scopé org entière).
Réponse : `{ version: 1, exported_at, organization_id, resources: [...] }`
(spec §6.7.1).

Chaque resource carrie :

- `id, scope, project_id, variant, kind, name`.
- `provider_metadata` (raw).
- `mcp_fragment` (résultat de `kind.mcpFragment(meta)`, ou `null`).
- `egress_hosts` (résultat de `kind.egressHosts(meta)`).
- `access_keys: [{ key, usage }]` où `usage` est
  `session-injectable` ssi le Runner est recipient du blob (sa
  pubkey figure dans la recipient list, lecture en clair via le
  champ public `recipients[].fp`). En Phase 7 aucun Runner n'est
  enregistré → `runnerFingerprint = null` → toujours `browser-only`.
- `secret_manager: { kind, name }` projeté depuis
  `secret_managers` via `pickSecretManagersForResources`.

**ZK strict** : la réponse ne contient AUCUN sealed_blob, ciphertext
ou cleartext — uniquement des métadonnées + une référence textuelle
au secret_manager. La query `recipients` lit le champ public de la
sealed_blob JSON (cf. spec §4.4 — la recipient list est publique).

## UI exports

À implémenter en Phase 7 wave B. Page
`/orgs/:slug/projects/:name/exports` et `/orgs/:slug/exports`. Les
boutons assemblent les bundles via le browser : POST sur les endpoints
REST ci-dessus, unseal des sealed_blobs en mémoire via
`useUserIdentity` + `unsealAs`, écriture du fichier via
`Blob + URL.createObjectURL`.
