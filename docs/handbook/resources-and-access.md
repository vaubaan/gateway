---
title: Resources et resource_access — CRUD, RLS, audit
tracks:
  - supabase/migrations/1000_provider_resource_manager.sql
  - supabase/migrations/1002_resource_access_recipients_stale.sql
  - supabase/migrations/1004_grant_table_privileges.sql
  - packages/web/src/lib/resources/db.ts
  - packages/web/src/lib/validation/resources.ts
  - packages/web/src/lib/validation/orgs.ts
  - packages/web/src/app/api/crm/v1/orgs/route.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/resources/route.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/resources/[rId]/route.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/resources/[rId]/health/route.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/resources/[rId]/refresh/route.ts
  - packages/web/src/lib/resource-access/db.ts
  - packages/web/src/lib/validation/sealed-blob.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/resources/[rId]/access/route.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/resources/[rId]/access/[key]/route.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/resources/[rId]/access/[key]/rotate/route.ts
  - packages/web/src/app/(public)/sign-in/page.tsx
  - packages/web/src/app/(public)/sign-up/page.tsx
  - packages/web/src/app/(protected)/onboarding/page.tsx
  - packages/web/src/app/(protected)/orgs/[slug]/resources/page.tsx
  - packages/web/src/app/(protected)/orgs/[slug]/resources/[rId]/page.tsx
  - packages/web/src/app/(protected)/orgs/[slug]/resources/new/page.tsx
  - packages/web/src/components/onboarding/OnboardingForm.tsx
  - packages/web/src/components/wizard/KindPicker.tsx
  - packages/web/src/components/wizard/SetupDocsDisplay.tsx
  - packages/web/src/components/wizard/AccessSealForm.tsx
  - packages/web/src/components/wizard/RegisterWizard.tsx
  - packages/web/src/components/resources/ResourceTable.tsx
  - packages/web/src/components/resources/ResourceStatusBadge.tsx
  - packages/web/src/components/resources/ResourceDetailClient.tsx
  - packages/web/src/components/resources/AddAccessDialog.tsx
  - packages/web/src/components/sealed/SealedInput.tsx
  - packages/web/src/components/sealed/SealedReveal.tsx
  - packages/web/src/components/sealed/SealedView.tsx
  - packages/web/src/lib/sealed/base64.ts
  - packages/web/src/lib/sealed/use-default-recipients.ts
  - packages/web/tests/unit/api/resources.test.ts
  - packages/web/tests/unit/api/resource-access.test.ts
  - packages/web/tests/unit/api/orgs.test.ts
  - packages/web/tests/unit/components/wizard.test.tsx
  - packages/web/tests/unit/components/sealed.test.tsx
  - packages/web/tests/unit/components/resources-table.test.tsx
  - packages/web/tests/unit/components/resource-detail.test.tsx
last_reviewed: 2026-05-22
---

# Resources et resource_access — handbook

Document l'implémentation effective des tables `public.resources` et
`public.resource_access` (spec §3.1), les endpoints REST `/api/crm/v1`
(spec §6.3-§6.4), et leur écriture/lecture côté UI.

## Statut courant

**Phase 4, wave A complète : Resources REST + Access REST CRUD.**

Le scaffold v1 init avait livré le schéma SQL + indices + RLS sur les
deux tables. Wave A (deux features en parallèle) ajoute maintenant la
totalité des endpoints REST §6.3 (Resources) et §6.4 (Access).

**À livrer phase 4** :

- Wave B : `<SealedInput>` + pages `/orgs/:slug/resources` et detail.
- Wave C : onboarding + wizard register.

## Décisions amont

- ADR `docs/decisions/rls-minimaliste-2-roles.md` — politique RLS
  member/admin uniquement, granularité fine via crypto.

## Spec de référence

- `docs/spec/cloud-resource-manager.md` §3.1 — schéma des tables.
- `docs/spec/cloud-resource-manager.md` §3.2 — indices.
- `docs/spec/cloud-resource-manager.md` §3.3 — RLS matrix.
- `docs/spec/cloud-resource-manager.md` §4.3 — `SealedBlobV1`.
- `docs/spec/cloud-resource-manager.md` §6.3-§6.4 — endpoints REST.
- `docs/spec/cloud-resource-manager.md` §7.1-§7.4 — workflows.
- `docs/spec/cloud-resource-manager.md` §11 — UX (pages, patterns).

## Resources REST — `feature/p4-resources-rest-api`

