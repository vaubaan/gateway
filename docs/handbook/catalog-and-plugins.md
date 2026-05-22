---
title: Catalogue de ResourceKinds et plugins providers
tracks:
  - packages/crm-catalog/src/resource-kind.ts
  - packages/crm-catalog/src/secret-manager.ts
  - packages/crm-catalog/src/index.ts
  - packages/crm-catalog/src/providers/github/org.ts
  - packages/crm-catalog/src/providers/github/org-admin.ts
  - packages/crm-catalog/src/providers/github/repo.ts
  - packages/crm-catalog/src/providers/github/index.ts
  - packages/crm-catalog/tests/unit/providers/github.test.ts
  - packages/crm-catalog/tests/unit/providers/github-admin.test.ts
  - packages/crm-catalog/src/providers/vercel/team.ts
  - packages/crm-catalog/src/providers/vercel/team-admin.ts
  - packages/crm-catalog/src/providers/vercel/project.ts
  - packages/crm-catalog/src/providers/vercel/index.ts
  - packages/crm-catalog/tests/unit/providers/vercel.test.ts
  - packages/crm-catalog/tests/unit/providers/vercel-admin.test.ts
  - packages/crm-catalog/src/providers/supabase-cloud/org.ts
  - packages/crm-catalog/src/providers/supabase-cloud/org-admin.ts
  - packages/crm-catalog/src/providers/supabase-cloud/project.ts
  - packages/crm-catalog/src/providers/supabase-cloud/index.ts
  - packages/crm-catalog/tests/unit/providers/supabase-cloud.test.ts
  - packages/crm-catalog/tests/unit/providers/supabase-admin.test.ts
  - packages/crm-catalog/src/registry.ts
  - packages/crm-catalog/tests/unit/registry.test.ts
  - packages/web/src/app/api/crm/v1/catalog/route.ts
  - packages/web/src/app/api/crm/v1/catalog/[kindId]/route.ts
  - packages/web/src/lib/catalog/serialize.ts
  - packages/web/tests/unit/api/catalog.test.ts
last_reviewed: 2026-05-22
---

# Catalogue de ResourceKinds et plugins providers — handbook

Document l'implémentation effective du catalogue
`@crm/catalog` : contrats `ResourceKind` / `OrgResourceAdminKind`
(spec §5.1), et les implémentations concrètes par provider (GitHub,
Vercel, Supabase).

## Statut courant

**Phase 3 complète.** Wave A (9 kinds) + wave B (registry + endpoint
REST) livrés. Le catalogue est désormais exposé en lecture publique
via `GET /api/crm/v1/catalog` + `GET /api/crm/v1/catalog/:kindId`.

- Types ResourceKind / OrgResourceAdminKind / KindClass /
  RotationMethod — livrés phase init dans
  `packages/crm-catalog/src/resource-kind.ts`.
- Provider GitHub (3 kinds) — mergé wave A.
- Provider Vercel (3 kinds) — mergé wave A.
- Provider Supabase Cloud (3 kinds) — mergé wave A.
- Registry `CATALOG` + endpoint `/api/crm/v1/catalog` — livré ici
  (wave B).
- Provider operations effectives (`createChild`, `destroyChild`,
  `rotateChildAccess`, `listChildren`) — **livrées Phase 6 Wave A**
  pour les 3 providers admin (github / vercel / supabase). Voir
  [provisioning-rotation handbook](./provisioning-rotation.md) pour
  le détail des appels HTTP et des fallbacks `*RotationNotSupportedError`.

## Décisions amont

- Le package livre des _types_ + des _métadonnées de kinds_
  (`setupDocs`, `accessSchema`, `mcpFragment`, `egressHosts`,
  `healthTestCmd`). Les **opérations** réelles sur les APIs provider
  (créer un repo, rotate un token, etc.) ne sont **pas** livrées en
  Phase 3 — elles arrivent en Phase 6. Les méthodes admin
  (`createChild` &c.) existent comme stubs qui throw
  `phase-6: <method> not implemented (<kind-id>)`.
- Les 3 `kindClass` distincts (`org`, `project`, `org-admin`) sont
  un choix de contrat figé par la spec §5.1.
