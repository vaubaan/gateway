---
title: Crypto zero-knowledge — keypair, sealing, unsealing, re-seal
tracks: []
last_reviewed: 2026-05-21
---

# Crypto zero-knowledge — handbook

Document l'implémentation effective de la couche cryptographique ZK
(spec `docs/spec/cloud-resource-manager.md` §4) : génération de la
keypair X25519 par user, dérivation Argon2id de la KEK, wrap/unwrap
de la sk, scellement multi-recipient, recipient list, re-seal sur
membership change.

## Statut courant

**Pas encore implémenté.**

Le scaffold v1 init (commit phase-0-bootstrap) livre :

- la table `public.user_crypto_keys` dans
  `supabase/migrations/1000_provider_resource_manager.sql` (colonnes
  `public_key`, `wrapped_private_key`, `kdf_salt`, `kdf_params`),
- la table `public.resource_access` qui hébergera les `sealed_blob`
  (cf. spec §3.1, §4.3),
- l'interface `SealedBlob` (v=1, multi-recipient) dans
  `packages/crm-catalog/src/secret-manager.ts`.

Aucun code runtime n'est encore livré :

- Pas de wrapper `libsodium-wrappers` (la dépendance n'est pas dans
  `packages/web/package.json` à ce jour).
- Pas de helper `seal()` / `unseal()` / `wrapSk()` / `unwrapSk()`.
- Pas de hook React `useCryptoIdentity()`.
- Pas d'endpoint `/api/crm/v1/me/crypto-key`.
- Pas de composant `<SealedInput>`.
- Pas de banner "X blobs need re-sealing" (§4.5).

## Décisions amont (lecture obligatoire)

- ADR `docs/decisions/crypto-libsodium-sealed-box-multi-recipient.md`
  — choix de la primitive et du format on-disk.
- ADR `docs/decisions/single-keypair-per-user.md` — 1 keypair par
  user, multi-device via `wrapped_sk` redistribué.

## Spec de référence

- `docs/spec/cloud-resource-manager.md` §2.3 (invariant ZK).
- `docs/spec/cloud-resource-manager.md` §4.0 → §4.9 (mécanismes
  détaillés).

## Roadmap d'implémentation

Hors-scope de la phase init. La phase 2 du roadmap (cf.
`.claude/build-plans/init.json` `out_of_scope_for_init`) livre :

- Endpoints `/api/crm/v1/me/crypto-key` (GET / PUT).
- Helpers `seal()` / `unseal()` browser + Runner.
- Le composant `<SealedInput>` React.
- Le banner re-seal + l'endpoint `/needs-reseal`.
- Tests unitaires (round-trip, refus de wrap avec salt rejoué, etc.).

Ce handbook sera rempli au fil de l'implémentation ; la liste `tracks:`
sera étendue au moment du premier commit code.