Préfixe : `/api/crm/v1/orgs/:orgId/resources`. Le segment `:orgId` accepte
**soit l'UUID** soit le **slug** de l'organisation (UI vs M2M). RLS
gate la résolution : `findOrgIdBySlugOrId()` retourne `null` si l'user
n'est pas membre, qu'on remappe vers `404 { error: 'not_found' }` (la
même réponse qu'une org inexistante — pas de surface de probing).

Toutes les routes sont `dynamic = 'force-dynamic'` (lectures session-
qualifiées) avec `Cache-Control: no-store`.

### Endpoints

| Verbe  | Path                                         | RLS effective      | Status codes nominaux             |
| ------ | -------------------------------------------- | ------------------ | --------------------------------- |
| GET    | `/orgs/:orgId/resources`                     | member (R)         | 200 / 401 / 404                   |
| POST   | `/orgs/:orgId/resources`                     | admin (W)          | 201 / 400 / 401 / 403 / 404 / 409 |
| GET    | `/orgs/:orgId/resources/:rId`                | member (R)         | 200 / 401 / 404                   |
| PATCH  | `/orgs/:orgId/resources/:rId`                | admin (W)          | 200 / 400 / 401 / 403 / 404 / 409 |
| DELETE | `/orgs/:orgId/resources/:rId`                | admin (W)          | 200 / 401 / 403 / 404             |
| POST   | `/orgs/:orgId/resources/:rId/health` (stub)  | member (R) + audit | 202 / 401 / 404                   |
| POST   | `/orgs/:orgId/resources/:rId/refresh` (stub) | member (R) + audit | 202 / 401 / 404                   |

### `GET /orgs/:orgId/resources?scope=&project=&variant=&kind=&isAdmin=`

Liste les Resources visibles à l'user (RLS `resources_select_member`).
Filtres optionnels — spec §6.3 : `scope` ∈ `{org, project}`, `project`
(UUID, alias `project_id`), `variant` (slug), `kind` (id du
`ResourceKind`), `isAdmin` ∈ `{true, false}`.

Réponse `{ resources: ResourceRow[] }` ordonnée par `created_at desc`.

### `POST /orgs/:orgId/resources`

Body :

```jsonc
{
  "kind": "github-org", // resolved via @crm/catalog/findKind
  "name": "acme-gh", // slug ^[a-z0-9](-?[a-z0-9])*$
  "project_id": "<uuid?>", // requis ssi kind.kindClass='project'
  "variant": "staging|prod|...|null",
  "provider_ref": "acme",
  "metadata": { "org": "acme" },
  "console_url": "https://github.com/acme",
  "setup_docs_url": "...",
  "admin_resource_id": "<uuid?>", // ssi scope='project' (spec §3.1)
  "secret_manager_id": "<uuid?>", // sinon org default
}
```

Le validateur (`packages/web/src/lib/validation/resources.ts`) reproduit
**en amont** les check constraints de migration 1000 — slug regex, scope
cohérent avec project_id, admin-only-on-project — pour surfacer un 400
propre plutôt qu'un round-trip Postgres. `is_admin` est dérivé de
`kind.kindClass` (`org-admin` ⇒ `true`, sinon `false`), comme l'exige
le check `resources_admin_is_org_scoped`.

Si l'org n'a pas de `secret_managers` row avec `is_default=true` et que
le body n'épingle pas explicitement un `secret_manager_id`, la route
renvoie `400 { error: 'no_default_secret_manager' }`. Wave-C
(`onboarding`) provisionne un default au moment de la création d'org.

Audit log : `resource.registered`, `scope = { resource_id, kind, scope }`,
`subject = { name, variant }`. Le `audit_log.organization_id` est le
même que celui de la Resource (pas null comme pour
`user.crypto-key.*` du §4).

Erreurs DB mappées :

- `23505` (unique_violation sur `(org, project_id, name)`) → 409 `conflict`.
- `23514` (check_violation) → 400 `check_constraint_violation`.
- `42501` (insufficient_privilege RLS) → 403 `forbidden`.
- Autre → 500 `database_error`.

### `PATCH /orgs/:orgId/resources/:rId`

Mêmes garanties. Le validateur **refuse explicitement** la mutation de
`kind`, `scope`, `project_id`, `admin_resource_id`, `is_admin`,
`provider_name`, `organization_id`, `secret_manager_id` — pour changer
l'un de ceux-ci il faut détacher (DELETE) et re-register (POST).

Champs mutables : `name`, `variant`, `provider_ref`, `console_url`,
`setup_docs_url`, `metadata` (écrit dans `provider_metadata`), `status`
(énumération `pending|active|failed|detached`).

Si RLS renvoie 0 rows, la route fait une **seconde probe** pour
différencier `404` (row absent) de `403` (row existe mais membre, pas
admin). Audit : `resource.updated`, `subject = { fields: [...keys] }`.

### `DELETE /orgs/:orgId/resources/:rId`

`DELETE` détache la row Vauban — **ne touche pas au provider**. Spec
§6.5 réserve l'effet provider-side à `/destroy-cloud-resource`.
Snapshot avant le delete pour auditer `resource.deleted` avec
`subject = { name, variant }` et différencier 404 (snapshot vide) de
403 (snapshot OK mais delete sans effet).

### `POST /:adminId/provision` et `DELETE /:rId/destroy-cloud-resource` (Phase 6)

Le workflow `+ Provision via …` est livré en Phase 6 wave B. Voir
le handbook dédié `docs/handbook/provisioning-rotation.md` pour le
détail (browser-side createChild + book-keeping CRM, audit
`resource.provisioned` / `resource.destroyed-cloud-side`).

UI : `<ProvisionLauncher>` sur la liste, `<ProvisionWizard>` sur la
page wizard, `<RotateAccessButton>` + `<DestroyCloudResourceButton>`
sur la page détail.

### `POST /:rId/health` — sync browser probe

Le bouton **Test now** sur la page détail Resource exécute le probe
**côté browser**, pas via un Runner. L'unsealed cleartext est déjà
dans la tab quand l'user clique, donc passer par un Runner n'ajoute
aucune garantie ZK — juste de la latence et un point de panne en
plus.

Flow :

1. Le client `<ResourceDetailClient>` récupère la sk via
   `identityStore.get()` (sinon affiche `identity locked`).
2. Pour chaque clé déclarée dans `kind.accessSchema`, GET
   `/access/:key` → `unsealAs(blob, fingerprint, identity)` → cleartext
   en mémoire React state.
3. `runHealthProbe({ kindId, providerRef, metadata, access })` fait un
   `fetch(...)` direct contre l'API provider (cf.
   `packages/web/src/lib/health/probe.ts` pour la table de mapping
   par kind).
