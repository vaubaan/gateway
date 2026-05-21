---
title: SecretManagers — Infisical et stubs Vault / 1Password
tracks:
  - packages/core/src/secret-manager/interface.ts
  - packages/core/src/secret-manager/db.ts
  - packages/core/src/secret-manager/infisical.ts
  - packages/core/src/secret-manager/infisical-client.ts
  - packages/core/src/secret-manager/index.ts
  - packages/core/tests/unit/secret-manager/db.test.ts
  - packages/core/tests/unit/secret-manager/infisical-client.test.ts
  - packages/core/tests/unit/secret-manager/infisical.test.ts
  - packages/core/tests/unit/secret-manager/interface.test.ts
  - packages/core/tests/integration/infisical.test.ts
  - packages/crm-catalog/src/secret-manager.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/secret-managers/route.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/secret-managers/[smId]/route.ts
  - packages/web/src/app/api/crm/v1/orgs/[orgId]/needs-reseal/route.ts
  - packages/web/src/lib/validation/secret-managers.ts
  - packages/web/src/lib/secret-managers/db.ts
  - packages/web/src/lib/secret-managers/re-seal-blob.ts
  - packages/web/src/app/(protected)/orgs/[slug]/layout.tsx
  - packages/web/src/app/(protected)/orgs/[slug]/secret-managers/page.tsx
  - packages/web/src/app/(protected)/orgs/[slug]/secret-managers/new/page.tsx
  - packages/web/src/components/secret-managers/SecretManagerList.tsx
  - packages/web/src/components/secret-managers/SetDefaultButton.tsx
  - packages/web/src/components/secret-managers/ConnectInfisicalWizard.tsx
  - packages/web/src/components/needs-reseal/NeedsResealBanner.tsx
  - packages/web/tests/unit/api/secret-managers.test.ts
  - packages/web/tests/unit/components/secret-managers.test.tsx
  - supabase/migrations/1000_provider_resource_manager.sql
last_reviewed: 2026-05-21
---

# SecretManagers — handbook

Documente l'implémentation effective de l'interface `SecretManager`
(spec §5.2), des plugins built-in `db` et `infisical`, et de la table
`public.secret_managers` (spec §3.1).

## Statut courant

**Phase 5 wave A + B (complète) livrées** :

- `@crm/core/secret-manager` — deux factories runtime (`db`,
  `infisical`) + un client REST bas-niveau Infisical (22 unit tests).
- REST `/api/crm/v1/orgs/:orgId/secret-managers` (`GET`, `POST`,
  `GET /:smId`, `PATCH /:smId`, `DELETE /:smId`) + `/needs-reseal`
  (21 unit tests).
- UI : `/orgs/:slug/secret-managers` (server component) +
  `/orgs/:slug/secret-managers/new` (wizard 3 steps) +
  `<NeedsResealBanner>` monté dans le layout org (8 unit tests).

Total CRM : 270 tests verts.

## Contrat

L'interface canonique vit dans **deux** fichiers — un pour les types
publics, un pour les implémentations en arbre :

- `packages/crm-catalog/src/secret-manager.ts` — surface publique
  `SecretManager` / `SealedBlob` exposée aux plugins externes (re-export
  des types crypto de `@crm/core/crypto`).
- `packages/core/src/secret-manager/interface.ts` — copie locale
  structurellement identique, utilisée par les implémentations dans
  `@crm/core/secret-manager`. La duplication est volontaire pour éviter
  le cycle `core → catalog → core` (catalog dépend déjà de core pour
  `SealedBlobV1`). Un test smoke vérifie la compatibilité structurelle
  (`tests/unit/secret-manager/interface.test.ts`).

Les 5 méthodes (spec §5.2) :

```ts
interface SecretManager {
  readonly kind: string; // 'db' | 'infisical' | …
  readonly name: string; // 'default' | 'infisical-prod' | …
  get(resourceId, accessKey): Promise<SealedBlob | null>;
  list?(resourceId): Promise<readonly string[]>;
  put(resourceId, accessKey, blob): Promise<void>;
  revoke(resourceId, accessKey): Promise<void>;
}
```

