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
  - packages/web/src/app/api/crm/v1/resources/[rId]/access/[key]/recipients/route.ts
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

**Livré dans wave B** :

- Endpoint `GET /api/crm/v1/resources/:rId/access/:key/recipients`
  (default list, cf. section "Recipient list endpoint" plus bas).

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
  nom/email à côté de chaque fingerprint au moment du seal (TOFU
  - validation visuelle, §4.4). Le champ est `optional` au schéma
    pour anticiper la phase 5 où le Runner figurera dans la liste sans
    `user_id` (mais avec un `runner_id` à terme).
- `Cache-Control: no-store` sur toutes les réponses : les
  memberships peuvent changer à tout moment, on ne veut pas servir
  une liste périmée depuis un cache intermédiaire.

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
6. Compose `orgMembers: PubKeyEntry[]` (en excluant les members
   sans `user_crypto_keys` row — pas encore d'identité crypto, donc
   pas recipients).
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

Unit tests sous
`packages/web/tests/unit/api/recipients.test.ts` (mocks le client
Supabase) couvrent :

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

## Browser flow + API endpoints

À venir wave B. Ce handbook sera ré-écrit (sections "Bootstrap au
login", "Use d'un Access", "Re-seal") quand les hooks React et les
endpoints `/me/crypto-key` arrivent.
