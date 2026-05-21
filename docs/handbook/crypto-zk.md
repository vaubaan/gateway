---
title: Crypto zero-knowledge — keypair, sealing, unsealing, re-seal
tracks:
  - packages/core/src/crypto/index.ts
  - packages/core/src/crypto/sodium.ts
  - packages/core/src/crypto/kdf.ts
  - packages/core/src/crypto/keypair.ts
  - packages/core/src/crypto/wrap.ts
  - packages/core/src/crypto/sealed-box.ts
  - packages/core/src/crypto/recipient-defaults.ts
  - packages/core/src/crypto/types.ts
  - packages/crm-catalog/src/secret-manager.ts
  - packages/web/src/app/api/crm/v1/me/crypto-key/route.ts
  - packages/web/src/lib/validation/crypto-key.ts
  - packages/web/src/app/api/crm/v1/resources/[rId]/access/[key]/recipients/route.ts
  - packages/web/src/lib/crypto/identity-store.ts
  - packages/web/src/lib/crypto/use-user-identity.ts
  - packages/web/src/components/identity/UnlockIdentityDialog.tsx
  - packages/web/src/components/identity/IdentityGate.tsx
  - packages/web/src/components/identity/SignOutButton.tsx
  - packages/web/src/app/(protected)/layout.tsx
  - packages/web/src/app/(protected)/orgs/[slug]/layout.tsx
  - packages/web/src/components/needs-reseal/NeedsResealBanner.tsx
  - packages/web/src/lib/secret-managers/re-seal-blob.ts
  - supabase/migrations/1001_audit_log_org_nullable.sql
last_reviewed: 2026-05-21
---

# Crypto zero-knowledge — handbook

Document l'implémentation effective de la couche cryptographique ZK
(spec `docs/spec/cloud-resource-manager.md` §4) : génération de la
keypair X25519 par user, dérivation Argon2id de la KEK, wrap/unwrap
de la sk, scellement multi-recipient, recipient list, re-seal sur
membership change.

## Statut courant

**Primitives livrées** (wave A, phase 2 — `feature/crypto-core-lib`).