4. POST `/health` body `{ status: 'connected' | 'failed' | 'unknown',
message }` → server update `resources.connection_status`,
   `connection_message`, `connection_checked_at` + audit
   `resource.health.checked`.

Le serveur ne voit que le résultat (binaire), jamais l'access cleartext.

**CORS** — état au 2026-05-22 :

| Provider                | CORS browser | Test now status                |
| ----------------------- | ------------ | ------------------------------ |
| api.github.com          | `ACAO: *`    | OK                             |
| api.vercel.com          | `ACAO: *`    | OK                             |
| api.supabase.com (mgmt) | bloqué       | échoue `network: CORS blocked` |

Supabase Management API expose `Access-Control-Allow-Credentials: true`
mais ne renvoie pas d'`Access-Control-Allow-Origin` pour les origines
tierces — la whitelist côté Supabase ne couvre que le dashboard
supabase.com. Conséquence : les kinds `supabase-org` et
`supabase-project` font échouer le probe avec un message CORS dans
`connection_message`. Le user voit l'erreur directement, sans surface
de fallback v1.

Workarounds possibles si on doit débloquer Supabase plus tard (hors
scope v1) : proxy server-side qui forward avec le cleartext (rompt
la posture ZK — non), ou un mode "browser extension" qui contourne
CORS (lourd). Pour l'instant : accepté comme limitation documentée,
le user qui veut vraiment tester son token Supabase peut le faire via
`curl` ou le dashboard Supabase.

Si un futur kind cible une API sans CORS, le probe se comportera
exactement de la même manière : message `network: <error>` dans
`connection_message`. Pas de fallback Runner v1.

### `POST /:rId/refresh` (stub Phase 4)

Response `202 { status: 'pending-runner' }`. Audit
`resource.refresh.requested`. Re-pull de `provider_metadata` ; même
raisonnement que `/health` est applicable mais pas encore livré.

## Access REST — `feature/p4-access-rest-api`

Préfixe : `/api/crm/v1/orgs/:orgId/resources/:rId/access`. RLS-gated via
`resource_access_select_member` (R) et
`resource_access_{insert,update,delete}_admin` (W).

Toutes les routes sont `dynamic = 'force-dynamic'` + `Cache-Control:
no-store` — un sealed_blob n'a aucune raison de transiter par un cache
intermédiaire.

