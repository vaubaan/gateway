---
title: Provisioning et Rotation — workflows browser-side
tracks:
  - github-admin-impl
  - vercel-admin-impl
  - supabase-admin-impl
last_reviewed: 2026-05-21
---

# Provisioning et Rotation — handbook

Document l'implémentation effective des workflows de provisioning
(via un Admin) et de rotation (3 paths : `self`, `admin-mediated`,
`manual`). Spec §0.1, §6.5, §7.3, §7.4.

## Statut courant (Phase 6, Wave A — done)

| Composant                                                        | État          |
| ---------------------------------------------------------------- | ------------- |
| Contrat TS `OrgResourceAdminKind` (Phase 3)                      | done          |
| `github-org-admin` impl (Phase 6)                                | done (Wave A) |
| `vercel-team-admin` impl (Phase 6)                               | done (Wave A) |
| `supabase-org-admin` impl (Phase 6)                              | done (Wave A) |
| REST `/provision`, `/destroy-cloud-resource`, `/rotate` dispatch | TODO Wave B   |
| Trigger SQL `recipients_stale` on org_members change             | TODO Wave B   |
| `PUT /access/:key` reset `recipients_stale=false`                | TODO Wave B   |
| UI Wizard `+ Provision via …` + `Rotate` button                  | TODO Wave C   |

## Principes ZK (spec §4)

Toutes les opérations admin (`createChild`, `destroyChild`,
`rotateChildAccess`) tournent **côté browser** avec les creds
unsealed transitorily. Core ne voit jamais les creds.

Le pattern :

1. Browser unseal admin token (`SealedReveal` + `useUserIdentity`).
2. Browser appelle directement l'API du provider via `fetch`
   (api.github.com, api.vercel.com, api.supabase.com supportent
   CORS pour les Bearer tokens).
3. Browser POST à Core **uniquement** pour enregistrer la nouvelle
   row + audit (sans cred cleartext).
4. Browser PUT le sealed_blob via `/access/:key`.

## Flow GitHub provisioning

`github-org-admin` → `github-repo` (spec §5.3).

### `listChildren(access)`

`GET https://api.github.com/orgs/{org}/repos?per_page=100&type=all`.
Paginé via `Link: rel="next"`. L'org login est fourni au runtime via
`access.GITHUB_ORG` (le wrapper packages/web le set depuis
`resource.provider_metadata.org`).

Retourne `ProviderChild[]` avec `providerRef='owner/repo'` et
`metadata: { default_branch, private, archived, html_url, id }`.

### `createChild(access, spec)`

`POST https://api.github.com/orgs/{org}/repos` avec
`{ name, private, description, auto_init: true }`.

- 201 → `ProviderChild` retourné.
- 422 → conflit (le nom existe déjà) — thrown `Error`.
- 4xx/5xx → thrown `Error` avec body GitHub tronqué.

### `destroyChild(access, providerRef)`

`DELETE https://api.github.com/repos/{owner}/{repo}`. **Idempotent** :
404 et 204 sont des succès.

### `rotateChildAccess(access, childProviderRef, 'GITHUB_TOKEN')`

Tente `POST /orgs/{org}/personal-access-tokens` (endpoint d'issuance
de fine-grained PATs). Cet endpoint est App-only sur la plupart des
orgs ; les PATs reçoivent 403.

**Fallback :** `GitHubRotationNotSupportedError` (exporté depuis
`@crm/catalog`) avec un `setupDocs` markdown. L'UI Wave C lit
`error.setupDocs` et bascule sur le flux "paste manuel".

```ts
import { GitHubRotationNotSupportedError } from '@crm/catalog';

try {
  newToken = await githubOrgAdmin.rotateChildAccess(adminAccess, 'vauban/repo1', 'GITHUB_TOKEN');
} catch (err) {
  if (err instanceof GitHubRotationNotSupportedError) {
    // Show err.setupDocs and prompt for SealedInput
  } else throw err;
}
```

## Flow Vercel provisioning

`vercel-team-admin` → `vercel-project` (spec §5.3).

### `listChildren(access)`

`GET https://api.vercel.com/v9/projects?teamId={teamId}&limit=100`.
Paginé via le curseur `pagination.next` retourné dans le body. Le
team id est lu sur `access.VERCEL_TEAM_ID` (le sealed bundle de
l'admin l'inclut déjà — pas de routage spécial).

Retourne `ProviderChild[]` avec `providerRef=projectId` (`prj_...`)
et `metadata: { framework, rootDirectory, createdAt, accountId }`.

### `createChild(access, spec)`

`POST https://api.vercel.com/v10/projects?teamId={teamId}` avec
`{ name, framework?, rootDirectory?, gitRepository? }`.

- 201 → `ProviderChild` retourné.
- 409 → conflit (le nom existe déjà sur la team).
- 4xx/5xx → thrown `Error` avec body Vercel tronqué.

Note : Vercel renvoie immédiatement le projet créé, les deployments
suivent un autre cycle de vie indépendant.

### `destroyChild(access, providerRef)`

`DELETE https://api.vercel.com/v9/projects/{projectId}?teamId={teamId}`.
**Idempotent** : 404 et 204 sont des succès.

### `rotateChildAccess(access, childProviderRef, accessKey)`

