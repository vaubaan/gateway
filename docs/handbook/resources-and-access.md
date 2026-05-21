---
title: Resources et resource_access — CRUD, RLS, audit
tracks: []
last_reviewed: 2026-05-21
---

# Resources et resource_access — handbook

Document l'implémentation effective des tables `public.resources` et
`public.resource_access` (spec §3.1), les endpoints REST `/api/crm/v1`
(spec §6.3-§6.4), et leur écriture/lecture côté UI.

## Statut courant

**Pas encore implémenté.**

Le scaffold v1 init livre :

- Le schéma SQL des deux tables avec contraintes (slug regex,
  `scope in ('org', 'project')`, admin-only-on-project, etc.).
- Les indices §3.2 : `resources_org_scope_provider_kind_idx`,
  `resources_project_kind_variant_idx`, `resources_org_admins_idx`,
  `resource_access_resource_idx`.
- Les policies RLS (4 par table, member R, admin RW).
- Le trigger `set_updated_at()` sur `resources.updated_at`.

**Aucun endpoint REST.** Aucune route handler `app/api/crm/v1/*`
n'existe encore. Aucune page UI `app/organizations/[slug]/resources/*`
n'existe.

## Décisions amont

- ADR `docs/decisions/rls-minimaliste-2-roles.md` — politique RLS
  member/admin uniquement, granularité fine via crypto.

## Spec de référence

- `docs/spec/cloud-resource-manager.md` §3.1 — schéma des tables.
- `docs/spec/cloud-resource-manager.md` §3.2 — indices.
- `docs/spec/cloud-resource-manager.md` §3.3 — RLS matrix.
- `docs/spec/cloud-resource-manager.md` §6.3-§6.4 — endpoints REST.
- `docs/spec/cloud-resource-manager.md` §7.1-§7.4 — workflows.
- `docs/spec/cloud-resource-manager.md` §11 — UX (pages, patterns).

## Roadmap d'implémentation

Phase 4 du roadmap (cf. build plan `out_of_scope_for_init`) :

- Endpoints REST §6.3 (CRUD resources) et §6.4 (CRUD access).
- Pages `/orgs/:slug/resources` (listing), `/resources/new` (wizard),
  `/resources/:rId` (détail), `/projects/:name/resources`.
- Composant `<SealedInput>` (couplé au handbook `crypto-zk.md`).
- Tests d'intégration §12.2 (RLS, recipient list, audit log).

Ce handbook sera rempli au fil de l'implémentation.
