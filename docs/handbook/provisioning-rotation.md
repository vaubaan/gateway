---
title: Provisioning et Rotation — workflows browser-side
tracks:
  - packages/crm-catalog/src/providers/github/org-admin.ts
  - packages/crm-catalog/src/providers/vercel/team-admin.ts
  - packages/crm-catalog/src/providers/supabase-cloud/org-admin.ts
  - packages/crm-catalog/tests/unit/providers/github-admin.test.ts
  - packages/crm-catalog/tests/unit/providers/vercel-admin.test.ts
  - packages/crm-catalog/tests/unit/providers/supabase-admin.test.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/resources/[rId]/provision/route.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/resources/[rId]/destroy-cloud-resource/route.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/resources/[rId]/access/[key]/rotate/route.ts
  - packages/web/src/lib/validation/provision.ts
  - packages/web/src/app/(protected)/orgs/[slug]/resources/provision/page.tsx
  - packages/web/src/components/wizard/ProvisionLauncher.tsx
  - packages/web/src/components/wizard/ProvisionWizard.tsx
  - packages/web/src/components/resources/RotateAccessButton.tsx
  - packages/web/src/components/resources/DestroyCloudResourceButton.tsx
  - packages/web/tests/unit/api/provision.test.ts
  - packages/web/tests/unit/api/rotate-dispatch.test.ts
  - packages/web/tests/unit/components/provision-wizard.test.tsx
  - packages/web/tests/unit/components/rotate-button.test.tsx
  - supabase/migrations/1003_recipients_stale_on_membership.sql
last_reviewed: 2026-05-22
---

# Provisioning et Rotation — handbook

Document l'implémentation effective des workflows de provisioning
(via un Admin) et de rotation (3 paths : `self`, `admin-mediated`,
`manual`). Spec §0.1, §6.5, §7.3, §7.4.

## Statut courant (Phase 6 — done)

| Composant                                                        | État          |
| ---------------------------------------------------------------- | ------------- |
| Contrat TS `OrgResourceAdminKind` (Phase 3)                      | done          |
| `github-org-admin` impl (Phase 6)                                | done (Wave A) |
| `vercel-team-admin` impl (Phase 6)                               | done (Wave A) |
| `supabase-org-admin` impl (Phase 6)                              | done (Wave A) |
| REST `/provision`, `/destroy-cloud-resource`, `/rotate` dispatch | done (Wave B) |
| Trigger SQL `recipients_stale` on org_members change             | done (Wave B) |
| `PUT /access/:key` reset `recipients_stale=false`                | done (Wave B) |
| UI `<ProvisionWizard>` + `+ Provision via …` launcher            | done (Wave C) |
| UI `<RotateAccessButton>` per access key (3 paths)               | done (Wave C) |
| UI `<DestroyCloudResourceButton>` type-name confirm              | done (Wave C) |

## REST endpoints (Phase 6 Wave B)

### `POST /api/crm/v1/orgs/:orgId/resources/:rId/provision`

(`:rId` est l'admin parent ; convention de nommage Next.js homogène
avec les autres routes `[rId]/...`. La validation server-side enforce
`is_admin=true` + `kindClass='org-admin'`.)

Spec §6.5 + §7.3 — book-keeping side du workflow de provisioning.
Le browser a déjà appelé `admin.createChild(access, spec)` côté
provider (ZK §4). Cet endpoint enregistre la nouvelle row dans la
DB sans toucher au token de l'enfant.

Pré-conditions enforced server-side :

- session valide, org visible (RLS) ;
- `:rId` existe dans l'org, `is_admin=true`, kind est dans
  `kindClass='org-admin'` ;
- `body.childKind` ∈ `admin.manages`.

Body :

```json
{
  "childKind": "github-repo",
  "name": "repo-a",
  "project_id": "<uuid>",
  "variant": "prod",
  "provider_ref": "vauban/repo-a",
  "metadata": { "org": "vauban", "repo": "repo-a" }
}
```

