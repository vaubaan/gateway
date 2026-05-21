---
title: Provisioning et Rotation — workflows browser-side
tracks: []
last_reviewed: 2026-05-21
---

# Provisioning et Rotation — handbook

Document l'implémentation effective des workflows de provisioning
(via un Admin) et de rotation (3 paths : `self`, `admin-mediated`,
`manual`). Spec §0.1, §6.5, §7.3, §7.4.

## Statut courant

**Pas encore implémenté.**

Le scaffold v1 init livre :

- La colonne `resources.admin_resource_id` (`ON DELETE SET NULL`,
  spec §14.1) et la contrainte CHECK qui force `admin_resource_id`
  uniquement sur les Resources de `scope='project'`.
- La colonne `resources.is_admin` + l'index partiel
  `resources_org_admins_idx where is_admin`.
- Le contrat TypeScript `OrgResourceAdminKind` dans
  `packages/crm-catalog/src/resource-kind.ts` (`listChildren`,
  `createChild`, `destroyChild`, `rotateChildAccess`).
- L'enum `RotationMethod = 'self' | 'admin-mediated' | 'manual'`.

**Aucun workflow runtime n'existe** :

- Endpoint `/api/crm/v1/orgs/:orgId/resources/:adminId/provision`
  (spec §6.5) — absent.
- Endpoint `/destroy-cloud-resource` — absent.
- Endpoint `/access/:key/rotate` (spec §6.4) — absent.
- Helper browser-side qui appelle les APIs provider via CORS
  (spec §7.3) — absent.

## Décisions amont

- "Vauban Core ne touche jamais aux APIs Provider qui demandent
  des creds" (spec §5.1, §7) — implémentation browser-only.
- Les Accesses d'`OrgResourceAdmin` ne sont jamais sealed pour le
  Runner (convention §4.4) — c'est le gate qui empêche un cred
  admin-tier d'arriver en env var dans une Coding Session.

## Spec de référence

- `docs/spec/cloud-resource-manager.md` §0.1 — 3 rotation paths.
- `docs/spec/cloud-resource-manager.md` §5.1 — contrat
  `OrgResourceAdminKind`.
- `docs/spec/cloud-resource-manager.md` §6.5 — endpoints
  provisioning.
- `docs/spec/cloud-resource-manager.md` §7.3 — workflow
  provisioning.
- `docs/spec/cloud-resource-manager.md` §7.4 — workflow rotation.

## Roadmap d'implémentation

Phase 6 du roadmap (cf. build plan `out_of_scope_for_init`) :

- Endpoint REST `/provision` + `/destroy-cloud-resource`.
- Endpoint `/access/:key/rotate` + dispatcher selon
  `rotationMethod`.
- Helpers browser-side qui font les round-trips provider (via
  CORS) en utilisant l'Access unsealed transitoirement.
- E2E §12.3 contre vrais clouds (GitHub, Vercel, Supabase).

Ce handbook sera rempli au fil de l'implémentation.