**Toujours throw `VercelRotationNotSupportedError`.** Vercel ne
propose pas d'endpoint pour mint un token _project-scoped_ — les
tokens sont team-level, donc rotater le token d'un projet revient à
rotater le token de la team (impossible à scoper).

Le caller (UI Wave C) lit `err.setupDocs` et propose un flux de
paste manuel :

```ts
import { VercelRotationNotSupportedError } from '@crm/catalog';

try {
  newToken = await vercelTeamAdmin.rotateChildAccess(adminAccess, 'prj_x', 'VERCEL_TOKEN');
} catch (err) {
  if (err instanceof VercelRotationNotSupportedError) {
    // Show err.setupDocs and prompt for SealedInput
  } else throw err;
}
```

## Flow Supabase provisioning

`supabase-org-admin` → `supabase-project` (spec §5.3).

### `listChildren(access)`

`GET https://api.supabase.com/v1/projects`. La Management API ne
permet pas de filtrer par org côté serveur : on filtre côté browser
sur `p.organization_id === access.SUPABASE_ORG_ID` quand cet ID est
présent. Si absent, on renvoie tout ce que le PAT voit.

Retourne `ProviderChild[]` avec `providerRef=projectRef` (20 chars
lowercase, ex `abcdefghijklmnopqrst`) et `metadata: { organization_id, region, status, created_at, database_host, database_version }`.

### `createChild(access, spec)`

`POST https://api.supabase.com/v1/projects` avec
`{ name, region, db_pass, organization_id, plan? }`.

- 201 → `ProviderChild` retourné avec `status='PROVISIONING'` la
  plupart du temps. La UI Wave C affiche un badge "Provisioning"
  jusqu'à ce qu'un poll sur `GET /v1/projects/{ref}` voie
  `ACTIVE_HEALTHY`.
- 409 → conflit (le nom existe déjà sur l'org).
- 4xx/5xx → thrown `Error` avec body Supabase tronqué.

### `destroyChild(access, providerRef)`

`DELETE https://api.supabase.com/v1/projects/{ref}`. **Idempotent** :
404 et 204 sont des succès. Note : Supabase fait du soft-delete ; le
ref reste réservé ~90 jours après la suppression.

### `rotateChildAccess(access, childProviderRef, accessKey)`

Dispatch par clé :

- `SUPABASE_DB_PASSWORD` → `PATCH /v1/projects/{ref}` avec
  `{ db_pass: <new> }`. Le nouveau password est généré
  côté browser (`crypto.getRandomValues`, 32 chars alphanumeric) et
  retourné cleartext. Le browser seal immédiatement, puis PUT
  `/access/:key`.
- `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_ANON_KEY` → **throw
  `SupabaseRotationNotSupportedError`**. La Management API ne propose
  pas d'endpoint pour rotater les JWT signing keys (cf. issue
  ouverte côté Supabase). Le fallback est manuel via dashboard
  (`Settings → API → Reset all API keys`). L'UI lit
  `err.setupDocs` et bascule sur SealedInput.
- Autre clé → idem `SupabaseRotationNotSupportedError`.

```ts
import { SupabaseRotationNotSupportedError } from '@crm/catalog';

try {
  newPw = await supabaseOrgAdmin.rotateChildAccess(
    adminAccess,
    'abcdefghijklmnopqrst',
    'SUPABASE_DB_PASSWORD',
  );
} catch (err) {
  if (err instanceof SupabaseRotationNotSupportedError) {
    // Show err.setupDocs and prompt for SealedInput
  } else throw err;
}
```

## Décisions amont

- "Vauban Core ne touche jamais aux APIs Provider qui demandent
  des creds" (spec §5.1, §7) — implémentation browser-only.
- Les Accesses d'`OrgResourceAdmin` ne sont jamais sealed pour le
  Runner (convention §4.4) — c'est le gate qui empêche un cred
  admin-tier d'arriver en env var dans une Coding Session.
- **CORS assumption** : api.github.com, api.vercel.com et
  api.supabase.com supportent les requêtes cross-origin avec
  `Authorization: Bearer` (les dashboards officiels eux-mêmes tapent
  directement sur leurs APIs depuis le browser). Si le runtime prouve
  le contraire (rare — possible sur enterprise GitHub), le fallback
  est de router via un proxy server-side **non implémenté** en Phase 6.

## Spec de référence

- `docs/spec/cloud-resource-manager.md` §0.1 — 3 rotation paths.
- `docs/spec/cloud-resource-manager.md` §5.1 — contrat
  `OrgResourceAdminKind`.
- `docs/spec/cloud-resource-manager.md` §6.5 — endpoints
  provisioning.
- `docs/spec/cloud-resource-manager.md` §7.3 — workflow
  provisioning.
- `docs/spec/cloud-resource-manager.md` §7.4 — workflow rotation.

## Roadmap d'implémentation

Phase 6 (build plan `.claude/build-plans/phase-6-provisioning-rotation.json`) :

- **Wave A** (done) — impl des 3 providers admin (`github`,
  `vercel`, `supabase-cloud`).
- **Wave B** (suivante) — REST endpoints + migration trigger SQL.
- **Wave C** (suivante) — UI wizard + boutons.