**Sémantique du `null`** : `get` doit retourner `null` (et non
throw) sur une clé absente — c'est un cas métier normal (Resource
créée mais pas encore d'`Access` PUT). Les transports / auth
errors throw `SecretManagerError` (`db.ts`) ou `InfisicalSmError` /
`InfisicalApiError` (`infisical.ts` / `infisical-client.ts`).

**`list` optionnel** : tous les backends ne savent pas énumérer (KV
flats). `db` et `infisical` le supportent en v1.

## Backend `db` (default v1)

Implémenté dans `packages/core/src/secret-manager/db.ts`.

- **Storage** : colonne `public.resource_access.sealed_blob` (bytea),
  gated par RLS (spec §3.3).
- **Wire format** : les bytes de `JSON.stringify(blob)` UTF-8,
  encodés en `\x<hex>` (Postgres text representation pour bytea). La
  fonction `encodeSealedBytea` produit ce literal ; `decodeSealedBytea`
  accepte aussi le format base64 si PostgREST est configuré dans ce
  mode.
- **`put`** = `upsert (resource_id, key)` (le PUT REST côté
  `/access/:key` met à jour ou crée). C'est aligné avec le PUT
  livré en Phase 4 wave A — la dual-write par `db` SM et par la
  route REST `/access/:key` est byte-identique.
- **`list`** = `SELECT key FROM resource_access WHERE resource_id = …
ORDER BY key`.
- **`revoke`** = `DELETE` sur `(resource_id, key)`. Idempotent (pas
  d'erreur si la row n'existait pas).
- **Identification** : `kind = 'db'`, `name` défaut `'default'`.

Le `db` SM est l'implémentation que les routes REST `/access` ont
implicitement câblée en Phase 4 (via leurs helpers dans
`packages/web/src/lib/resource-access/db.ts`). Phase 5 wave A
formalise ce pattern dans un objet `SecretManager` reusable — il
sera notamment utilisé par les tests d'intégration et par le futur
runner pull pattern (Phase 6+).

## Backend `infisical` (built-in v1)

Implémenté dans `packages/core/src/secret-manager/infisical.ts` +
le client bas-niveau `infisical-client.ts`.

### Mapping path

```
(resourceId, accessKey)  →  Infisical (secretPath, secretKey)
                              secretPath = `/<resourceId>`
                              secretKey  = `<accessKey>`
```

Le `secretValue` est **`base64(JSON.stringify(sealedBlob))`** —
base64 (pas raw JSON) pour deux raisons :

1. Robustesse au transport : Infisical normalise les UTF-8 secrets
   en interne ; base64 garantit un round-trip byte-pour-byte.
2. ZK pratique : la `secretValue` affichée dans l'UI Infisical (ou
   dans un audit log Infisical operator-side) n'expose pas
   directement la liste des `recipient.fp`. L'opérateur Infisical
   peut toujours base64-decode + JSON-parse pour les lire — c'est
   la spec §4.4 (recipients are public) — mais ce n'est pas gratuit
   visuellement.

### Auth bootstrap (spec §5.2)

Infisical utilise le flow **Machine Identity Universal Auth** :

```
1. L'org crée une Machine Identity dans son workspace Infisical →
   reçoit (clientId, clientSecret).
2. Wizard CRM (Phase 5 wave B) : l'admin colle ces deux strings.
3. Browser : seal((clientId, clientSecret) JSON) multi-recipient pour
   `org_admins ∪ runner_pk`.
4. POST /orgs/:orgId/secret-managers { kind: 'infisical', name,
   config: { workspace_id, endpoint, environment? }, auth_sealed_blob,
   is_default? }.
5. Première opération sur le SM : browser fetch la row, unseal le
   blob, parse `(clientId, clientSecret)`.
6. `createInfisicalSecretManager({ endpoint, workspaceId, environment,
   name, auth: { clientId, clientSecret } })` — la pair est en
   mémoire transitoirement.
7. Le client appelle POST /api/v1/auth/universal-auth/login,
   reçoit un `accessToken` short-lived (TTL ~7200s) qu'il cache
   en mémoire jusqu'à `expiresIn - skew` (60s de marge par défaut).
```

**Invariant ZK testé** : `InfisicalApiError.message` ne contient
**ni `clientSecret` ni `clientId`** — un test passe explicitement
un secret reconnaissable et grep le message d'erreur. Pas de
`console.log` dans le client (audit grep dans la review).

