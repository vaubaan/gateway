---
title: Audit log — schéma, mutations, lecture, rétention
tracks: []
last_reviewed: 2026-05-21
---

# Audit log — handbook

Document l'implémentation effective de la table `public.audit_log`
(spec §3.1, §9), son alimentation (toute mutation CRM doit y écrire),
sa lecture (members de l'org), et sa rétention.

## Statut courant

**Pas encore implémenté.**

Le scaffold v1 init livre :

- La table `public.audit_log` dans
  `supabase/migrations/1000_provider_resource_manager.sql` avec :
  - `id`, `organization_id`, `actor_user_id`, `action`, `scope`,
    `subject`, `at`,
  - Les indices `audit_log_org_at_idx` (org + at desc) et
    `audit_log_action_idx`.
- Une seule policy RLS : `audit_log_select_member` (lecture seule
  pour les members de l'org). **Aucune policy d'écriture** —
  l'insertion se fait obligatoirement via service-role côté server
  (spec §9 : "pas de mutation depuis l'UI").

**Aucun writer applicatif n'existe :**

- Pas de helper `appendAudit()` côté server.
- Aucun endpoint REST n'écrit dans `audit_log` (parce qu'aucun
  endpoint métier n'existe encore).
- Pas de page `/orgs/:slug/audit?subject=cloud-resource-manager`
  (spec §11.1).

## Décisions amont

- Le client (browser) ne peut **pas** écrire dans `audit_log` —
  uniquement le serveur via service-role. C'est l'inverse exact du
  pattern habituel RLS (qui laisse l'utilisateur insérer dans les
  tables qui l'intéressent) et c'est délibéré (spec §10 : audit
  immuable côté client).
- Conservation indéfinie en v1 (spec §9 : "purge à faire
  ultérieurement"). À reconsidérer si la table dépasse 10M rows.

## Spec de référence

- `docs/spec/cloud-resource-manager.md` §3.1 — schéma table.
- `docs/spec/cloud-resource-manager.md` §9 — actions canoniques et
  format JSON de l'entrée.
- `docs/spec/cloud-resource-manager.md` §10 — "no cleartext logs"
  (les sealed_blob ne doivent jamais apparaître dans `subject`).
- `docs/spec/cloud-resource-manager.md` §11.1 — page UI audit.

## Actions à logger (référence)

Liste à compléter au fil des phases (spec §3.1 commentaire) :

- `resource.registered`, `resource.provisioned`,
- `resource.access.put`, `resource.access.rotated`,
  `resource.access.resealed`,
- `resource.access.read` (chaque get effectif),
- `mcp_config.regenerated`,
- `secret_manager.added`, `secret_manager.removed`,
- `cloud_resource_map.exported`, `env.exported`, `mcp.exported`,
- `crypto.identity.created`, `crypto.identity.rotated` (lost
  password §4.7).

## Roadmap d'implémentation

Phase 2-7 incrémentale (chaque phase ajoute ses actions au fur et à
mesure). Phase 1 init = pose le squelette.

Ce handbook sera rempli au fil de l'implémentation.
