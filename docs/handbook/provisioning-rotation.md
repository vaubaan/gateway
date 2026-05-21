---
title: Provisioning et Rotation — workflows browser-side
tracks:
  - github-admin-impl
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
| `github-org-admin` impl (Phase 6)                                | done (Wave A) |
| `vercel-team-admin` impl (Phase 6)                               | TODO Wave A   |
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

### Flow Vercel provisioning

TODO Wave A (vercel-team-admin).

### Flow Supabase provisioning

TODO Wave A (supabase-org-admin).

## Décisions amont

- "Vauban Core ne touche jamais aux APIs Provider qui demandent
  des creds" (spec §5.1, §7) — implémentation browser-only.
- Les Accesses d'`OrgResourceAdmin` ne sont jamais sealed pour le
  Runner (convention §4.4) — c'est le gate qui empêche un cred
  admin-tier d'arriver en env var dans une Coding Session.
- **CORS assumption** : api.github.com supporte les requêtes
  cross-origin avec `Authorization: Bearer` depuis n'importe quelle
  origine HTTPS (vérifié manuellement). Si le runtime prouve le
  contraire (rare — possible sur enterprise), le fallback est de
  router via un proxy server-side **non implémenté** en Phase 6.

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
