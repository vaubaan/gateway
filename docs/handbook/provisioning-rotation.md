---
title: Provisioning et Rotation — workflows browser-side
tracks:
  - supabase-admin-impl
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
| `vercel-team-admin` impl (Phase 6)                               | TODO Wave A   |
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
- **CORS assumption** : api.supabase.com supporte les requêtes
  cross-origin avec `Authorization: Bearer` (le dashboard Supabase
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
