---
title: libsodium sealed-box NaCl multi-recipient — pas de DEK envelope en v1
status: accepted
date: 2026-05-21
author: rpelissier
tracks: []
---

# libsodium sealed-box NaCl multi-recipient, sans DEK envelope en v1

## Contexte

Le CRM porte l'invariant transverse "aucun cleartext de secret ne
transite ni persiste sur Core" (spec §2.3, §4). Il faut donc une
primitive crypto utilisée à la fois côté browser (seal au moment du
PUT) et côté browser/Runner (unseal au moment du use), avec :

- une **clé publique par recipient** (user ou Runner) — chaque blob
  doit pouvoir être déchiffré par N parties listées,
- une crypto **stable, auditée, dispo en WASM** (browser) et en
  Node.js (Runner),
- une **emprise mémoire raisonnable** par blob (cf. spec §4.3 : 50
  users × 500 resources × 5 keys est la cible).

Côté primitive on a deux familles canoniques : NaCl (`crypto_box`,
`crypto_box_seal`) ou les standards JWE/JWK basés sur ECDH-ES + AES-GCM.

Côté structure on a deux choix : multi-recipient direct (un ciphertext
par recipient) ou DEK envelope (un ciphertext payload + N wrap d'une
DEK partagée).

## Décision

On utilise **libsodium-wrappers** (binding WASM officiel de
[libsodium](https://libsodium.org/)) avec **`crypto_box_seal`** comme
primitive de scellement.

- Identités : X25519 (32 bytes pub, 32 bytes priv) — cf. ADR
  `single-keypair-per-user.md`.
- Format on-disk (spec §4.3) :
  ```jsonc
  { "v": 1, "recipients": [ { "fp": "<hex16>", "ct": "<base64>" }, … ] }
  ```
- Chaque entrée `ct = crypto_box_seal(cleartext_utf8, recipient_pub)` —
  c'est-à-dire qu'on génère une keypair éphémère par chiffrement, et le
  ciphertext encode la clé publique éphémère. Le recipient déballe avec
  `crypto_box_seal_open(ct, recipient_pub, recipient_priv)`.
- **Pas de DEK envelope** en v1 : chaque blob est sealed N fois pour N
  recipients. Surcoût : N · 48 octets par blob (32 ephemeral pub + 16
  Poly1305 tag) ; sur la cible (~50 users), c'est ~6 MB total de
  ciphertext — négligeable comparé au coût d'implém + d'audit d'une
  enveloppe DEK/KEK custom.
- Pour le wrapping de la sk user par la KEK Argon2id (spec §4.1.1), on
  utilise **`crypto_secretbox`** (XChaCha20-Poly1305).

## Conséquences

### Positives

- **Sécurité bien comprise** : libsodium / NaCl est l'une des piles
  crypto les plus auditées au monde. Pas de risque de mauvaise
  configuration (curve choice, padding, mode AEAD) — toutes les
  primitives sont opinionated.
- **Browser-ready** : `libsodium-wrappers` charge un WASM ~150 KB,
  compatible avec tous les navigateurs evergreen + Edge runtime.
- **Format simple, débuggable** : le bundle est du JSON lisible (le
  ciphertext est en base64) — un opérateur peut inspecter un
  `resource_access.sealed_blob` en SQL et voir la recipient list
  _en clair_ (fingerprints), tout en restant incapable de déchiffrer.
  Utile pour spec §8 "filtrage par crypto sans bypass".
- **Pas d'invention de protocole** : on n'a pas à designer un format
  d'enveloppe DEK/KEK ; un format custom = surface d'attaque custom.

### Négatives / contraintes

- **Scaling sub-linéaire en nombre de recipients** : un re-seal sur
  membership change (spec §4.5) coûte N opérations browser. À ~50
  users c'est 0,5 sec ; à 500, ça devient sensible. La porte de
  sortie est documentée (spec §4.3 "DEK envelope en v2 si besoin").
- **Pas de PFS** : un compromis ultérieur de la sk d'un recipient
  permet de relire tous ses ciphertexts passés. C'est inhérent au
  modèle "1 keypair long-terme" ; voir ADR
  `single-keypair-per-user.md` pour la mitigation (rotation du
  mot de passe + lost-password flow).
- **Pas de mécanisme de signature inter-recipient** : on ne peut pas,
  juste avec sealed-box, prouver à Bob qu'Alice a sealé un blob (pas
  d'auth de l'émetteur). En v1 on s'appuie sur l'audit log côté Core
  pour la traçabilité ; un schéma signé sera ajouté si on a besoin
  d'attribution non-répudiable.

## Alternatives rejetées

### JWE / JOSE (ECDH-ES + AES-GCM)

Standard IETF, libs matures (`jose` npm). Mais :

- Format JOSE plus verbeux (headers JSON, encodage spécifique), pas un
  gain de débuggabilité.
- ECDH-ES exige une keypair distincte par session ; aligner ça avec
  une keypair long-terme par user demanderait un wrap supplémentaire.
- Pas de gain de sécurité sur une primitive `crypto_box` bien
  utilisée.

### DEK envelope (1 ciphertext + N wrap d'une DEK)

Optimisation classique pour des blobs gros / nombreux recipients. En
v1 :

- Le payload moyen est ~100 octets (un PAT GitHub), donc l'overhead
  multi-recipient (N · 48 octets) est dominé par les _recipients_, pas
  par le payload — un DEK n'aide presque pas.
- Ajoute une couche de format (où on stocke la DEK ? comment on la
  marque comme révoquée ?) qui demande son propre ADR + tests.
- Reporté en v2 derrière un flag de format `v: 2` une fois qu'on a
  des metrics réels.

### `age` (Filippo Valsorda)

Très propre, mais :

- L'écosystème JS est mince (`age-encryption.js` existe mais moins
  audité que libsodium).
- Les keypairs `age` peuvent encoder une X25519 mais le tooling tourne
  surtout autour de fichiers, pas de blobs JSON inline.
- Pas de bénéfice net face à libsodium pour notre usage.

### WebCrypto natif (`SubtleCrypto`)

Disponible sans dépendance mais :

- Pas de courbe X25519 portable (Curve25519 reste partiellement
  supporté ; il faut faire le ECDH "à la main" ou prendre un polyfill).
- API verbeuse, error-prone (oublier d'`importKey` au bon format).
- Pas dispo côté Runner Node.js _avant_ Node 20 sans flag — on doit
  garder la même primitive des deux côtés.

## Références

- `docs/spec/cloud-resource-manager.md` §2.3, §4.1, §4.3, §4.4, §4.5.
- ADR `single-keypair-per-user.md` (identité crypto).
- libsodium docs : [crypto_box_seal](https://doc.libsodium.org/public-key_cryptography/sealed_boxes).
- spec §14.1 (décisions figées : "pas de DEK envelope en v1").