- `McpServerFragment.command` est devenu **optionnel** pour absorber
  les deux flavours de serveur MCP : `stdio` (`{ command, args, env }`,
  ex: GitHub via docker, Supabase via npx) et `http` remote
  (`{ type: 'http', url }`, ex: Vercel via `https://mcp.vercel.com/`).
  Le catch-all index signature de l'interface laisse passer les
  champs MCP qu'on ne modélise pas encore (`type`, `url`, …).
- Aucun cleartext credential n'est jamais hardcodé dans les kinds :
  les `accessSchema.<KEY>` ne contiennent que **les noms** des clés
  attendues et leur description / regex. Les valeurs voyagent
  exclusivement via le bundle scellé (`SealedBlobV1`, spec §4.3 /
  §2.3).

## Spec de référence

- `docs/spec/cloud-resource-manager.md` §0.1 — rotation methods
  (`self` / `admin-mediated` / `manual`).
- `docs/spec/cloud-resource-manager.md` §5.1 — contrat
  `ResourceKind` / `OrgResourceAdminKind`.
- `docs/spec/cloud-resource-manager.md` §5.3 — layout attendu de
  `packages/crm-catalog/src/providers/<name>/`.
- `docs/spec/cloud-resource-manager.md` §6.1 — endpoint REST
  `GET /api/crm/v1/catalog` (livré wave B).

## GitHub kinds — `feature/kinds-github`

Trois kinds dans `packages/crm-catalog/src/providers/github/`,
exportés via le barrel `index.ts` :

### `github-org` (OrgResourceKind)

- Fichier : `packages/crm-catalog/src/providers/github/org.ts`.
- Rotation : `manual` — GitHub n'expose pas de rotation API pour les
  fine-grained PAT.
- AccessSchema : `{ GITHUB_TOKEN }` — fine-grained PAT **read-only**
  scopé à l'organisation. Le pattern regex (`^github_pat_…`) est
  vérifié côté wizard avant scellement.
- Metadata : `{ org: string }`. Le slug de l'org est concaténé dans
  `healthTestCmd` (`curl … /orgs/<slug>`) et dans `mcpFragment` si
  besoin.
- MCP fragment : conforme à `.mcp.json` racine — image docker
  `ghcr.io/github/github-mcp-server`, env
  `GITHUB_PERSONAL_ACCESS_TOKEN: ${GITHUB_TOKEN}`.
- Egress : `api.github.com`, `github.com`, `ghcr.io`.

### `github-org-admin` (OrgResourceAdminKind)

- Fichier : `packages/crm-catalog/src/providers/github/org-admin.ts`.
- Rotation : `manual`.
- Manages : `['github-repo']`.
- AccessSchema : `{ GITHUB_TOKEN }` — PAT **admin** issued by un org
  owner. SetupDocs détaille les scopes requis
  (`Administration: Read and write` côté repo et côté organization).
