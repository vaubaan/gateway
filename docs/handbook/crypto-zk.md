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

**Reste à livrer** (wave B et au-delà) :

- Endpoints `/api/crm/v1/me/crypto-key` (GET / PUT).
- Hook React `useCryptoIdentity()` qui orchestre bootstrap + cache
  mémoire de la sk déballée.
- Composant `<SealedInput>` qui scelle au moment du `put` Access.
- Banner UI "X blobs need re-sealing" + endpoint `/needs-reseal`
  (spec §4.5).
- Flow `lost password` complet (spec §4.7).

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

| `isOrgAdminResource` | `runner` | recipients résultat       |
| -------------------- | -------- | ------------------------- |
| `false`              | absent   | `orgMembers`              |
| `false`              | présent  | `orgMembers ∪ {runner}`   |
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

## Browser flow + API endpoints

À venir wave B. Ce handbook sera ré-écrit (sections "Bootstrap au
login", "Use d'un Access", "Re-seal") quand les hooks React et les
endpoints `/me/crypto-key` arrivent.
