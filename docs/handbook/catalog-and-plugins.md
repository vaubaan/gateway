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
last_reviewed: 2026-05-21
---

# Catalogue de ResourceKinds et plugins providers — handbook

Document l'implémentation effective du catalogue
`@crm/catalog` : contrats `ResourceKind` / `OrgResourceAdminKind`
(spec §5.1), et les implémentations concrètes par provider (GitHub,
Vercel, Supabase).

## Statut courant

**Phase 3 wave A en cours.** GitHub livré dans cette feature
(`feature/kinds-github`). Vercel et Supabase livrés en parallèle
(`feature/kinds-vercel`, `feature/kinds-supabase`). Registry global
`CATALOG` + endpoint REST `GET /api/crm/v1/catalog` à venir en
wave B (`feature/catalog-registry-and-endpoint`).

- Types ResourceKind / OrgResourceAdminKind / KindClass /
  RotationMethod — livrés phase init dans
  `packages/crm-catalog/src/resource-kind.ts`.
- Provider GitHub (3 kinds) — livré ici.
- Provider Vercel, Provider Supabase — features parallèles wave A.
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

## Vercel kinds

À livrer dans `feature/kinds-vercel` (en parallèle de cette feature).

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
- Integration / E2E : pas applicable en Phase 3 (pas d'appel API
  GitHub réel). Phase 6 livrera les E2E sur les opérations admin.

## Garanties cryptographiques

Aucun cleartext credential n'apparaît dans le code du catalogue. Les
valeurs des tokens sont **toujours** transportées par le bundle
scellé (`SealedBlobV1`, spec §4.3), jamais hardcodées dans un
`setupDocs`, `accessSchema.description`, `mcpFragment.env`, ni un
quelconque template du package. Les tests unit vérifient ce point
sur chaque kind (`expect(...).not.toMatch(/^github_pat_/)`, etc.).
