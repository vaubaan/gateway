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
  - packages/web/src/lib/crypto/identity-store.ts
  - packages/web/src/lib/crypto/use-user-identity.ts
  - packages/web/src/components/identity/UnlockIdentityDialog.tsx
  - packages/web/src/components/identity/IdentityGate.tsx
  - packages/web/src/components/identity/SignOutButton.tsx
  - packages/web/src/app/(protected)/layout.tsx
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

## Reste à livrer

- Composant `<SealedInput>` qui scelle au moment du `put` Access
  (phase 4).
- Banner UI "X blobs need re-sealing" + endpoint `/needs-reseal`
  (spec §4.5, phase 4).
- Flow `lost password` complet (spec §4.7).
