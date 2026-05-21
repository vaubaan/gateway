---
title: Exports — .env, mcp.json, cloud-resource-map
tracks:
  - 'feature/p7-mcp-config-regen'
  - 'feature/p7-exports-rest'
  - 'feature/p7-exports-ui'
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

Phase 7 **livrée** : wave A1 (MCP regen), wave A2 (exports REST) et
wave B (UI) en place. Les 3 endpoints REST + les 4 pages/composants UI
fonctionnent contre la migration `mcp_configs` de la 1000 et la
catalogue v1.

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

Deux pages serveur (App Router) :

- `packages/web/src/app/(protected)/orgs/[slug]/exports/page.tsx` —
  org-scoped exports. Récupère l'org + les variants distincts présents
  dans les Resources de l'org, puis monte
  `<OrgExportsClient>` (client component).
- `packages/web/src/app/(protected)/orgs/[slug]/projects/[projectSlug]/exports/page.tsx`
  — project-scoped exports. Récupère la project row + ses variants
  distincts, monte `<ProjectExportsClient>`.

### Composants client

Tous sous `packages/web/src/components/exports/` :

- `<VariantSelector>` — `<select>` simple listant les variants
  - l'option vide (`(none — all variants)`).
- `<DotenvExportButton>` — POST `/exports/env`, unseal chaque blob
  via `unsealAs(blob, fp, identity)`, assemble dotenv ou JSON via
  les helpers purs dans `@/lib/exports/dotenv-assembly`, trigger
  download via `triggerBrowserDownload` (`Blob` +
  `URL.createObjectURL` + transient `<a download>`).
- `<McpExportButton>` — POST `/exports/mcp`, écrit
  `<stem>.mcp.json` directement, puis assemble + écrit
  `<stem>.env-mcp` (companion). Deux downloads back-to-back.
- `<CloudResourceMapButton>` — POST
  `/exports/cloud-resource-map`, écrit le JSON directement.
  Pas d'unseal (la réponse ne contient aucun blob).
- `<RegenerateMcpButton>` — POST `/mcp-configs/regenerate`,
  affiche `{ regenerated, hash }`. RBAC : 403 sur non-admin (RLS
  côté DB).
- `<OrgExportsClient>` / `<ProjectExportsClient>` — wrappers qui
  hold le `variant` state et passent la scope appropriée.

### Helpers purs côté browser

`packages/web/src/lib/exports/` :

- `dotenv-assembly.ts` — `assembleDotenv` / `assembleJson` /
  `assembleMcpCompanion` : itèrent les entries, appellent
  `unsealAs`, écrivent le texte ; les `Uint8Array` cleartext sont
  `.fill(0)` immédiatement après lecture UTF-8. Les blobs où
  l'user n'est pas recipient deviennent `# UNAVAILABLE: <key>
(request access from admin)` (dotenv) ou
  `"<key>": "UNAVAILABLE"` (JSON).
- `download.ts` — `triggerBrowserDownload(filename, content,
mime?)` : crée un `Blob`, `URL.createObjectURL`,
  `document.createElement('a')` avec `.download = filename`,
  click, `URL.revokeObjectURL`. Le blob URL est révoqué
  immédiatement après le click — defense in depth pour limiter
  la fenêtre de fuite côté URL store.

### ZK invariants côté UI

- Le cleartext ne vit que dans une `Uint8Array` éphémère
  retournée par `unsealAs`. La fonction décode en UTF-8, copie
  dans une string locale, puis appelle `.fill(0)` sur l'Uint8Array
  avant retour.
- Le résultat assemblé (dotenv text ou JSON string) est la copie
  finale autorisée — elle est passée à `triggerBrowserDownload`
  qui la transfère au filesystem via `Blob`. Aucune copie ne reste
  dans React state hors de la fenêtre de download.
- Le blob URL est révoqué immédiatement après le click
  (`URL.revokeObjectURL`) — defense in depth.
- Pour les blobs où l'user n'est pas recipient, `unsealAs` renvoie
  `null` ; on émet alors une ligne placeholder dans le `.env`
  (jamais d'erreur fatale qui pourrait masquer les keys
  manquantes).