### Format on-disk

`resource_access.sealed_blob` est une colonne **bytea** (cf. migration
1000). On y stocke les **bytes UTF-8 du JSON canonique** `SealedBlobV1`
(spec §4.3) :

```jsonc
{
  "v": 1,
  "recipients": [{ "fp": "<32-hex>", "ct": "<base64 of crypto_box_seal output>" }],
}
```

Les helpers `sealedBlobToBytea` et `byteaToSealedBlob`
(`packages/web/src/lib/resource-access/db.ts`) font la conversion à la
frontière Postgres. La colonne reste opaque côté serveur ; la
recipient list à l'intérieur est lisible en clair par toute session
qui a un SELECT sur la row — c'est le contrat spec §4.4
(fingerprints publics, ciphertexts secrets).

### Endpoints

| Verbe  | Path                                       | RLS       | Status nominaux             |
| ------ | ------------------------------------------ | --------- | --------------------------- |
| GET    | `/access`                                  | member    | 200 / 401 / 404             |
| GET    | `/access/:key`                             | member    | 200 / 401 / 404             |
| PUT    | `/access/:key`                             | admin (W) | 200 / 400 / 401 / 403 / 404 |
| DELETE | `/access/:key`                             | admin (W) | 200 / 401 / 403 / 404       |
| POST   | `/access/:key/rotate` (stub, voir Phase 6) | member    | 202 / 401 / 404             |

### `GET /access`

Retourne **uniquement le résumé** : `{ key, description, rotated_at,
recipient_count }`. Pas de `sealed_blob`. Le `recipient_count` est
calculé en parsant la colonne `bytea` côté serveur (le client n'a pas
besoin du blob entier pour afficher la list page). Test : aucun champ
`ct` dans la réponse (`expect(JSON.stringify(body)).not.toContain('"ct"')`).

### `GET /access/:key`

Retourne le blob canonique : `{ key, description, rotated_at,
sealed_blob: { v: 1, recipients: [...] } }`. Un member RLS-visible
peut le récupérer ; il ne pourra **déchiffrer** que les `recipients`
qui matchent son fingerprint (spec §3.3 footnote — granularité fine
côté crypto, pas côté SQL).

### `PUT /access/:key`

Body :

```jsonc
{
  "sealed_blob": { "v": 1, "recipients": [{ "fp": "...", "ct": "..." }] },
  "description": "optional human-readable label",
}
```

Validation stricte (`packages/web/src/lib/validation/sealed-blob.ts`) :

- `v` est exactement `1` (literal type).
- `recipients` est un array non-vide (≥ 1 entry).
- Pas de doublon de fingerprint.
- Chaque `fp` matche `^[0-9a-f]{32}$`.
- Chaque `ct` est base64 valide ET décode à ≥ 48 bytes (taille
  minimale d'un `crypto_box_seal` envelope = 32 bytes ephemeral pubkey
  - 16 bytes MAC = 48 minimum).
- La clé d'URL `:key` matche `^[A-Z][A-Z0-9_]*$` (env-var style,
  cohérent avec `kind.accessSchema` du catalog).

Côté DB on fait un **upsert** sur `(resource_id, key)` (UNIQUE en
migration 1000). `rotated_at = now()` à chaque PUT.

Audit log : `resource.access.put`, `subject = { recipient_count }`.
**Jamais** de `ct` dans le log (vérifié par test :
`expect(JSON.stringify(audit_row)).not.toContain('"ct"')`).

### `DELETE /access/:key`

Détache la row du sealed_blob. Snapshot pour le `recipient_count`
d'audit, second probe pour différencier 404 de 403. Audit
`resource.access.deleted`, même subject que PUT.

### `POST /access/:key/rotate` (stub Phase 4)

Lit `kind.rotationMethod` depuis le catalog et retourne 202 avec :

```jsonc
{
  "status": "pending-runner",
  "rotation_method": "self|admin-mediated|manual",
  "next_step": "runner-self-rotation|admin-rotate-child|operator-action",
  "message": "rotation dispatch lands Phase 6",
}
```

Audit `resource.access.rotate.requested`, `subject = { rotation_method }`.
Phase 6 livrera le dispatch réel (Runner pour `self`, parent admin
pour `admin-mediated`, redirect vers setupDocs pour `manual`).

## Garanties ZK / audit