### CRUD secrets

| Op CRM         | HTTP Infisical                                             |
| -------------- | ---------------------------------------------------------- |
| `put (upsert)` | `GET …/secrets/raw/:key` puis `POST` ou `PATCH …/raw/:key` |
| `get`          | `GET …/api/v3/secrets/raw/:key?secretPath=…`               |
| `list`         | `GET …/api/v3/secrets/raw?secretPath=…`                    |
| `revoke`       | `DELETE …/api/v3/secrets/raw/:key`                         |

`get` retourne `null` sur 404 (clean missing). `revoke` swallows
404 (idempotent). Toute autre 4xx/5xx lève `InfisicalApiError`
avec `status` + `body` (sans creds).

### Sécurité réseau

Le `fetch` est injecté en option (`opts.fetchImpl`) — utilisé par
les tests pour mocker. Production utilise `globalThis.fetch` (Node
18+ ou navigateur).

Les hosts cibles sont déclarés dans le `secret_managers.config`
(`workspace_id`, `endpoint`) — l'orchestration des allow-lists
DNS/firewall vit dans le `egressHosts` du `ResourceKind` qui consomme
le SM, pas dans le SM lui-même.

## REST API `/api/crm/v1/orgs/:orgId/secret-managers`

Spec §6.2. Routes livrées :

| Verb     | Path                     | Rôle       | Audit action             |
| -------- | ------------------------ | ---------- | ------------------------ |
| `GET`    | `/secret-managers`       | org member | —                        |
| `POST`   | `/secret-managers`       | org admin  | `secret_manager.created` |
| `GET`    | `/secret-managers/:smId` | org member | —                        |
| `PATCH`  | `/secret-managers/:smId` | org admin  | `secret_manager.updated` |
| `DELETE` | `/secret-managers/:smId` | org admin  | `secret_manager.deleted` |
| `GET`    | `/needs-reseal`          | org member | —                        |

**`POST` shape** :

```json
{
  "kind": "infisical",
  "name": "default",
  "config": {
    "workspace_id": "ws-uuid",
    "endpoint": "https://eu.infisical.com",
    "environment": "prod"
  },
  "auth_sealed_blob": {
    "v": 1,
    "recipients": [{ "fp": "<32-hex>", "ct": "<base64>" }]
  },
  "is_default": true
}
```

**Codes d'erreur stables** :

- `400 invalid_field` — slug invalide, sealed_blob `v != 1`, endpoint
  non-http(s), `config.workspace_id` manquant, etc.
- `400 not_implemented` — `kind in ['vault', '1password']` (v1 ne
  livre que `infisical`).
- `401 unauthorized` — pas de session.
- `403 forbidden` — RLS denial (member non-admin).
- `404 not_found` — org non visible ou `smId` absent.
- `409 conflict` — `unique (organization_id, name)` violé.
- `409 is_default` — DELETE refusé sur la default SM.
- `409 referenced` — DELETE refusé sur une SM utilisée par
  ≥ 1 `resources.secret_manager_id`. Le body porte
  `referenced_resource_ids: [...]` pour aider l'UI à proposer un
  reassign.