- Provider operations : **live Phase 6 Wave A**
  (`listChildren`, `createChild`, `destroyChild`, `rotateChildAccess`)
  contre `api.github.com`. Fallback `GitHubRotationNotSupportedError`
  quand le PAT n'a pas accès à `/orgs/.../personal-access-tokens`.
  Détails : [provisioning-rotation handbook](./provisioning-rotation.md#flow-github-provisioning).
- HealthTestCmd : double appel curl pour vérifier que le token a
  bien le rôle `admin` sur l'org.
- MCP fragment : identique à `github-org`.

### `github-repo` (ProjectResourceKind)

- Fichier : `packages/crm-catalog/src/providers/github/repo.ts`.
- Rotation : `admin-mediated` — la "Rotate Access" passe par le
  `github-org-admin` parent (Phase 6).
- AccessSchema : `{ GITHUB_TOKEN }` — deploy token scopé repo, **non
  saisi manuellement** : il est généré par l'admin parent lors du
  provisionnement.
- Metadata : `{ org: string, repo: string }`.
- Pas de `mcpFragment` (un seul repo n'est pas un contexte MCP utile
  ; l'exposition MCP se fait au niveau org).
- Egress : `api.github.com`, `github.com`.

## Vercel kinds — `feature/kinds-vercel`

Trois kinds dans `packages/crm-catalog/src/providers/vercel/`,
exportés via le barrel `index.ts` :

### `vercel-team` (OrgResourceKind)

- Fichier : `packages/crm-catalog/src/providers/vercel/team.ts`.
- Rotation : `manual` — pas d'API stable de rotation côté Vercel.
- AccessSchema : `{ VERCEL_TOKEN, VERCEL_TEAM_ID }`. Token
  team-scoped (regex `^[A-Za-z0-9]{24,}$`) + identifiant de team
  opaque (regex `^team_…`). Le `VERCEL_TEAM_ID` est stable across
  rotations.
- Metadata : `{ teamSlug: string }`.
- MCP fragment : variant HTTP remote
  (`{ type: 'http', url: 'https://mcp.vercel.com/' }`), conforme à
  `.mcp.json` racine. L'authentification se fait par OAuth — le
  `VERCEL_TOKEN` du Resource n'est pas utilisé par le MCP client
  lui-même, il sert uniquement aux outils HTTP/CLI qui ont besoin
  d'une auth statique.
- Egress : `api.vercel.com`, `vercel.com`, `mcp.vercel.com`.

### `vercel-team-admin` (OrgResourceAdminKind)

- Fichier : `packages/crm-catalog/src/providers/vercel/team-admin.ts`.
- Rotation : `manual`.
- Manages : `['vercel-project']`.
- AccessSchema : `{ VERCEL_TOKEN, VERCEL_TEAM_ID }` — token issued
  par un team Owner/Admin. SetupDocs détaille la vérification du
  role sur la page members de l'équipe avant de créer le token.
- Provider operations : **live Phase 6 Wave A**
  (`listChildren`, `createChild`, `destroyChild`) contre
  `api.vercel.com`. `rotateChildAccess` throw toujours
  `VercelRotationNotSupportedError` (les tokens Vercel sont team-level
  — pas d'endpoint project-scoped). Détails :
  [provisioning-rotation handbook](./provisioning-rotation.md#flow-vercel-provisioning).
- HealthTestCmd : appel API teams + check sur `membership.role`
  ∈ `{OWNER, DEVELOPER, ADMIN, BILLING}` pour confirmer la capacité
  admin.
- MCP fragment : identique à `vercel-team` (HTTP remote).

### `vercel-project` (ProjectResourceKind)

- Fichier : `packages/crm-catalog/src/providers/vercel/project.ts`.
- Rotation : `admin-mediated` — la "Rotate Access" passe par le
  `vercel-team-admin` parent (Phase 6).
- AccessSchema : `{ VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID }`.
  Le token est issu par l'admin parent, **pas saisi manuellement**.
  Regex `^prj_…` sur `VERCEL_PROJECT_ID`.
- Metadata : `{ teamSlug: string, projectSlug: string }`.
- Pas de `mcpFragment` (Vercel MCP n'a pas de notion de scope
  per-project — l'exposition se fait au niveau team).
- Egress : `api.vercel.com`, `vercel.com`.

## Supabase kinds — `feature/kinds-supabase`

Trois kinds dans `packages/crm-catalog/src/providers/supabase-cloud/`,
exportés via le barrel `index.ts`. Le `provider` côté
`ResourceKind.provider` est `supabase-cloud` (et **pas** `supabase`),
pour réserver le mot `supabase` aux futurs CloudProviders self-hosted
(Phase ≥7).

### `supabase-org` (OrgResourceKind)

- Fichier : `packages/crm-catalog/src/providers/supabase-cloud/org.ts`.
- Rotation : `manual` — Supabase Cloud n'expose pas d'API stable de
  rotation pour les PATs.
- AccessSchema : `{ SUPABASE_ACCESS_TOKEN }` — PAT user-scoped
  (regex `^sbp_…`). Le contexte org est dérivé de la membership de
  l'utilisateur côté Supabase (l'API filtre `/v1/organizations` par
  membership).
- Metadata : `{ orgSlug: string }`.
- MCP fragment : stdio via `npx -y @supabase/mcp-server-supabase`,
  conforme à `.mcp.json` racine. Le PAT voyage par
  `--access-token ${SUPABASE_ACCESS_TOKEN}` (placeholder, jamais
  hardcodé).
- Egress : `api.supabase.com`, `supabase.com`.

### `supabase-org-admin` (OrgResourceAdminKind)

- Fichier :
  `packages/crm-catalog/src/providers/supabase-cloud/org-admin.ts`.
- Rotation : `manual`.
- Manages : `['supabase-project']`.
- AccessSchema : `{ SUPABASE_ACCESS_TOKEN }` — PAT issued par un org
  Owner/Administrator. SetupDocs détaille la vérification du role sur
  la page Team de l'org avant de créer le token.
- Provider operations : **live Phase 6 Wave A** contre la Management
  API Supabase (`/v1/projects`). `rotateChildAccess` dispatch par clé :
  `SUPABASE_DB_PASSWORD` → `PATCH /v1/projects/{ref}` (génération
  CSPRNG côté browser) ; `SUPABASE_SERVICE_ROLE_KEY` /
  `SUPABASE_ANON_KEY` → throw `SupabaseRotationNotSupportedError`
  (rotation manuelle via dashboard). Détails :
  [provisioning-rotation handbook](./provisioning-rotation.md#flow-supabase-provisioning).
- HealthTestCmd : appel `/v1/organizations` + check sur `role_name`
  ∈ `{Owner, Administrator}`.
- MCP fragment : identique à `supabase-org` (npx stdio).

### `supabase-project` (ProjectResourceKind)

- Fichier :
  `packages/crm-catalog/src/providers/supabase-cloud/project.ts`.
- Rotation : `admin-mediated` — la "Rotate Access" passe par le
  `supabase-org-admin` parent (Phase 6).
- AccessSchema : `{ SUPABASE_URL, SUPABASE_ANON_KEY,
SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_PASSWORD,
SUPABASE_PROJECT_REF }`. C'est le plus large bundle du catalogue v1
  (5 clés). Les JWTs (anon, service_role) ont la regex
  `^eyJ…\\.eyJ…\\.…$`, le `project_ref` est `[a-z]{20}`.
- Metadata : `{ orgSlug: string, projectRef: string, region?: string }`.
- Pas de `mcpFragment` — le MCP Supabase est account-PAT driven, pas
  service_role driven. Le wiring MCP se fait au niveau
  `supabase-org`/`supabase-org-admin`.
- HealthTestCmd : appel `$SUPABASE_URL/rest/v1/` avec le `anon_key`
  (jamais le service_role, qui leakerait plus de capability qu'un
  healthcheck passif ne devrait exiger).
- Egress : `api.supabase.com`, `<projectRef>.supabase.co`,
  `pooler.supabase.com`.

## Registry & endpoint REST — `feature/catalog-registry-and-endpoint`

### `packages/crm-catalog/src/registry.ts`

Source unique de vérité côté `@crm/catalog`. Importe les 3 barrels
provider (`./providers/github`, `./providers/vercel`,
`./providers/supabase-cloud`) et expose deux symboles :

- `export const CATALOG: readonly ResourceKind[]` — frozen array de
  9 entrées, ordonné par provider (github → vercel → supabase-cloud)
  puis par kindClass (`org` → `org-admin` → `project`).
- `export function findKind(id: string): ResourceKind | undefined` —
  lookup par id ; retourne `undefined` si le kind est inconnu
  (callers gèrent le 404).

Le barrel racine `packages/crm-catalog/src/index.ts` re-exporte
`CATALOG` + `findKind` à côté des types.

### Endpoint REST `GET /api/crm/v1/catalog`

Deux routes Next.js (App Router) :

- `packages/web/src/app/api/crm/v1/catalog/route.ts` — list. Retourne
  `{ kinds: SerializedKind[] }` (9 entrées).
- `packages/web/src/app/api/crm/v1/catalog/[kindId]/route.ts` — by-id.
  Retourne `{ kind: SerializedKind }` ou 404 + `{ error:
'unknown_kind', kindId }` si l'id est inconnu.

Les deux endpoints sont :

- **Public-ish** : pas d'auth (le catalogue est build-time metadata,
  identique pour toutes les orgs).
- **Static** : `export const dynamic = 'force-static'`.
- **Cacheables** : `Cache-Control: public, max-age=60,
stale-while-revalidate=60` (CDN + browser).

### Serialiseur `packages/web/src/lib/catalog/serialize.ts`

Une fonction `serializeKind(k: ResourceKind): SerializedKind` qui
filtre les champs **non-sérialisables** :

- **gardés** : `id`, `provider`, `kindClass`, `displayName`,
  `setupDocs`, `accessSchema`, `rotationMethod`, `egressHosts`
  (évalué avec `{}`), `manages` (uniquement pour les org-admin).
- **retirés** : `healthTestCmd`, `mcpFragment`, `rotateSelf`,
  `listChildren`, `createChild`, `destroyChild`,
  `rotateChildAccess`, `metadataSchema`.

Le wire format reste **statique** : `egressHosts` est appelé avec un
metadata vide. Les hosts dérivés de la metadata d'une Resource
concrète (ex: `<projectRef>.supabase.co`) sont calculés au runtime
par la Resource, pas par le catalogue.

### Tests structurels

`packages/crm-catalog/tests/unit/registry.test.ts` enforce les
invariants spec §12.4 + les contraintes du build plan :

- 9 kinds, ids uniques, `CATALOG` frozen.
- `kindClass` ∈ `{org, project, org-admin}`,
  `rotationMethod` ∈ `{self, admin-mediated, manual}`.
- Tout `org-admin` déclare un `manages` non-vide, et chaque id de
  `manages` résout vers un kind `kindClass='project'`.
- Tout `org` est `rotationMethod='manual'` (spec §0.1 : pas
  d'admin "au-dessus" de l'org).
- Tout `id` matche `/^[a-z][a-z0-9-]*$/`.
- Tout `provider` ∈ `{github, vercel, supabase-cloud}` (v1
  allowlist).
- Toute `setupDocs` ≥ 100 chars.
- `findKind` retourne `undefined` pour un id inconnu et un pointeur
  référentiellement identique pour deux lookups consécutifs.

`packages/web/tests/unit/api/catalog.test.ts` exerce les handlers
Next.js directement : 9 entrées sur list, ids exacts, 404 sur
unknown_kind, absence des fonctions sur le wire, header
`Cache-Control` public.

## Tests

- Unit GitHub :
  `packages/crm-catalog/tests/unit/providers/github.test.ts` — ~25
  assertions sur les 3 kinds (contrat, accessSchema, regex, shape
  `mcpFragment`, `egressHosts`, refus de metadata malformée, stubs
  phase-6).
- Unit Vercel :
  `packages/crm-catalog/tests/unit/providers/vercel.test.ts` — ~25
  assertions sur les 3 kinds Vercel (contrat, accessSchema, regex
  `team_…` / `prj_…`, shape `mcpFragment` HTTP-remote,
  `egressHosts`, refus de metadata malformée, stubs phase-6).
- Unit Supabase Cloud :
  `packages/crm-catalog/tests/unit/providers/supabase-cloud.test.ts`
  — ~25 assertions sur les 3 kinds Supabase (contrat, accessSchema
  des 5 clés du `supabase-project`, regex `sbp_…` / `eyJ…` / project
  ref `[a-z]{20}`, shape `mcpFragment` stdio npx, `egressHosts`
  incluant le hostname du projet, healthTestCmd qui n'utilise jamais
  `$SUPABASE_SERVICE_ROLE_KEY`, refus de metadata malformée, stubs
  phase-6).
- Unit registry : `packages/crm-catalog/tests/unit/registry.test.ts`
  — 15 assertions structurelles (spec §12.4 + v1 allowlist) sur la
  forme globale du `CATALOG` + helper `findKind`.
- Unit endpoint : `packages/web/tests/unit/api/catalog.test.ts` — 10
  assertions sur la list (9 entrées, wire format, Cache-Control) et
  le by-id (200 sur known, 404 + `unknown_kind` sur missing,
  absence des fonctions sur le wire).
- Integration / E2E : pas applicable en Phase 3 (pas d'appel API
  provider réel). Phase 6 livrera les E2E sur les opérations admin.

## Garanties cryptographiques

Aucun cleartext credential n'apparaît dans le code du catalogue. Les
valeurs des tokens sont **toujours** transportées par le bundle
scellé (`SealedBlobV1`, spec §4.3), jamais hardcodées dans un
`setupDocs`, `accessSchema.description`, `mcpFragment.env`, ni un
quelconque template du package. Les tests unit vérifient ce point
sur chaque kind (`expect(...).not.toMatch(/^github_pat_/)`, etc.).