Réponse 201 :

```json
{
  "resource": { "...row insérée..." },
  "resource_id": "<uuid>"
}
```

Audit : `resource.provisioned` avec scope = `{ resource_id, admin_resource_id, child_kind }`.

### `DELETE /api/crm/v1/orgs/:orgId/resources/:rId/destroy-cloud-resource`

Spec §6.5 + §7.3. Le browser a déjà appelé
`admin.destroyChild(access, providerRef)` côté provider. Cet
endpoint supprime la row CRM (cascade sur resource_access) et
audite `resource.destroyed-cloud-side`.

Pré-conditions :

- `scope = 'project'` (sinon 409) ;
- `admin_resource_id` non null (sinon 409 — la suppression admin-less
  passe par `DELETE /resources/:rId` standard).

### `POST /api/crm/v1/orgs/:orgId/resources/:rId/access/:key/rotate`

Spec §6.4 + §7.4 — **dispatcher** des 3 paths. Le browser lit le
payload et exécute le sous-flux correspondant. Phase 5 livrait un
stub (`pending-runner`) ; Phase 6 wave B retourne `pending-dispatch`
avec les champs nécessaires :

| `rotation_method` | `next_step`            | Champs additionnels                                                   |
| ----------------- | ---------------------- | --------------------------------------------------------------------- |
| `manual`          | `operator-action`      | `setup_docs`                                                          |
| `self`            | `runner-self-rotation` | `setup_docs`                                                          |
| `admin-mediated`  | `admin-rotate-child`   | `admin_resource_id`, `admin_kind`, `child_provider_ref`, `setup_docs` |

Audit : `resource.access.rotate.requested` avec
`subject={rotation_method, admin_resource_id?}`.

## Reset `recipients_stale=false` sur PUT (Phase 5 TODO résolu)

Le `PUT /access/:key` insère/upsert maintenant `recipients_stale: false`
sur la row. Combiné au trigger SQL ci-dessous, cela donne le cycle :

1. Un membre est ajouté → trigger flippe `recipients_stale=true`
   sur tous les blobs de l'org (banner s'affiche).
2. Un admin unseal + re-seal pour la nouvelle liste de destinataires
   et PUT.
3. Le PUT remet `recipients_stale=false` → banner disparaît.

## Trigger SQL `recipients_stale` on membership change

Migration `supabase/migrations/1003_recipients_stale_on_membership.sql` :

- Function `flip_recipients_stale_on_member_change()` (`security definer`).
- Trigger `org_members_recipients_stale` `after insert or delete on org_members`.
- Updates : `resource_access.recipients_stale = true` pour tous les
  blobs des Resources de l'org dont la membership a changé (qu'on
  ait ajouté ou retiré un user — dans les deux cas, la liste de
  destinataires _doit_ être recalculée).
- Le `update` ne touche QUE les rows où `recipients_stale = false`
  (évite des cycles inutiles si plusieurs membres sont ajoutés en
  série dans la même transaction).

Appliquée sur prod via `psql aws-1-eu-west-3.pooler.supabase.com:6543`
le 2026-05-21 ; enregistrée dans `supabase_migrations.schema_migrations`
(version `1003`).

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

## UI (Phase 6 Wave C)

### `<ProvisionLauncher>` sur `/orgs/:slug/resources`

Bouton `+ Provision via …` qui ouvre un dropdown listant les
Resources `is_admin=true && scope='org'` de l'org. Cliquer sur un
admin redirige vers `/orgs/:slug/resources/provision?admin=:rId`.

Si aucun admin n'existe encore, le bouton est désactivé avec un
tooltip explicite (`Register an org-admin first`).

### `<ProvisionWizard>` sur `/orgs/:slug/resources/provision`

Wizard 3 étapes, state-machine pure (pas de modal en wave C — Phase 7
peut polish) :