**Invariant `is_default` unique** : la route `POST` (et `PATCH` quand
`is_default=true`) unset d'abord les autres défauts dans l'org avant
d'insert/update. Le swap n'est PAS une transaction SQL (supabase-js
n'expose pas `BEGIN…COMMIT`) mais le partial unique index
`secret_managers_one_default_per_org` garantit qu'on ne peut jamais
finir à 2 défauts (l'insert/update échouerait avec `23505` qui
remonte en `409 conflict`).

**Audit sans leak** : `secret_manager.created` et `.updated` n'ont
JAMAIS les bytes de `auth_sealed_blob` dans leur `subject`. Le
champ `recipient_count` (entier) est le seul indicateur de la taille
du blob — utilisé par le UI pour afficher "sealed for N recipients".

### `GET /api/crm/v1/orgs/:orgId/needs-reseal`

Renvoie `{ count: N, items: [{ resource_id, key, resource_name }] }`.
Le filtrage RLS est implicite : on lit d'abord la liste des
`resources` visibles à la session, puis on intersecte avec les rows
`resource_access` flagués `recipients_stale=true`. Un non-member voit
404 (org non visible). Un member voit 0 ou N entries selon ce que la
RLS lui laisse.

## UI

### Page `/orgs/:slug/secret-managers`

Server component qui liste les SMs de l'org via le client Supabase
session-bound (RLS auto). Header avec le bouton `+ Connect Infisical
Workspace`. Le composant `<SecretManagerList>` rend :

- Une row par SM avec `name`, `kind`, `config` summary, badge
  `default` (vert) si `is_default=true`, sinon un bouton
  `<SetDefaultButton>` qui PATCHe `is_default=true`.
- Un empty state si la liste est vide.

### Page `/orgs/:slug/secret-managers/new`

Server component qui calcule la liste des recipients candidats
(`org_members.role IN ('admin','owner')` joined avec
`user_crypto_keys`) et la passe en prop au wizard client
`<ConnectInfisicalWizard>`.

Le runner X25519 pubkey n'est pas encore deployé (Phase 6+) — on
omet pour l'instant, ce qui correspond au stub `defaultRecipients`
de Phase 2.

Le wizard a 3 étapes :

1. **Config** — `workspace_id`, `endpoint`, `environment`, `name`,
   `(clientId, clientSecret)`, checkbox `is_default`.
2. **Seal** — affiche la liste des recipients (cases à cocher),
   l'admin clique `Seal & continue`. Le browser sérialise
   `{ clientId, clientSecret }` en JSON, `sealForRecipients` génère
   le `auth_sealed_blob`, le `Uint8Array` cleartext est immédiatement
   `fill(0)`, le champ `clientSecret` du form state est remis à `''`.
3. **Submit** — récap + POST vers `/secret-managers`. Sur 201,
   redirect vers `/orgs/:slug/secret-managers`.

ZK invariants testés :

- Le `bodyStr` POSTé NE contient pas `clientSecret` en clair.
- `sealForRecipients` reçoit bien les bytes cleartext (capture mock).
- Après le seal, le form state n'a plus le `clientSecret`.

### `<NeedsResealBanner>`

Client component monté dans
`packages/web/src/app/(protected)/orgs/[slug]/layout.tsx`. Visible
sur **toutes** les routes `/orgs/:slug/*` (Resources, SM, future
provisioning…).

Comportement :

1. Mount → `GET /needs-reseal`. Si `count === 0` → render `null`
   (le banner est invisible).
2. Si `count > 0` → bandeau jaune en haut de page avec
   `"X access blobs need re-sealing for new members."` + bouton
   `Re-seal now`.
3. Click `Re-seal now` → itère `runReseal` (cf.
   `lib/secret-managers/re-seal-blob.ts`) sur chaque item. Affiche
   `Re-sealing… done/total` avec compteur de failures. Après la
   dernière itération, re-fetch `/needs-reseal` pour rafraîchir le
   compteur.

### `runReseal(input)` (re-seal-blob.ts)

Le coeur du flow de spec §4.5. Pour un `(resourceId, accessKey)`
donné :

1. `identityStore.get()` — abort `identity_locked` si pas unlocked.
2. `GET /access/:key` → sealed blob courant.
3. `unsealAs(blob, me.fp, me)` → cleartext ou `null` (abort
   `not_a_recipient`).
4. `GET /access/:key/recipients` → liste fraîche (l'endpoint
   Phase 2 calcule deja les membres avec keypair).
5. `sealForRecipients(cleartext, fresh)` → nouveau blob.
6. `PUT /access/:key { sealed_blob }` (le sweep Phase 4 wave C
   PATCH `recipients_stale=false` côté serveur — TODO : le PUT
   actuel ne le fait pas automatiquement, voir TODOs ci-dessous).
7. `finally`: `cleartext.fill(0)`.

## Stubs Vault / 1Password

**Volontairement hors-scope Phase 5** (cf. build plan
`out_of_scope_for_phase_5`). Pas de classe stub livrée — la route
REST `POST /secret-managers` rejette directement `kind in
['vault', '1password']` avec 400 `not_implemented`. Les classes
arriveront en v2+ avec leurs propres ADRs.

## Schema DB rappel

```sql
create table public.secret_managers (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  kind                text not null,                  -- 'db' (implicit) | 'infisical' | ...
  name                text not null,                  -- 'default' | 'infisical-prod' | ...
  is_default          boolean not null default false,
  config              jsonb not null default '{}'::jsonb,   -- { workspace_id, endpoint, environment? }
  auth_sealed_blob    bytea,                          -- sealed (clientId, clientSecret) JSON
  created_at          timestamptz not null default now(),
  unique (organization_id, name)
);

create unique index secret_managers_one_default_per_org
  on public.secret_managers (organization_id) where is_default;
```

RLS : admin RW, member R (cf. `1000_provider_resource_manager.sql`
lignes 348–366).

Le placeholder Phase 4 (`kind='placeholder'`) est remplacé en
Wave B par une row réelle `kind='infisical'` quand l'admin
complète le wizard.

## Re-seal (banner, spec §4.5)

Le banner UI consomme l'endpoint `GET
/api/crm/v1/orgs/:orgId/needs-reseal` (livré en Wave B). Il liste
les `resource_access` flagués `recipients_stale=true` visibles
via la session (RLS). Pour chaque blob, l'admin déclenche un
re-seal local :

1. `GET /resources/:rId/access/:key` → sealed_blob courant.
2. `unsealAs(blob, me.fingerprint, me.keypair)` côté browser.
3. `GET /resources/:rId/access/:key/recipients` → liste fraîche.
4. `sealForRecipients(cleartext, fresh_recipients)`.
5. `PUT /resources/:rId/access/:key` avec le nouveau blob.
6. Le sweep Phase 4 (PATCH `me/crypto-key replace=true`) a
   marqué les rows ; le PUT côté serveur peut clear le flag.

**Marquage de `recipients_stale`** : pour l'instant déclenché
uniquement par le PATCH `me/crypto-key replace=true` (Phase 4 wave
C). Le trigger SQL automatique sur les INSERT/DELETE
d'`org_members` est à livrer en Phase 6+ (cf.
`out_of_scope_for_phase_5`).

## Décisions amont

- ADR `docs/decisions/secret-manager-infisical-v1.md` — pourquoi
  Infisical en v1, autres backends en stubs.

## Spec de référence

- `docs/spec/cloud-resource-manager.md` §3.1 — table
  `secret_managers`.
- `docs/spec/cloud-resource-manager.md` §4.5 — re-sealing flow,
  banner UI.
- `docs/spec/cloud-resource-manager.md` §4.8 — backends "managed"
  hors-scope v1.
- `docs/spec/cloud-resource-manager.md` §5.2 — contrat `SecretManager`
  partagé avec le CAR.
- `docs/spec/cloud-resource-manager.md` §6.2 — endpoints REST.

## Roadmap d'implémentation

Phase 5 wave A (`secret-manager-core`, **livré ce commit**) :

- [x] Interface partagée `SecretManager` dans `@crm/core`.
- [x] Implémentation `db` (storage = colonne
      `resource_access.sealed_blob`).
- [x] Implémentation `infisical` + client REST bas-niveau (auth
      Universal-Auth + CRUD `/api/v3/secrets/raw`).
- [x] Tests unit (22 cas verts) + test intégration optionnel
      (skipped sauf creds env).

Phase 5 wave B (livré complet) :

- [x] Endpoints REST `/api/crm/v1/orgs/:orgId/secret-managers`
      (`sm-rest-api`).
- [x] Endpoint `/api/crm/v1/orgs/:orgId/needs-reseal`.
- [x] Page UI `/orgs/:slug/secret-managers` + wizard Connect
      Infisical (`sm-ui-and-banner`).
- [x] Banner re-seal monté dans le layout `/orgs/[slug]/` (visible
      sur `/resources`, `/secret-managers`, et toute future page
      org-scoped).

Hors-scope explicite Phase 5 (vers Phase 6+) :

- `VaultSecretManager` / `OnePasswordSecretManager` (rejet 400
  côté REST).
- Migration des sealed_blob de `resource_access.sealed_blob` →
  Infisical (DB reste source-of-truth en v1).
- Trigger SQL `recipients_stale=true` automatique sur
  INSERT/DELETE `org_members`.
