---
title: Catalogue de ResourceKinds et plugins providers
tracks: []
last_reviewed: 2026-05-21
---

# Catalogue de ResourceKinds et plugins providers — handbook

Document l'implémentation effective du catalogue
`@crm/catalog` : contrats `ResourceKind` / `OrgResourceAdminKind`
(spec §5.1), et les implémentations concrètes par provider (GitHub,
Vercel, Supabase).

## Statut courant

**Pas encore implémenté.**

Le scaffold v1 init livre uniquement les _types_ :

- `packages/crm-catalog/src/resource-kind.ts` — interfaces
  `ResourceKind` + `OrgResourceAdminKind`, discriminator `KindClass`,
  enum `RotationMethod`, supporting types (`AccessKeySpec`,
  `McpServerFragment`, `ProviderChild`).
- `packages/crm-catalog/src/index.ts` — barrel d'export type-only.
- `packages/crm-catalog/tests/unit/types.test.ts` — surface
  vérifiée via `expectTypeOf` (8 tests).

**Aucun provider n'est implémenté.** Il n'existe pas encore de fichier
`packages/crm-catalog/src/providers/github/*.ts`, ni de constante
`CATALOG: ResourceKind[]`. L'endpoint `/api/crm/v1/catalog` n'existe
pas.

## Décisions amont

- Le package livre des _types_ en v1 init — pas d'implémentation
  provider. La justification est dans le build plan
  `.claude/build-plans/init.json` (deliverables phase 0).
- Les 3 `kindClass` distincts (`org`, `project`, `org-admin`) sont
  un choix de contrat figé par la spec §5.1.

## Spec de référence

- `docs/spec/cloud-resource-manager.md` §5.1 — contrat
  `ResourceKind`.
- `docs/spec/cloud-resource-manager.md` §5.3 — layout attendu de
  `packages/crm-catalog/src/providers/<name>/`.
- `docs/spec/cloud-resource-manager.md` §0.1 — rotation methods.

## Roadmap d'implémentation

Phase 3 du roadmap (cf. build plan `out_of_scope_for_init`) :

- Implémentation GitHub : `github-org` + `github-org-admin` (manages
  `github-repo`) + `github-repo`.
- Implémentation Vercel : `vercel-team` + `vercel-team-admin` (manages
  `vercel-project`) + `vercel-project`.
- Implémentation Supabase : `supabase-org` + `supabase-org-admin`
  (manages `supabase-project`) + `supabase-project`.
- Tests unitaires §12.1 par kind.
- Test structural §12.4 qui parse le schéma TS et refuse les drifts.

Ce handbook sera rempli au fil de l'implémentation.