1. **Pick child** — affiche `admin.kind.manages[]` et laisse l'user
   choisir lequel provisioner (`github-repo`, `vercel-project`,
   `supabase-project`).
2. **Fill spec** — formulaire dépendant du childKind (nom +
   private/framework/region). Bouton "Create cloud resource"
   désactivé tant que le nom est vide.
3. **Execute** — séquence :
   a. Unseal toutes les keys de l'admin's access bundle in-memory.
   b. Inject les identifiants kind-specific (`GITHUB_ORG`,
   `SUPABASE_ORG_ID`) depuis `admin.provider_metadata`.
   c. Pour Supabase : générer un `db_pass` initial CSPRNG +
   injecter `organization_id`.
   d. Appel `admin.kind.createChild(access, spec)` (browser → API
   provider via CORS).
   e. `unsealedBytes.fill(0)` immédiatement après.
   f. POST `/provision` avec `providerRef` retourné par l'API.
   g. Pour chaque key du `childKind.accessSchema` : `<SealedInput>`
   pour que l'opérateur seal le cleartext (les child tokens
   générés lors de la création initiale).

### `<RotateAccessButton>` sur la page détail

Bouton par clé d'access. Click → POST `/rotate`. Selon le
`rotation_method` :

- `manual` / `self` → affiche le `setup_docs` Markdown du kind et un
  `<SealedInput>` pour paste.
- `admin-mediated` → tente automatiquement :
  - unseal admin's access (transitoire),
  - call `admin.rotateChildAccess(...)` (browser → provider),
  - seal le nouveau cleartext,
  - PUT `/access/:key`,
  - wipe.

Si le provider lève `*RotationNotSupportedError` (GitHub PAT non
App, Supabase service_role, Vercel project token), on bascule
proprement sur le flow manual paste avec `err.setupDocs`.

### `<DestroyCloudResourceButton>` sur la page détail (project-scoped, admin-provisioned)

Affiche un confirm type-name (l'opérateur doit taper le nom exact
de la Resource). À la confirmation : unseal admin's access → appel
`admin.destroyChild(access, providerRef)` (browser → provider) →
`DELETE /destroy-cloud-resource` (book-keeping CRM, cascade sur
`resource_access`).

## ZK invariants UI (spec §4)

Les 3 composants Wave C wipe systématiquement les
`Uint8Array` unsealed (`.fill(0)`) dès la fin de l'appel provider —
pas de cleartext qui survit à la trace stack. Les tests
`provision-wizard.test.tsx` et `rotate-button.test.tsx` couvrent les
transitions d'état ; le no-leak est garanti structurellement par le
flow (chaque `unsealAs` est suivi de `decode` puis `bytes.fill(0)`).

## Roadmap d'implémentation

Phase 6 (build plan `.claude/build-plans/phase-6-provisioning-rotation.json`) :

- **Wave A** (done) — impl des 3 providers admin (`github`,
  `vercel`, `supabase-cloud`).
- **Wave B** (done) — REST endpoints + migration trigger SQL + reset
  `recipients_stale=false` sur PUT.
- **Wave C** (done) — `<ProvisionWizard>`, `<RotateAccessButton>`,
  `<DestroyCloudResourceButton>`, ProvisionLauncher.

## TODOs résiduels Phase 6

- Polling UI sur `supabase-project` après `createChild` pour passer
  `status='pending' → 'active'` (le projet est encore en
  `PROVISIONING` côté Supabase à la création). Non-bloquant ; la
  Resource est marquée `pending` côté CRM jusqu'à un futur cron de
  refresh (Phase 7).
- Polish modal du wizard (étape indicator visuel, validation des
  champs framework/region par kind).
- E2E Playwright `provision` / `rotate` / `destroy` contre vrais
  clouds (déjà flag dans `docs/tests/e2e-tests.md` Phase 6).
- Si CORS prouve être bloqué pour un provider en runtime, ajouter un
  proxy server-side `/api/crm/v1/proxy/*` (Phase 7).