**ZK invariant** (spec §2.3) : aucun cleartext de secret ne transite
côté serveur. Le validateur `parseSealedBlob` ne décode les `ct` que
pour en mesurer la taille minimale ; il ne les loggue jamais. Le
handler `resources` ne stocke jamais de blob ; c'est la responsabilité
du handler `access`. Les seules inputs sensibles côté `resources` sont
les metadata du provider, qui ne contiennent **aucune** credential
(validé par les tests `accessSchema` côté catalog, Phase 3).

**Audit** : seuls `{ resource_id, key, kind, scope, recipient_count,
fields, name, variant }` (suivant l'action) sont écrits — testé en grep
dans `packages/web/tests/unit/api/resource-access.test.ts` :

```ts
expect(JSON.stringify(auditRow)).not.toContain('"ct"');
```

**Pas de service-role** : toutes les queries portent la session de
l'user. Aucun fichier sous
`packages/web/src/app/api/crm/v1/orgs/[orgId]/resources/` ni sous
`packages/web/src/lib/{resources,resource-access}/` ne lit
`SUPABASE_SERVICE_ROLE_KEY` (audit grep).

## Tests

`packages/web/tests/unit/api/resources.test.ts` (17 scénarios) :

- GET : 401 sans session, 404 quand org absente, list + filtre `scope=org`.
- POST : 201 register `github-org` (audit `resource.registered` écrit),
  refus `unknown_kind`, refus `scope/project_id` mismatch (project kind
  sans project_id, org kind avec project_id), refus slug invalide
  (uppercase), `no_default_secret_manager` quand l'org n'en a pas, 403
  quand RLS denie l'insert, `is_admin=true` automatique pour
  `github-org-admin`.
- PATCH : 200 update + audit, 400 sur tentative de change `kind`.
- DELETE : 200 + audit `resource.deleted`, 404 si resource absent.
- Stubs health / refresh : 202 `pending-runner` + audit.

`packages/web/tests/unit/api/resource-access.test.ts` (17 scénarios) :

- `GET /access` : 401 sans session, summary correct + `recipient_count`
  exact, aucun `ct` dans la réponse.
- `GET /access/:key` : 404 si absent, shape canonique `v=1` retournée.
- `PUT /access/:key` : upsert OK + audit, refus `v != 1`, recipients
  vides, fp non-hex, ct trop court, ct non-base64, key URL en
  lowercase, RLS 403 simulé, round-trip PUT → GET équivalence exacte.
- `DELETE /access/:key` : 200 + audit, 404 si absent.
- `POST /:key/rotate` : 202 + `rotation_method=manual` pour
  `github-org`, `admin-mediated` + `admin-rotate-child` pour
  `github-repo` (project kind).

Le client Supabase est faké via une in-memory store dans les tests
(`makeFakeDb()`). Les tests RLS-aware contre un vrai Supabase de test
sont planifiés dans `docs/tests/integration-tests.md`.

## UI — `feature/p4-wave-b-ui`

Phase 4 wave B livre les pages applicatives spec §11.1.

### `/orgs/:slug/resources` (server component)

Liste paginée des Resources visibles à l'user. Le server component fetche
via la session Supabase (RLS-aware) puis hydrate `<ResourceTable>`
client component pour le filtrage interactif (provider, kindClass,
variant, status). Bouton `+ Register` (link vers `/resources/new`) et
`+ Provision via …` (désactivé jusqu'à Phase 6). Liens des rows ouvrent
la detail page. Composant `<ResourceStatusBadge>` colore le pill
status/connection (spec §11.2).

### `/orgs/:slug/resources/:rId` (server component)

Detail d'une Resource :

- Header : nom, status badge, connection badge, lien `console_url`.
- Section `Provider metadata` (JSON pretty).
- Section `Access keys` : liste des rows `resource_access` avec le
  `recipient_count` calculé depuis la colonne `sealed_blob` (parse JSON
  inline côté server). **Aucun byte de `ct` n'arrive jusqu'au navigateur
  via ce server component** — seuls le summary et le count.
- `<ResourceDetailClient>` (island) : bouton `Test now` (POST `/health`)
  qui affiche `pending-runner`, et boutons `+ KEY` par entrée de
  `kind.accessSchema` qui ouvrent une `<AddAccessDialog>` enveloppant
  `<SealedInput>` pour livrer un nouveau sealed blob via PUT
  `/access/:key`. Après PUT, `window.location.reload()` rafraîchit la
  page.
- Si `is_admin=true` : section `Provisioned children` listant les
  Resources avec `admin_resource_id = this.id` (Phase 6 enables
  provisioning).
- Section `Audit timeline (last 50)` : derniers events `audit_log`
  filtrés sur `scope.resource_id == this.id`.

### Composants sealed (shared, livrés wave B)

Voir `docs/handbook/crypto-zk.md` section "Composants UI sealed" :
`<SealedInput>`, `<SealedReveal>`, `<SealedView>`. Réutilisés ici par
`<AddAccessDialog>` (input) et `<ResourceDetailClient>`/detail page
(view + reveal). Round-trip seal → PUT `/access/:key` testé en
`packages/web/tests/unit/components/resource-detail.test.tsx`.

## Onboarding & wizard — `feature/p4-onboarding-and-wizard`

Phase 4 wave C livre le flow bout-en-bout sign-up → onboarding →
register.

### Sign-in / sign-up (public)

- `/sign-in` : email/password via `supabase.auth.signInWithPassword`.
- `/sign-up` : email/password + confirm. Si email-confirmation est
  désactivée côté Supabase, la session est établie directement et on
  redirige vers `/onboarding`. Sinon notice "check your email".

### `/onboarding` (protected)

Server component qui regarde `org_members.user_id = auth.uid()`. Si
l'user appartient déjà à une org : redirect vers
`/orgs/<slug>/resources`. Sinon, render `<OnboardingForm>` (slug +
name) qui POST vers `/api/crm/v1/orgs`.

### `POST /api/crm/v1/orgs`

Bootstrap atomique (Phase 4 wave C) :

1. Insert `organizations` (service-role — pas de policy RLS `insert`
   sur cette table : c'est l'unique exception au "no service-role
   handler" du repo, justifiée par §3.3).
2. Insert `org_members(role='admin', user_id=auth.uid())`.
3. Insert `secret_managers(kind='placeholder', is_default=true)` pour
   satisfaire `resources.secret_manager_id NOT NULL` au prochain
   `POST /resources`. Phase 5 (Infisical) remplacera cette row par
   un vrai adapter.
4. Audit `org.created` via la session de l'user (passe par la RLS
   `audit_log_select_member` côté lecture).

Erreurs : 401 sans session, 400 sur slug invalide ou name vide, 409
sur slug existant.

### `/orgs/:slug/resources/new` — wizard register (3 steps)

`<RegisterWizard>` (client) orchestre :

1. **KindPicker** : pick parmi les 9 kinds livrés Phase 3 (lus depuis
   `CATALOG` + `serializeKind` côté server).
2. **SetupDocsDisplay** : affiche `kind.setupDocs` (markdown brut en
   `<pre>` pour ce phase ; TODO Phase 5 : renderer markdown sanitisé)
   - formulaire `name` / `variant` / `provider_ref` / `console_url`.
     À la soumission : `POST /api/crm/v1/orgs/:slug/resources` →
     `{ resource: { id } }`. Erreur PostgREST surfacée inline.
3. **AccessSealForm** : pour chaque clé de `kind.accessSchema`, un
   `<SealedInput>` + un `PUT /api/.../access/:key` derrière. Les
   status badges passent à `sealed` au fur et à mesure ; le bouton
   `Finish` se débloque quand toutes les clés sont sealed et
   redirige vers `/orgs/:slug/resources/:rId`.

### Sweep `recipients_stale` (spec §4.7)

Migration `1002_resource_access_recipients_stale.sql` (appliquée en
prod via le pooler) ajoute la colonne `recipients_stale boolean not
null default false` + un index partiel `where recipients_stale`.

Le handler `PATCH /api/crm/v1/me/crypto-key` mode `replace=true`
(spec §4.7) implémente maintenant la step 4 : `markResourceAccessStale`
liste les rows visibles via la session (donc RLS-scopé), parse le
`sealed_blob` JSON pour vérifier la présence de `old_fingerprint`
dans `recipients[].fp`, et flip `recipients_stale=true` sur les
matches. Le compteur final atterrit dans `audit_log.subject.swept_stale_count`.

Le banner UI "X blobs need re-sealing" (spec §11.2) lira ce flag —
livrable Phase 5+.

## Roadmap d'implémentation

Phase 4 du roadmap (cf. build plan `phase-4-resources-crud.json`) :

- [x] **Wave A — `resources-rest-api`** : endpoints §6.3 livrés.
- [x] **Wave A — `access-rest-api`** : endpoints §6.4 livrés.
- [x] **Wave B — UI (sealed components, list page, detail page)**.
- [x] **Wave C — onboarding + wizard + recipients_stale sweep**.