Le package `@crm/core` expose désormais sous le sub-export
`@crm/core/crypto` les helpers crypto purs, utilisables côté browser
comme côté Node (Runner, tests d'intégration). Ils s'appuient sur
`libsodium-wrappers-sumo` (WASM, build "sumo" pour disposer de
`crypto_pwhash`).

**Endpoint `/api/crm/v1/me/crypto-key` livré** (wave B, phase 2,
`feature/api-me-crypto-key`). Voir la section dédiée plus bas.

**Reste à livrer** (wave B et au-delà) :

- Hook React `useCryptoIdentity()` qui orchestre bootstrap + cache
  mémoire de la sk déballée. **Livré Phase 4 wave B**.
- Composant `<SealedInput>` qui scelle au moment du `put` Access.
  **Livré Phase 4 wave B**.
- Banner UI "X blobs need re-sealing" + endpoint `/needs-reseal`
  (spec §4.5). **Livré Phase 5 wave B** —
  `<NeedsResealBanner>` monté dans `(protected)/orgs/[slug]/layout.tsx`,
  endpoint REST sous
  `/api/crm/v1/orgs/[orgId]/needs-reseal/route.ts`, handler per-blob
  `lib/secret-managers/re-seal-blob.ts::runReseal`.
- Flow `lost password` côté UI (la backend route gère déjà le
  `replace=true` ; le re-seal des blobs staled est désormais déclenché
  par le banner Phase 5).

**Livré dans wave B (Phase 2)** :

- Endpoint `GET /api/crm/v1/resources/:rId/access/:key/recipients`
  (default list, cf. section "Recipient list endpoint" plus bas).

## Re-seal effective (spec §4.5) — Phase 5

Le flow complet est désormais cliquable :

1. Un trigger (PATCH `me/crypto-key replace=true` côté Phase 4 wave
   C, ou bientôt un trigger SQL sur INSERT/DELETE org_members en
   Phase 6+) flippe `resource_access.recipients_stale=true` sur
   chaque blob où le user concerné est recipient.
2. À chaque visite d'une page `/orgs/[slug]/*`, le
   `<NeedsResealBanner>` fait un `GET /needs-reseal` ; s'il y a au
   moins une row stale visible, le banner jaune s'affiche en haut.
3. L'admin click `Re-seal now` → pour chaque blob,
   `runReseal({ orgSlug, resourceId, accessKey })` :
   - GET `/access/:key` → blob courant
   - `unsealAs` côté browser avec l'identité unlocked en mémoire
   - GET `/access/:key/recipients` → liste fraîche
   - `sealForRecipients(cleartext, fresh)`
   - PUT `/access/:key { sealed_blob }`
   - `cleartext.fill(0)` en `finally`
4. À la fin de l'itération, le banner re-fetch `/needs-reseal`. Si
   le compteur revient à 0, le banner disparaît.

**TODO Phase 6** : le PUT `/access/:key` actuel (Phase 4 wave A) ne
flippe pas `recipients_stale=false` côté serveur. C'est un détail
de finalisation côté route ; tant qu'on n'a pas le trigger SQL qui
remet le flag à true sur membership change, on peut faire un
reset explicite côté re-seal handler (PATCH dédié) ou rajouter le
clear dans le PUT existant. Vu que la spec §4.5 prévoit déjà
"SM clear recipients_stale", la voie naturelle est de l'ajouter
dans le PUT. **Marqué pending dans `out_of_scope_for_phase_5`** du
build plan.

## Décisions amont (lecture obligatoire)

- ADR `docs/decisions/crypto-libsodium-sealed-box-multi-recipient.md`
  — choix de la primitive et du format on-disk.
- ADR `docs/decisions/single-keypair-per-user.md` — 1 keypair par
  user, multi-device via `wrapped_sk` redistribué.

## Spec de référence

- `docs/spec/cloud-resource-manager.md` §2.3 (invariant ZK).
- `docs/spec/cloud-resource-manager.md` §4.0 → §4.9 (mécanismes
  détaillés).

## Primitives publiques (`@crm/core/crypto`)

Toutes les fonctions sont `async` : le premier appel charge le WASM
de libsodium (cache module-level via `getSodium()`).

### KDF — `deriveKEK(password, salt, params?)`

Dérive une KEK 32 bytes via Argon2id (`crypto_pwhash_ALG_ARGON2ID13`).
Defaults : `m = 67108864` (64 MiB), `t = 3`, `p = 1`. La fonction
**refuse** tout paramètre plus faible que les defaults et tout salt
qui n'est pas 16 bytes. Source : spec §4.1.

### Keypair — `generateUserKeypair()` et `fingerprintOf(publicKey)`

- `generateUserKeypair()` → `{ publicKey: Uint8Array(32), privateKey: Uint8Array(32), fingerprint: string }`.
- `fingerprintOf(pk)` = `sha256(pk).slice(0, 16)` encodé hex (32 chars).
  Implémenté via `crypto.subtle.digest('SHA-256', ...)` (`crypto_hash_sha256`
  n'est pas exposé par libsodium-wrappers-sumo 0.7.x ; Web Crypto est
  natif Node 20+ et browser).

### Wrap — `wrapPrivateKey(sk, kek)` et `unwrapPrivateKey(wrapped, kek)`

Wrap = `crypto_secretbox_easy(sk, nonce24, kek)` avec un nonce frais
random ; layout on-disk = `nonce(24) || ciphertext`. `unwrapPrivateKey`
retourne `null` sur tag invalide, mauvaise KEK, ou input mal formé —
jamais d'exception, jamais de fuite de cleartext dans un message.

### Sealed-box — `sealForRecipients(plaintext, recipients[])` et `unsealAs(blob, fp, kp)`

- `sealForRecipients` produit le bundle canonique `SealedBlobV1` (spec
  §4.3). Pour chaque recipient : `crypto_box_seal(plaintext, recipient.publicKey)`,
  base64-encoded dans `ct`, fingerprint dans `fp`.
- `unsealAs` trouve l'entrée matching le fingerprint propre, décode le
  base64 et appelle `crypto_box_seal_open`. Retourne `null` si l'entrée
  n'existe pas ou si le tag est invalide.
- Helper `decodeUtf8(bytes)` pour les payloads texte.

### Recipient defaults — `defaultRecipients({ orgMembers, runner?, isOrgAdminResource })`

Fonction pure (pas de WASM, pas d'I/O). Implémente la règle spec §4.4 :

| `isOrgAdminResource` | `runner`  | recipients résultat      |
| -------------------- | --------- | ------------------------ |
| `false`              | absent    | `orgMembers`             |
| `false`              | présent   | `orgMembers ∪ {runner}`  |
| `true`               | n'importe | `orgMembers` (no runner) |

## Format `SealedBlobV1`

Source de vérité : spec §4.3. Le type canonique vit dans
`packages/core/src/crypto/types.ts` :

```ts
interface SealedBlobV1 {
  readonly v: 1;
  readonly recipients: ReadonlyArray<{
    readonly fp: string; // 32 hex chars
    readonly ct: string; // base64 of crypto_box_seal output
  }>;
}
```

`@crm/catalog/src/secret-manager.ts` ré-exporte ce type sous le nom
`SealedBlob` (alias historique), pour les consommateurs `SecretManager`.
La forme on-disk garde `fp` comme nom de champ, **pas** `fingerprint`.

## Tests

Couverture unit sous `packages/core/tests/unit/crypto/` :

- `kdf.test.ts` — déterminisme, sensibilité au salt, refus de params
  trop faibles, refus de salt mal taillé.
- `keypair.test.ts` — tailles (32 bytes pub/priv), format du
  fingerprint, unicité.
- `wrap.test.ts` — roundtrip, échec sur mauvaise KEK, échec sur
  ciphertext tampered.
- `sealed-box.test.ts` — multi-recipient (3 users), non-recipient
  reçoit `null`, tampering détecté.
- `recipient-defaults.test.ts` — les 3 cas de la table §4.4 + cas
  vide.

Lancer : `npm run test` à la racine du repo (vitest scanne tous les
workspaces). 25 assertions vertes à l'écriture de ce commit.

## Notes d'implémentation

- **WASM init est cher** : la première invocation `await getSodium()`
  charge ~250 KB de WASM (variante sumo). Cache module-level pour
  qu'il n'y ait qu'un init par tab/process.
- **Vitest et libsodium-wrappers-sumo** : le tarball publié pour
  l'entrée ESM référence un sibling `libsodium.mjs` non packagé. Le
  fichier `vitest.config.ts` aliase le specifier vers le bundle CJS
  (résolu via `createRequire`) pour que les tests Node passent. Côté
  web (Next.js / Webpack), l'import direct fonctionne sans alias.
- **Pas d'I/O dans les helpers crypto** : pas de `fetch`, pas de `fs`,
  pas de dépendance Supabase. Les recipients sont des `PubKeyEntry`
  fournis par le caller, pas résolus en interne.
- **Aucun secret loggué** : ni dans le code, ni dans les messages
  d'erreur. `unwrapPrivateKey` et `unsealAs` retournent `null` sur
  échec.

## API endpoints — `/api/crm/v1/me/crypto-key`

Endpoint REST qui gère le cycle de vie de la `user_crypto_keys` row
de l'user authentifié. Trois verbes : `GET` (lecture), `POST`
(bootstrap au premier login), `PATCH` (rotation password §4.6 ou
remplacement d'identité §4.7). Aucun usage du service-role : la
RLS `user_id = auth.uid()` est la seule porte d'accès.

**Headers communs** : `Cache-Control: no-store` est forcé sur toutes
les réponses (wrapped_sk est sensible — pas de cache CDN, pas de
cache navigateur).

**Wire format** : les colonnes `bytea` (`public_key`,
`wrapped_private_key`, `kdf_salt`) sont base64 dans le JSON ; la
route fait la conversion vers `\x` hex pour l'INSERT/UPDATE et
re-décode au moment du SELECT.

### `GET /api/crm/v1/me/crypto-key`

| Statut | Quand                                      | Body                                                                                             |
| ------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 200    | Row existe                                 | `{ public_key, fingerprint, wrapped_private_key, kdf_salt, kdf_params, created_at, rotated_at }` |
| 401    | Pas de session Supabase                    | `{ error: 'unauthorized' }`                                                                      |
| 404    | Row absente — flow first-login (spec §4.1) | `{ error: 'not_found' }`                                                                         |

### `POST /api/crm/v1/me/crypto-key`

Crée la row au premier login d'un user. Idempotent côté RLS via la
PK sur `user_id`.

Body :

```jsonc
{
  "public_key": "<base64(32 bytes)>",
  "fingerprint": "<32 hex chars>",
  "wrapped_private_key": "<base64(72 bytes typical)>",
  "kdf_salt": "<base64(16 bytes)>",
  "kdf_params": { "m": 67108864, "t": 3, "p": 1, "alg": "argon2id" },
}
```

`kdf_params` est optionnel ; absent ⇒ defaults spec §4.1.

| Statut | Body                                                                         |
| ------ | ---------------------------------------------------------------------------- |
| 201    | `{ ok: true, fingerprint }`                                                  |
| 400    | `{ error: 'invalid_field'\|'invalid_json'\|'kdf_params_too_weak', message }` |
| 401    | `{ error: 'unauthorized' }`                                                  |
| 409    | `{ error: 'conflict' }` (row déjà présente)                                  |

Side effect : `audit_log` ligne `user.crypto-key.created`,
`organization_id = NULL`, `subject = { fingerprint }`.

### `PATCH /api/crm/v1/me/crypto-key`

Deux modes :

**Mode 1 — `rotate-password` (spec §4.6)** : la pubkey est inchangée,
seulement la dérivation KEK et le wrapped_sk bougent.

Body :

```jsonc
{
  "wrapped_private_key": "<base64>",
  "kdf_salt": "<base64>",
  "kdf_params": { … }  // optional
}
```

`public_key` / `fingerprint` doivent **être absents** sinon 400 (la
route refuse les payloads ambigus entre rotate-password et
replace-identity).

Audit : `user.crypto-key.rotated-password`, `subject = { fingerprint }`
(fingerprint courant, inchangé).

**Mode 2 — `replace-identity` (spec §4.7, lost-password)** :
nouvelle keypair entière. `replace: true` est requis pour entrer dans
ce mode.

Body :

```jsonc
{
  "replace": true,
  "public_key": "<new base64(32)>",
  "fingerprint": "<new 32 hex>",
  "wrapped_private_key": "<base64>",
  "kdf_salt": "<base64>",
  "kdf_params": { … }  // optional
}
```

Audit : `user.crypto-key.replaced-identity`,
`subject = { fingerprint: new_fp, old_fingerprint: prev_fp }`.

**Reseal-sweep sur `replace=true`** (spec §4.7 étape 4, livré Phase 4
wave C) : à la suite d'un `replace-identity`, le handler appelle
`markResourceAccessStale(supabase, oldFingerprint)` qui :

1. SELECT tous les `resource_access` rows visibles via la session
   (RLS-scopé naturellement).
2. Parse chaque `sealed_blob` (bytea → UTF-8 → JSON) et regarde si
   `recipients[].fp` contient `old_fingerprint`.
3. UPDATE `recipients_stale = true` pour chaque match.
4. Retourne le compteur, qui atterrit dans
   `audit_log.subject.swept_stale_count`.

Migration `1002_resource_access_recipients_stale.sql` ajoute la
colonne + un index partiel `where recipients_stale`. Le banner UI
"X blobs need re-sealing" du spec §11.2 lira ce flag (livrable
Phase 5+).

| Statut | Body                                             |
| ------ | ------------------------------------------------ |
| 200    | `{ ok: true, fingerprint, old_fingerprint? }`    |
| 400    | `{ error: …, message }`                          |
| 401    | `{ error: 'unauthorized' }`                      |
| 404    | `{ error: 'not_found' }` (utiliser POST d'abord) |

### Audit log — invariants ZK

Le log audit n'écrit **jamais** de cleartext ni de wrapped_sk : seul
le fingerprint (et `old_fingerprint` au replace) entre dans `subject`.
Les messages d'erreur 400 ne quotent jamais les valeurs reçues —
`kdf_params too weak`, pas `m=12345 < 67108864`.

Pour permettre des lignes audit user-scoped (org-less),
[`supabase/migrations/1001_audit_log_org_nullable.sql`](../../supabase/migrations/1001_audit_log_org_nullable.sql)
passe `audit_log.organization_id` en nullable et ajoute deux policies
RLS : `audit_log_select_self` (l'actor lit ses propres rows org-less)
et `audit_log_insert_self` (la route HTTP insère via le client RLS,
pas le service-role).

## Recipient list endpoint

> Source : spec §4.4. Implémenté sous
> `packages/web/src/app/api/crm/v1/resources/[rId]/access/[key]/recipients/route.ts`.

Contrat :

```
GET /api/crm/v1/resources/:rId/access/:key/recipients
  → 200 { defaults: [ { user_id?, public_key, fingerprint }, ... ] }
  → 401 { error: 'unauthorized' }     (pas de session)
  → 404 { error: 'not_found' }        (resource inconnue OU user non-membre de l'org)
```

- `public_key` est en **base64** (la table `user_crypto_keys` stocke
  en `bytea` ; PostgREST retourne `\x<hex>`, on convertit côté
  handler). `fingerprint` est le format canonique sha256(pubkey)[..16]
  (32 chars hex).
- `user_id` est inclus pour permettre au browser d'afficher
  nom/email à côté de chaque fingerprint au moment du seal (TOFU +
  validation visuelle, §4.4). Le champ est `optional` au schéma pour
  anticiper la phase 5 où le Runner figurera dans la liste sans
  `user_id` (mais avec un `runner_id` à terme).
- `Cache-Control: no-store` sur toutes les réponses : les memberships
  peuvent changer à tout moment, on ne veut pas servir une liste
  périmée depuis un cache intermédiaire.

Implémentation (chemin nominal) :

1. `createSupabaseServerClient()` (cookies session de l'user).
2. `auth.getUser()` — 401 si pas de session.
3. `select id, organization_id, is_admin from resources where id = :rId`.
   La policy `resources_select_member` exclut les rows hors-org de
   l'user — un non-membre voit 0 ligne et reçoit un 404 indistinguable
   de "ressource inconnue". C'est volontaire (pas de surface de
   probing).
4. `select user_id from org_members where organization_id = $1`.
5. `select user_id, public_key, fingerprint from user_crypto_keys where user_id in (...)`.
   La policy `user_crypto_keys_select_org_peer` autorise un member à
   lire les pubkeys de ses pairs.
6. Compose `orgMembers: PubKeyEntry[]` (en excluant les members sans
   `user_crypto_keys` row — pas encore d'identité crypto, donc pas
   recipients).
7. `defaultRecipients({ orgMembers, runner: undefined, isOrgAdminResource: resource.is_admin })`.
8. Map back vers le wire format (`{ user_id, public_key, fingerprint }`).

**Spécificités phase 2** :

- Pas de table `runners` encore en place → `runner = undefined`. Le
  TODO est balisé dans le code (`TODO(phase-5)`). Tant que `runner`
  est `undefined`, la branche `is_admin=true` vs `is_admin=false` du
  `defaultRecipients` ne change rien à la liste — c'est juste un
  no-op qui prépare la suite.
- Le paramètre d'URL `:key` est **accepté mais ignoré** dans le
  calcul. Spec §4.4 n'introduit pas de per-key overrides en v1 ; le
  segment est dans l'URL pour cohérence avec
  `/access/:key/{...}` (PUT, GET sealed_blob) et pour laisser la
  porte ouverte à une override par clé en v2 sans changer le shape.
- Pas de service-role : tout passe par la session de l'user et les
  RLS. Un audit `grep SUPABASE_SERVICE_ROLE_KEY` sur le dossier
  `resources/` doit rester vide.

**Tests** :

Unit tests sous `packages/web/tests/unit/api/recipients.test.ts`
(mocks le client Supabase) couvrent :

- 401 sans session.
- 404 quand la resource n'est pas visible (RLS retourne 0 row).
- défauts pour une resource non-admin (2 members avec keypair).
- défauts pour une resource org-admin (idem en phase 2 — pas de
  runner à exclure).
- exclusion d'un member qui n'a pas encore généré sa keypair.
- décodage du `bytea` au format wire Postgres `\x<hex>`.

Integration tests RLS-aware contre une instance Supabase de test :
listés dans `docs/tests/integration-tests.md` (scénarios "Crypto ZK
(phase 2)"). Setup nécessaire = service-role test helper qui crée
l'org / les users / les rows `user_crypto_keys`, puis appelle le
handler via une session JWT. À câbler quand le harness `vitest +
supabase test stack` sera prêt côté CI.

## Browser flow

> Source : spec §4.1 (cycle de génération), §4.1.1 (cache mémoire
> seul). Implémenté wave B sous
> `packages/web/src/lib/crypto/{identity-store,use-user-identity}.ts`
>
> - `packages/web/src/components/identity/{UnlockIdentityDialog,IdentityGate,SignOutButton}.tsx`.

Les 6 steps spec §4.1 sont orchestrés au mount d'un layout protégé :

```
+----------------+      +-----------------------+      +-----------------+
| Supabase login | ---> | IdentityGate (client) | ---> | UnlockDialog    |
| (email + pw)   |      | getUser() + GET /me/  |      | (asks password) |
+----------------+      | crypto-key (probe)    |      +--------+--------+
                        +-----------+-----------+               |
                                    |                           v
                                    |             +---------------------------+
                                    |             | useUserIdentity()         |
                                    |             |  ├─ 404 → initOrUnlock()  |
                                    |             |  │       (gen kp +       |
                                    |             |  │        wrap sk +      |
                                    |             |  │        POST)          |
                                    |             |  └─ 200 → unlock()       |
                                    |             |          (deriveKEK +    |
                                    |             |           unwrap sk)     |
                                    |             +-------------+-------------+
                                    |                           |
                                    v                           v
                          state==='unlocked'           identityStore.set(id)
                          → children rendered          (memory-only singleton)
```

### `identity-store.ts` — singleton mémoire

`Identity = { publicKey, privateKey, fingerprint }`. Backed by un
binding module-level. `clear()` remplit les bytes de `privateKey` et
`publicKey` avec 0 avant de drop la référence — defense in depth (V8
peut garder des copies dans des heap snapshots, on réduit la fenêtre
sans la fermer). **Aucun** `localStorage` / `sessionStorage` /
`IndexedDB` / `document.cookie` n'est touché : grep audit obligatoire
(cf. §"Audits" plus bas).

### `useUserIdentity()` — hook d'orchestration

State machine :

```
absent ──unlock()──> locked ──ok──> unlocked
   ▲                    │              │
   └────fail────────────┘              │
                                       │
absent ──initOrUnlock()──> locked ─ok─┘
                              └─409 (race)─> unlock() ──> unlocked
```

API renvoyée par le hook :

```ts
{
  state: 'absent' | 'locked' | 'unlocked';
  identity: { publicKey: Uint8Array; fingerprint: string } | null;
  unlock(password): Promise<void>;
  lock(): void;
  initOrUnlock(password): Promise<{ created: boolean }>;
}
```

Le hook **n'expose pas `privateKey`** au consommateur React. Les
appelants qui ont besoin de sealing/unsealing demandent l'instance
directement à `identityStore.get()` (même package, même trust
boundary). Le password passé en paramètre est copié dans une variable
mutable (`let pw = passwordIn`) puis réassignée à `''` après usage —
les strings JS sont immutables donc la copie originale persiste dans
le heap, mais on raccourcit la fenêtre.

### Contrat HTTP `/api/crm/v1/me/crypto-key` (côté browser)

```
GET  /api/crm/v1/me/crypto-key
  → 200 { public_key, fingerprint, wrapped_private_key, kdf_salt,
          kdf_params? }   (tous base64 sauf fingerprint hex et
                           kdf_params jsonb)
  → 404 (pas de row encore — first login)
POST /api/crm/v1/me/crypto-key
  body { public_key, fingerprint, wrapped_private_key, kdf_salt }
  → 200 (row créée)
  → 409 (race : une autre device a posté entre-temps)
```

L'endpoint lui-même vit dans la feature parallèle `api-me-crypto-key`.
Le hook code contre ce contrat ; en local sans l'endpoint mergé, on
peut le mocker.

### `<UnlockIdentityDialog>` et `<IdentityGate>`

- Le dialog rend un input `type=password` avec `autocomplete="off"`
  pour décourager les form fillers de stocker le mot de passe Vauban.
  Il wipe son state local (`setPassword('')`) après chaque submit
  (succès ou échec).
- `IdentityGate` checke `supabase.auth.getUser()` au mount. Sans
  user, il rend les enfants tels quels (laisse passer les pages
  publiques / login). Avec user + `state !== 'unlocked'`, il bloque
  les enfants et monte le dialog en mode `'first-login'` si le probe
  GET renvoie 404, sinon `'unlock'`.
- Le route group `app/(protected)/layout.tsx` monte le gate ; les
  routes protégées des phases ultérieures (Resources CRUD, etc.)
  s'y greffent.

### Logout

`SignOutButton` appelle `identityStore.clear()` **avant**
`supabase.auth.signOut()` — l'ordre compte : on vide la sk en
mémoire avant de relâcher la session, pour qu'un redirect ne laisse
pas la clé déballée accessible depuis la page suivante.

### Audits visuels exigés

- `grep -RIn "localStorage\|sessionStorage\|indexedDB\|IndexedDB" packages/web/src/lib/crypto packages/web/src/components/identity`
  doit retourner **0 hit** sur les fichiers code.
- `grep -RIn "password" packages/web/src/lib/crypto packages/web/src/components/identity`
  ne doit jamais montrer `console.log(password)` ni
  `throw new Error(...password...)`.

### Tests

- Unit : `packages/web/tests/unit/crypto/identity-store.test.ts`
  couvre set / get / clear (wipe des bytes) + singleton.
- Hook + dialog : pas de tests unit en l'état (le hook fait des
  appels libsodium WASM + `fetch` réel, le setup `@testing-library/react`
  n'est pas câblé en phase 2). Les scénarios sont posés en TODO sous
  `docs/tests/e2e-tests.md` pour la phase d'E2E.

## Composants UI sealed (phase 4 wave B)

Trois composants React partagés vivent sous
`packages/web/src/components/sealed/` :

- `<SealedInput resourceId accessKey onSealed>` — pose un textarea
  `autocomplete="off"`/`spellcheck=false`, fetche la default recipient
  list (§4.4) via `/api/crm/v1/resources/:rId/access/:key/recipients`,
  affiche un fingerprint + (optionnel) `user_id` par recipient avec
  une checkbox pour désactiver un destinataire (override §4.4). À la
  validation, encode UTF-8 → `sealForRecipients(...)` → `onSealed(blob)`.
  **ZK invariant** : après `onSealed`, les bytes cleartext sont
  écrits à 0 dans le buffer (`bytes.fill(0)`) et le state du textarea
  est vidé. Aucun localStorage/sessionStorage/IndexedDB n'est touché —
  vérifié par tests (`tests/unit/components/sealed.test.tsx` spy sur
  `Storage.prototype.setItem`).

- `<SealedReveal blob mode="reveal"|"copy" autoHideMs?>` — utilise
  `identityStore.get()` (Phase 2) pour récupérer la sk déballée,
  appelle `unsealAs(blob, fp, kp)`. En mode `copy` : copie via
  `navigator.clipboard.writeText` puis wipe. En mode `reveal` :
  affiche le cleartext avec auto-hide (default 30 000 ms). Surface
  `not_a_recipient` / `identity_locked` sans logger le payload.

- `<SealedView blob label?>` — variante read-only : affiche
  `"sealed for N recipients"` + bouton Reveal qui ouvre un
  `<SealedReveal mode="reveal">` inline.

Hook utilitaire `useDefaultRecipients(resourceId, accessKey)`
(`packages/web/src/lib/sealed/use-default-recipients.ts`) : cache
module-level (TTL 60 s), pas de localStorage ; la liste se rebuilds à
chaque tab. Helper `__resetDefaultRecipientsCache()` pour les tests.

Tests : `packages/web/tests/unit/components/sealed.test.tsx`
(10 scénarios). Le mock vi.mock sur `@crm/core/crypto` capture le
buffer d'entrée pour vérifier que `bytes.fill(0)` a bien été appelé
(ZK wipe). `vitest.config.ts` mappe `tests/unit/components/**` sur
l'environment `jsdom`.

## Reste à livrer

- Banner UI "X blobs need re-sealing" + endpoint `/needs-reseal`
  (spec §4.5, phase 5+).
- Flow `lost password` complet (spec §4.7, partiellement Phase 4
  wave C avec le sweeper `recipients_stale`).
