---
title: Greenfield rip-and-replace — pas de dual-write, pas de migration de données
status: accepted
date: 2026-05-21
author: rpelissier
tracks:
  - docs/spec/cloud-resource-manager.md
  - supabase/migrations/1000_provider_resource_manager.sql
---

# Greenfield rip-and-replace : pas de dual-write, pas de migration

## Contexte

Le Cloud Resource Manager (CRM) succède à un sous-système Vauban v2
qui gérait les credentials sous forme de tables `org_services`,
`project_services`, `credential_blobs`, `project_manifests.services`,
plus un host de plugins (`plugin-service-*`, `plugin-host-*`) et des
exports `.env` / `.mcp.json` runtime ad-hoc. L'archive vit dans
`/home/dev/vauban/legacy/` (cf. note d'ancestry de la spec).

Quand on lance un nouveau modèle de domaine (Resource au lieu de
Service, ResourceKind au lieu de ServicePlugin, sealed_blob
multi-recipient au lieu de blobs symétriques per-service), la question
classique se pose :

- **Migrer les données v2 → v3 ?** Mapper `org_services` vers
  `resources`, dériver le `kind`, re-seal les credentials...
- **Dual-writer pendant N semaines ?** Toute mutation côté v2 est
  répliquée côté v3, on bascule la lecture quand la parité est
  atteinte, puis on retire v2.
- **Rip & replace ?** On arrête v2, on ouvre v3 vide, les users
  ré-onboardent leurs Resources.

Chaque approche a un coût mesuré en semaines × developers et un coût
opérationnel (windows de freeze, incidents pendant la transition).

## Décision

On adopte le **rip-and-replace greenfield** : la spec §13 le documente,
cette ADR le formalise.

- **Base de données** : le schéma v2 a déjà été drop (cf. infra brief
  init : "public schema reset, 0 tables, 0 RLS, 0 custom types") avant
  l'application de `supabase/migrations/1000_provider_resource_manager.sql`.
  Aucune row v2 n'est conservée.
- **Code legacy** : la nouvelle implémentation vit dans un _autre repo_
  (`cloud-resource-manager`), pas dans une branche de l'ancien Vauban.
  Pas de dépendance circulaire, pas de namespace partagé.
- **Plugins legacy** (`plugin-service-github`, `plugin-host-*`) : ne
  sont _pas_ portés. Les ResourceKind concrets seront récrits from
  scratch dans une phase ultérieure dans `packages/crm-catalog/`.
- **Onboarding** : la première org en v3 ré-enregistre ses Resources
  manuellement (paste PAT → seal côté browser → PUT). Pas d'import
  automatique depuis v2.
- **No dual-write** : pas d'écriture parallèle vers v2 et v3. v2 est
  read-only (et n'est même pas accessible depuis ce repo).

## Conséquences

### Positives

- **Code clean** : pas de couche de compat, pas de mapper, pas de
  `if (legacyMode)`. Le code v3 lit la spec, pas l'historique.
- **Crypto cohérente d'emblée** : tous les sealed_blob sont au format
  v=1 multi-recipient (§4.3) dès la première insertion. Pas de
  cohabitation avec d'anciens blobs symétriques per-service qu'il
  faudrait re-encoder.
- **Pas de window de migration risquée** : pas de "ce week-end on
  bascule", pas de risque de leak pendant la transition.
- **Spec implicite vérifiable** : la migration §13 est purement
  declarative ("drop old, create new") ; pas de chemin alternatif
  legacy à tester.
- **Coût upfront raisonnable** : ré-onboarder ~10 Resources prend
  ~30 minutes par org (paste PAT × N, seal). Pour la taille cible
  v1 (1-3 orgs internes), c'est négligeable.

### Négatives / contraintes

- **Friction pour les users existants** : chacun doit retrouver/régénérer
  ses PAT et les paster. Pour les orgs qui avaient 50+ services, ça
  pique. Mitigé par la doc d'onboarding (à venir, hors-scope init).
- **Pas de fallback** : si v3 a un bug critique en prod, on ne peut pas
  "revenir à v2" — v2 n'est plus déployé. Mitigation : staging absent
  en v1 mais ajout possible avant onboarding d'orgs externes.
- **Perte de l'historique audit v2** : les `audit_log` rows v2 ne sont
  pas migrées. Acceptable car la rétention v2 était courte (90 jours)
  et l'usage forensique est faible.
- **L'archive v2 reste consultable** : `~/vauban/legacy/` est gardée
  comme référence (anciens schémas, runbooks, traces de décisions
  implicites). Le code n'est pas absorbé, mais peut être lu si un
  point obscur de la spec demande clarification.

## Alternatives rejetées

### Migration de données v2 → v3 automatique

Il faudrait :

- Réveiller v2 (read-only) ⇒ infra à maintenir le temps de la migration.
- Mapper `org_services` ↔ `resources` (schémas divergents : kindClass
  n'existait pas, scope `org`/`project` était implicite).
- **Re-sealer chaque cred** côté admin browser (les blobs v2 étaient
  chiffrés autrement). Demande chaque user à se connecter ⇒ revient
  au même que ré-onboarder à la main.
- Bénéfice : éviter la friction users existants. Coût : 2-3 semaines
  d'ingénierie pour un one-shot. Pas un bon ratio pour une cible v1
  petite.

### Dual-write pendant 2 semaines

Approche canonique migration zero-downtime, mais :

- v2 et v3 ont des modèles incompatibles (Service vs Resource) ; le
  dual-writer doit invertir le sens à chaque mutation, c'est du code
  jetable très intriqué.
- Sécurité hard : un blob écrit en v2 (symétrique) doit être traduit
  en v3 (multi-recipient sealed-box) — demande la sk du user en clair
  côté Core. Casse §2.3.

### Maintenance parallèle v2 et v3 (multi-version)

Acceptable pour une lib publique, pas pour un produit interne mono-tenant
(en v1). Doublerait le coût ops et stockage. Aucun bénéfice utilisateur.

## Références

- `docs/spec/cloud-resource-manager.md` §0 (note de filiation v2),
  §13 (plan de cutover détaillé), §1.1 (hors-scope explicite),
  §14.1 (décisions figées).
- Build plan `.claude/build-plans/init.json` (contexte init :
  "Toutes les tables legacy ont déjà été drop").
- Archive v2 : `https://github.com/sbw-vauban/vauban/tree/main/legacy`
  (consultable, non importée).
