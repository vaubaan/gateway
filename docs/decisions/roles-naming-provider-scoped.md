---
title: Roles — naming `<provider>:<role-name>`, provider-scoped, builtin v1
status: accepted
date: 2026-05-22
---

# Roles — naming `<provider>:<role-name>`, provider-scoped, builtin v1

## Contexte

Un Role porte un bundle de Policies évaluées contre `(tool, arguments)`.
Question : quel **scope** ? Trois options envisagées au design :

1. **Un Role peut porter des règles pour plusieurs providers** (ex: un Role
   "developer" qui couvre `github__*` + `vercel__*`).
2. **Un Role = exactement 1 provider** (ex: `github:developer`).
3. **Un Role = exactement 1 (provider, ressource)** (ex: `github:developer:acme/app`).

Question accessoire : **naming**. Imposer un format pour rendre l'évaluation
triviale ou laisser libre ?

## Décision

**Option 2** : un Role est _provider-scoped_. **1 Role ne touche qu'à 1
Provider.** Naming **imposé** : le `roles.name` matche `^<provider>:.+$`
avec `<provider>` ∈ {`github`, `vercel`, `supabase`}. CHECK constraint
SQL : `name like provider || ':%'`.

Conventions de naming pour les builtin :

- `github:reader` — read-only sur les repos bindés.
- `github:developer` — read + push sur `feature/*`, `fix/*`, `claude/*` +
  ouvrir PR vers `main`. Pas de merge, pas de delete.
- (v1.5+) `github:reviewer`, `vercel:viewer`, `vercel:deployer`,
  `supabase:reader-staging`, `supabase:writer-staging`, `supabase:reader-prod`.

Builtin = `organization_id is null`, `is_builtin = true`. Read-only
globalement (aucun PATCH/DELETE exposé). Seed en migration. Custom roles
v2 = `organization_id` set, `is_builtin = false`.

L'évaluation du policy engine filtre les Roles d'un Bot par `role.provider`
matchant le préfixe `provider` du `tool_name`. Pour `tool_name =
'github__create_pull_request'`, seuls les Roles avec `provider='github'`
sont chargés.

## Conséquences

**Positives :**

- **Évaluation triviale.** Le policy engine fait `role.provider === provider_from_tool`
  avant même d'évaluer les rules. Pas d'ambiguïté cross-provider.
- **UI lisible.** Le catalogue Roles se groupe naturellement par provider :
  "GitHub roles", "Vercel roles", "Supabase roles". Onglet par provider.
- **Custom roles v2 plus simples.** Les org admins clonent un builtin du
  bon provider et ajustent — pas de combinatoire cross-provider à gérer.
- **Permissions JSON plus serrées.** Les `tool_matches` n'ont jamais
  besoin de qualifier le provider (le Role est déjà scopé), donc on écrit
  `["create_or_update_file"]` (et non `["github__create_or_update_file"]`).
  _Note implémentation_ : on garde le préfixe `github__` dans le DSL en
  v1 pour cohérence avec la liste des tools MCP, mais c'est cosmétique
  une fois que le Role est déjà provider-scopé.

**Négatives :**

- **Plusieurs Roles pour un Bot multi-cloud.** Un Bot qui doit toucher
  GitHub _et_ Vercel porte 2 Roles. Pas un problème — UI gère le N-N
  Bots-Roles trivialement.
- **Pas de cross-provider rule** (ex: "interdire push vers prod tant que
  la CI Vercel n'est pas verte"). Volontaire — relève des _stateful policy
  checks_ hors-scope MVP (cf. spec §1.1).

**Garde-fous structuraux :**

- Test structural (cf. spec §14.4) : pour chaque Role builtin, vérifier
  que tous les `tool_matches` commencent par `<provider>__`. Force la
  cohérence sans relâche.
- CHECK SQL `name like provider || ':%'` empêche l'insertion d'un Role
  mal nommé même via service_role.

## Alternatives rejetées

- **Option 1 (Role multi-provider).** Rejeté : voir §"Décision" — évaluation
  ambiguë, naming flou.
- **Option 3 (Role par-ressource).** Rejeté : explose en volume (un Role
  par repo). Cette granularité vit déjà dans les `provider_bindings` du
  Project du Bot. Les Roles sont des _bundles_ de permissions, pas des
  ACLs.
- **Naming libre** (`name text unique`). Rejeté : laisser un org admin
  créer un Role "developer" qui ressemble à un builtin invite à des bugs
  d'évaluation et casse les conventions UI. Le préfixe `<provider>:`
  garantit l'unicité du namespace builtin global vs custom org-level.
