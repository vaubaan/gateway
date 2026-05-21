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
  mémoire de la sk déballée.
- Composant `<SealedInput>` qui scelle au moment du `put` Access.
- Banner UI "X blobs need re-sealing" + endpoint `/needs-reseal`
  (spec §4.5).
- Flow `lost password` côté UI (la backend route gère déjà le
  `replace=true` ; il manque le wiring browser + le re-seal des blobs
  staled).

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

> **TODO(phase-4)** : à la suite d'un `replace-identity`, il faut
> repérer les `resource_access` rows où l'ancien fingerprint apparaît
> comme recipient et les marquer `recipients_stale = true` (spec §4.7
> étape 4). Le champ `subject.old_fingerprint` du log audit sert de
> seed pour ce sweeper, qui arrivera avec la table `resource_access`
> en phase 4.

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

## Browser flow

À venir wave B (hooks React `useCryptoIdentity`, composant
`<SealedInput>`). La logique côté browser orchestrera :

1. **First login** : appelle `GET /me/crypto-key`. Si 404, génère
   une keypair locale (`generateUserKeypair`), dérive la KEK
   (`deriveKEK(password, randomSalt)`), wrap la sk
   (`wrapPrivateKey(sk, kek)`), puis POSTe au endpoint. Si 200,
   `unwrapPrivateKey(wrappedSk, deriveKEK(password, salt))`.
2. **Password rotation** : reçoit confirmation de
   `/me/password { old, new }`, derive `new_kek` avec un nouveau salt,
   re-wrap la sk en mémoire, PATCH sans `replace`.
3. **Lost password** : après reset email Supabase, génère une keypair
   neuve et PATCH avec `replace: true`. Banner UI "vos blobs sont
   inaccessibles tant qu'un admin n'a pas re-sealé".
