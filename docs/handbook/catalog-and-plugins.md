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
  - packages/crm-catalog/src/providers/vercel/team.ts
  - packages/crm-catalog/src/providers/vercel/team-admin.ts
  - packages/crm-catalog/src/providers/vercel/project.ts
  - packages/crm-catalog/src/providers/vercel/index.ts
  - packages/crm-catalog/tests/unit/providers/vercel.test.ts
last_reviewed: 2026-05-21
---

# Catalogue de ResourceKinds et plugins providers — handbook

Document l'implémentation effective du catalogue
`@crm/catalog` : contrats `ResourceKind` / `OrgResourceAdminKind`
(spec §5.1), et les implémentations concrètes par provider (GitHub,
Vercel, Supabase).

## Statut courant

**Phase 3 wave A en cours.** GitHub livré dans `feature/kinds-github`
(mergé). Vercel livré dans `feature/kinds-vercel` (cette feature).
Supabase livré en parallèle (`feature/kinds-supabase`). Registry
global `CATALOG` + endpoint REST `GET /api/crm/v1/catalog` à venir
en wave B (`feature/catalog-registry-and-endpoint`).

- Types ResourceKind / OrgResourceAdminKind / KindClass /
  RotationMethod — livrés phase init dans
  `packages/crm-catalog/src/resource-kind.ts`.
- Provider GitHub (3 kinds) — mergé.
- Provider Vercel (3 kinds) — livré ici.
- Provider Supabase — feature parallèle wave A.
- Registry `CATALOG` + endpoint `/api/crm/v1/catalog` — wave B.
- Provider operations effectives (`createChild`,
  `rotateChildAccess`, `listChildren`) — Phase 6 (provisioning).

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
- Provider operations : **stubs Phase 6** qui throw
  `phase-6: <method> not implemented (github-org-admin)`. La shape de
  l'interface est verrouillée mais les appels HTTPS sur l'API GitHub
  arriveront dans la feature `provision-via-admin` (Phase 6).
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
- Provider operations : **stubs Phase 6** qui rejettent avec le
  marker `phase-6: <method> not implemented (vercel-team-admin)`.
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

## Supabase kinds

À livrer dans `feature/kinds-supabase` (en parallèle de cette
feature).

## Registry & endpoint REST

À livrer dans `feature/catalog-registry-and-endpoint` (Phase 3 wave
B, après merge des 3 features de wave A).

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
- Integration / E2E : pas applicable en Phase 3 (pas d'appel API
  provider réel). Phase 6 livrera les E2E sur les opérations admin.

## Garanties cryptographiques

Aucun cleartext credential n'apparaît dans le code du catalogue. Les
valeurs des tokens sont **toujours** transportées par le bundle
scellé (`SealedBlobV1`, spec §4.3), jamais hardcodées dans un
`setupDocs`, `accessSchema.description`, `mcpFragment.env`, ni un
quelconque template du package. Les tests unit vérifient ce point
sur chaque kind (`expect(...).not.toMatch(/^github_pat_/)`, etc.).
