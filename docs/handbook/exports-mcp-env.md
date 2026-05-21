---
title: Exports — .env, mcp.json, cloud-resource-map
tracks: []
last_reviewed: 2026-05-21
---

# Exports — .env, mcp.json, cloud-resource-map — handbook

Document l'implémentation effective des 3 exports CRM (spec §6.7,
§1 paragraphe 7) :

- Export `.env` (placeholders ou unsealed côté browser).
- Export `mcp.json` + `.env` compagnon.
- Export `cloud-resource-map.json` consommé par le CAR.

## Statut courant

**Pas encore implémenté.**

Le scaffold v1 init livre :

- La table `public.mcp_configs` (spec §3.1) avec son index unique
  `mcp_configs_unique_scope` (NULLS NOT DISTINCT pour collisionner
  les `(project_id NULL, variant NULL)`).
- Les policies RLS (admin RW, member R).
- Le type `McpServerFragment` dans
  `packages/crm-catalog/src/resource-kind.ts`.

**Aucun endpoint export n'existe :**

- `/api/crm/v1/orgs/:orgId/exports/env` (spec §6.7) — absent.
- `/api/crm/v1/orgs/:orgId/exports/mcp` — absent.
- `/api/crm/v1/orgs/:orgId/exports/cloud-resource-map` — absent.
- `/api/crm/v1/orgs/:orgId/mcp-configs/regenerate` (spec §6.6) —
  absent.

Aucune UI d'export (`/orgs/:slug/projects/:name/exports`) n'existe.

## Décisions amont

- Les exports renvoient toujours des sealed_blobs ; jamais de
  cleartext servi par une route Vauban (cf. spec §6.7, §10). C'est
  une conséquence directe de l'invariant ZK formalisé dans
  `docs/decisions/crypto-libsodium-sealed-box-multi-recipient.md`.

## Spec de référence

- `docs/spec/cloud-resource-manager.md` §1 (vision exports).
- `docs/spec/cloud-resource-manager.md` §6.6 — MCPConfigs API.
- `docs/spec/cloud-resource-manager.md` §6.7 — Exports API.
- `docs/spec/cloud-resource-manager.md` §6.7.1 — schéma
  `cloud-resource-map`.
- `docs/spec/cloud-resource-manager.md` §7.5 — workflow d'export
  `.env` pour `(project, variant)`.

## Roadmap d'implémentation

Phase 7 du roadmap (cf. build plan `out_of_scope_for_init`) :

- Endpoints REST §6.6 et §6.7.
- Logique de filtrage `(scope, scopeId, variant)` côté server :
  union des Resources visibles, jointure `resource_access`, sortie
  liste de sealed_blobs.
- Côté browser : helper `decryptExportBundle()` qui unseal + écrit
  le fichier (placeholder pour les blobs où l'user n'est pas
  recipient).
- Pages `/exports` avec sélecteur de variant.

Ce handbook sera rempli au fil de l'implémentation.
