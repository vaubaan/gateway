---
title: RBAC — modèle Org × Project × Role × Bot
status: accepted
date: 2026-05-22
tracks:
  - docs/spec/mcp-proxy.md
---

# RBAC — modèle Org × Project × Role × Bot

## Contexte

Le MCP Proxy doit donner à un agent (Claude Code, Cursor…) le strict
nécessaire pour faire son job — ni plus, ni moins. La granularité doit
être suffisamment fine pour "developer sur le repo X" sans donner accès
au repo Y, mais suffisamment simple pour qu'un org admin la configure
en quelques clics.

Trois axes à modéliser :

- **Qui** agit (identité de l'agent).
- **Sur quoi** il agit (les ressources cloud accessibles).
- **Quels** verbes il peut utiliser (les tools MCP).

## Décision

Quatre objets cardinaux, distincts et composables :

```
Organization (tenant racine)
├── ProviderAdmins[]    1 par cloud provider connecté
├── RoleCatalog[]       provider-scoped, builtin global + custom (v2) org-level
├── Members[]           2 rôles humains : member (read) / admin (write)
└── Projects[]
      ├── ProviderBindings[]   1 par provider activé pour ce project
      └── Bots[]                project-scoped, porteurs de N Roles
```

- **Role** est _provider-scoped_ (1 Role ne touche qu'à 1 Provider), naming
  imposé `<provider>:<role-name>` (cf. [[roles-naming-provider-scoped]]).
- **Bot** est _project-scoped_. Porte N Roles. Identifié par une `api_key`
  Vaubaan (`vbn_live_xxxx…`). C'est l'objet sur lequel le hot-path
  s'authentifie.
- **ProviderBinding** est _project-scoped_. Lien concret vers une ressource
  côté Provider (ex: `acme/app` pour GitHub). Résout les targets abstraits
  des Roles (`project.repos`, `project.vercel`, `project.supabase`).
- **ProviderAdmin** est _org-scoped_. Bundle de credentials issu d'un flow
  OAuth/App install. C'est ce qui permet à Vaubaan d'agir au nom de l'org
  chez le Provider (cf. [[oauth-app-install-per-provider]]).

Décision d'évaluation d'un call MCP :

1. Auth → bot, project, org, roles.
2. Détermine provider à partir du tool_name préfixé.
3. Charge les Roles dont `provider` matche le call.
4. Pour chaque rule : check tool match, target match (résolu via bindings),
   constraints (operators sur arguments). Default deny ; deny override
   allow ; priority pour tie-break entre deny.
5. Allow → mint upstream token JIT, executeCall, audit. Deny → audit avec
   `denial_reason` actionable.

## Conséquences

**Positives :**

- **Composabilité.** Un Bot "claude-dev" porte un seul Role
  `github:developer`. Si on veut lui donner aussi accès Vercel deploy, on
  ajoute `vercel:deployer`. Pas de Role omnibus.
- **Isolation par-Project.** Un Bot ne voit que les bindings de son
  Project — il ne peut pas taper sur le repo d'un autre Project de la
  même Org même s'il connaît son nom.
- **Builtin Roles = catalogue, custom = v2.** Évite que chaque org bricole
  son DSL au MVP. Les builtin (`github:reader`, `github:developer`) sont
  read-only globalement et seed-és en migration.
- **Modèle UI lisible** : 4 pages cardinales (Org/Members, Providers,
  Projects/Bindings/Bots, Roles).

**Négatives :**

- **Pas de delegation cross-Project en MVP.** Si une équipe veut un Bot
  qui agit sur 3 repos de 3 projects différents, il faut 3 Bots (un par
  Project). Volontaire — éviter les Bots "super-admin de l'Org" qui
  cassent la promesse d'isolation.
- **Pas de granularité par-resource au niveau humain.** Un org admin peut
  tout faire sur tous les Projects de son Org. La granularité fine vit
  dans la composition Roles × Bots, qui est elle-même un objet d'admin.
- **2 RBAC distincts** : (a) humain au niveau Org (2 rôles : member /
  admin), (b) machine au niveau Bot via Roles + Policies. Bien distinguer
  les deux dans la doc et l'UI.

## Alternatives rejetées

- **Role org-scoped sans provider-scoping** (ex: un seul Role "developer"
  qui couvre GitHub + Vercel + Supabase). Rejeté : combinatoire ingérable
  des permissions cross-provider, naming flou, deny override entre providers
  imprévisible. La règle 1 Role = 1 Provider rend l'évaluation triviale.
- **Bot global Org-scoped au lieu de Project-scoped.** Rejeté : casse
  l'isolation par-Project. Un compromis api_key → accès tous les repos /
  projects de l'Org.
- **RBAC humain fin par-resource** (ex: "member peut editer le project X
  mais pas le project Y"). Rejeté : sur-engineering pour un MVP. La
  granularité fine vit dans Bots × Roles.
