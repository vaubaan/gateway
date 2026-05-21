---
title: SecretManagers — Infisical et stubs Vault / 1Password
tracks: []
last_reviewed: 2026-05-21
---

# SecretManagers — handbook

Document l'implémentation effective de l'interface `SecretManager`
(spec §5.2), du plugin Infisical built-in, et de la table
`public.secret_managers` (spec §3.1).

## Statut courant

**Pas encore implémenté.**

Le scaffold v1 init livre :

- L'interface `SecretManager` dans
  `packages/crm-catalog/src/secret-manager.ts` (4 méthodes
  `get / list / put / revoke`, plus le type `SealedBlob`).
- La table `public.secret_managers` dans
  `supabase/migrations/1000_provider_resource_manager.sql` avec :
  - `kind text` (discriminator : `infisical` | `vault` | `1password`),
  - `auth_sealed_blob bytea` (token machine-identity sealed
    multi-recipient pour les admins + Runner),
  - Index partiel unique `secret_managers_one_default_per_org`.
- Les policies RLS (admin RW, member R).

**Aucune implémentation de plugin n'est livrée** :

- Pas de classe `InfisicalSecretManager`.
- Pas d'endpoints `/api/crm/v1/orgs/:orgId/secret-managers` (spec §6.2).
- Pas de wizard UI pour ajouter un SM.

## Décisions amont

- ADR `docs/decisions/secret-manager-infisical-v1.md` — pourquoi
  Infisical en v1, autres backends en stubs.

## Spec de référence

- `docs/spec/cloud-resource-manager.md` §3.1 — table
  `secret_managers`.
- `docs/spec/cloud-resource-manager.md` §4.8 — backends "managed"
  hors-scope v1.
- `docs/spec/cloud-resource-manager.md` §5.2 — contrat `SecretManager`
  partagé avec le CAR.
- `docs/spec/cloud-resource-manager.md` §6.2 — endpoints REST.

## Roadmap d'implémentation

Phase 5 du roadmap (cf. build plan `out_of_scope_for_init`) :

- Plugin `InfisicalSecretManager` (paths `/<resourceId>/<accessKey>`,
  token machine-identity unsealed transitoirement en mémoire).
- Endpoints REST §6.2.
- Wizard UI sur `/orgs/:slug/secret-managers`.
- Stubs `VaultSecretManager` / `OnePasswordSecretManager` qui
  throw `NotImplemented`.

Ce handbook sera rempli au fil de l'implémentation.
