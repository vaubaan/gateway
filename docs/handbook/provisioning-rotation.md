---
title: Provisioning et Rotation — workflows browser-side
tracks:
  - vercel-admin-impl
last_reviewed: 2026-05-21
---

# Provisioning et Rotation — handbook

Document l'implémentation effective des workflows de provisioning
(via un Admin) et de rotation (3 paths : `self`, `admin-mediated`,
`manual`). Spec §0.1, §6.5, §7.3, §7.4.

## Statut courant (Phase 6, Wave A — partial)

| Composant                                                        | État          |
| ---------------------------------------------------------------- | ------------- |
| Contrat TS `OrgResourceAdminKind` (Phase 3)                      | done          |
| `github-org-admin` impl (Phase 6)                                | TODO Wave A   |
| `vercel-team-admin` impl (Phase 6)                               | done (Wave A) |
| `supabase-org-admin` impl (Phase 6)                              | TODO Wave A   |
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

## Décisions amont

- "Vauban Core ne touche jamais aux APIs Provider qui demandent
  des creds" (spec §5.1, §7) — implémentation browser-only.
- Les Accesses d'`OrgResourceAdmin` ne sont jamais sealed pour le
  Runner (convention §4.4) — c'est le gate qui empêche un cred
  admin-tier d'arriver en env var dans une Coding Session.
- **CORS assumption** : api.vercel.com supporte les requêtes
  cross-origin avec `Authorization: Bearer` (le dashboard Vercel
  lui-même tape directement sur l'API depuis le browser). Si le
  runtime prouve le contraire, le fallback est de router via un
  proxy server-side **non implémenté** en Phase 6.

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

- **Wave A** (en cours) — impl des 3 providers admin (`github`,
  `vercel`, `supabase-cloud`).
- **Wave B** (suivante) — REST endpoints + migration trigger SQL.
- **Wave C** (suivante) — UI wizard + boutons.
