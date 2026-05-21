---
title: Une seule keypair X25519 par user, multi-device via wrapped_sk redistribué
status: accepted
date: 2026-05-21
author: rpelissier
tracks:
  - docs/spec/cloud-resource-manager.md
  - supabase/migrations/1000_provider_resource_manager.sql
---

# Une keypair X25519 par user, partagée multi-device via wrapped_sk

## Contexte

La spec §4.1 fige l'identité crypto d'un user Vauban. Trois questions
arrivent immédiatement :

1. **Une keypair, ou une par device ?** Un user a typiquement 2-4
   devices (browser laptop, browser mobile, future CLI, futur clipper
   mobile). Doit-il avoir 1 identité crypto unique, ou N identités
   indépendantes ?
2. **Comment partager la sk entre devices ?** Sans synchronisation, un
   nouveau device ne peut pas déchiffrer un blob déjà sealé.
3. **Quel modèle de révocation par device ?** Si je perds mon laptop,
   comment je révoque l'accès _uniquement_ à cette machine ?

Ces choix conditionnent toute la mécanique re-seal (spec §4.5) : avec
N keypairs par user, la recipient list explose linéairement et chaque
add-device forcerait un re-seal global.

## Décision

On adopte **une seule keypair X25519 par user**, dérivée à la première
authentification et persistée dans `public.user_crypto_keys`.

- La **clé privée** est wrappée avec une KEK dérivée du mot de passe
  Vauban via Argon2id (m=64MiB, t=3, p=1) — le wrap utilise
  `crypto_secretbox` (XChaCha20-Poly1305).
- Chaque device (browser, futur CLI, futur mobile) :
  - pull `(public_key, wrapped_private_key, kdf_salt)` au login,
  - dérive la KEK localement avec le password de l'user,
  - unwrap la sk en mémoire pour la session,
  - **ne la ré-upload jamais en clair**.
- **Pas de table `user_crypto_devices`**, pas de revocation per-device.
  Un device compromis ⇒ identité user compromise ; la parade canonique
  est `password rotation` (§4.6) qui invalide tous les `wrapped_sk` du
  user à la prochaine fetch des autres devices.

## Conséquences

### Positives

- **Recipient list courte et stable** : pour 50 users + 1 Runner, c'est
  51 entrées par blob — pas 50 × N_devices. Le re-seal sur membership
  change reste rapide (~50 ms par blob).
- **Onboarding trivial du Nème device** : un user qui ouvre Vauban sur
  un nouveau browser entre password → tout marche, sans QR-code, sans
  approval admin, sans bootstrap re-seal.
- **Schéma DB simple** : une row `user_crypto_keys` par user, indexée
  par `user_id`. Pas de jointure `(user_id, device_id)` à porter dans
  toute la chaîne `recipient_list`.
- **Aligné sur la convention 1Password / Bitwarden** : le mental model
  utilisateur ("mon mot de passe maître unlock tout") est largement
  intuitif.

### Négatives / contraintes

- **Pas de révocation granularité device** : si je perds mon laptop
  _sans_ compromission de mot de passe (cas rare mais réel), je ne
  peux pas révoquer uniquement ce device. La contre-mesure est de
  _rotater_ le mot de passe (qui invalide le wrap et force tous les
  devices à re-fetch et re-unwrap, ce qu'un voleur sans password ne
  peut pas faire).
- **Compromis de mot de passe = compromis crypto total** : un attaquant
  qui obtient password + un dump SQL peut déchiffrer tout ce que l'user
  a accès. Mitigations :
  - Argon2id rend le brute-force coûteux (64 MiB de mémoire).
  - Auth Supabase bcrypt en amont (un attaquant qui a le password n'a
    pas forcément l'accès SQL).
  - Le flow lost-password (§4.7) ne récupère _rien_ : il génère une
    nouvelle keypair et l'user perd l'accès à ses blobs (jusqu'à
    re-seal par un autre admin).
- **Pas de PFS au niveau crypto** : un compromis futur de la sk laisse
  lire tout l'historique. Acceptable car les Access sont rotables au
  niveau Provider (§7.4), ce qui est _la_ vraie révocation.

## Alternatives rejetées

### Une keypair par device (modèle Signal/WhatsApp Web)

Avantages : révocation par device, "j'ai perdu mon téléphone, je
révoque" est natif. Inconvénients qui ont fait pencher la balance :

- Recipient list **3-5× plus longue** par blob ; le re-seal devient
  un workload non-négligeable (~250 ms par blob sur la cible).
- Onboarding du 2ème device demande soit (a) un QR-code scan
  cross-device (UX lourde, exige les deux devices en ligne en même
  temps), soit (b) un re-seal admin-mediated pour pusher la pubkey du
  nouveau device sur tous les blobs. Les deux complexifient
  significativement le code.
- L'organisation `user_crypto_keys` devient `user_crypto_keys(device_id, user_id, public_key, …)` et toutes les queries de recipient list doivent grouper par user.
- **Reconsidérable en v2** : la spec §4.1.1 documente explicitement
  cette alternative comme "rejetée pour v1, à revisiter si 'perdu
  mon laptop' devient un cas d'usage fréquent". On garde la porte
  ouverte.

### Garder la sk dans le seul auth.session.cookie (no DB persist)

Bricolage qui rend impossible le multi-device sans login fresh →
casse l'usage CLI / mobile. Disqualifié dès la phase de spec.

### Custodial keypair (Vauban Core génère et garde la sk en HSM)

Casse l'invariant ZK §2.3 : un opérateur Core compromis lit tout.
C'est _exactement_ ce qu'on essaie d'éviter.

### Passphrase distincte du password Vauban

Ajoute un secret de plus à gérer ; spec §4.1 conclut "pas de
passphrase distincte. Le mot de passe Vauban sert à la fois à l'auth
et à la dérivation du KEK". Friction utilisateur > bénéfice.

## Références

- `docs/spec/cloud-resource-manager.md` §4.1, §4.1.1, §4.6, §4.7.
- ADR `crypto-libsodium-sealed-box-multi-recipient.md`.
- Schéma DB : `supabase/migrations/1000_provider_resource_manager.sql`
  table `public.user_crypto_keys`.
