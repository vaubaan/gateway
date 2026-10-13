---
title: Augmenter le provider Vercel avec quelques tools REST custom
status: accepted
date: 2026-05-31
---

> **Pre-v5 document (French).** Not translated; read with the mapping in [[legacy-status-of-v4-adrs-and-handbooks]].

# Augmenter le provider Vercel avec quelques tools REST custom

## Contexte

L'ADR [rewrap-official-mcps.md](./rewrap-official-mcps.md) a figé Vercel en
**Option B (rewrap)** : on forwarde JSON-RPC à `mcp.vercel.com` et on hérite
gratis des 18 tools officiels. C'est cohérent en surface ops.

En pratique, les downstream clients (Claudes orchestrant des projets qui
consomment la gateway) tombent vite sur des trous fonctionnels : le MCP
officiel ne couvre **que** lecture + déploiement + threads toolbar. Aucun
tool pour mettre à jour les settings d'un projet (`rootDirectory`, framework,
buildCommand…) ni pour gérer les env vars. Le client doit basculer sur la UI
Vercel ou la CLI à la main → casse le flow.

Côté token : Vercel n'expose **pas** d'équivalent aux GitHub installation
tokens (scopés repo + permissions, short-lived). Le PAT stocké côté
ProviderAdmin est compte-wide. Donc handing-out d'un token "advanced CLI"
via la gateway = bypass total de la policy engine → recalé.

Reste l'option : **ajouter une poignée de tools REST custom** par-dessus le
rewrap, marqués comme tels, qui appellent directement `api.vercel.com`.

## Décision

On augmente le provider Vercel avec un petit set de tools custom (REST
direct), maintenu séparément du freeze upstream :

- **Fichier source** : `packages/providers/vercel/src/custom-tools.ts`
  (séparé de `upstream-tools.json` pour ne pas mélanger gel upstream et code
  maison ; refresh upstream reste un simple re-fetch).
- **Surface v1** :
  - `vercel__update_project_settings` → `PATCH /v9/projects/{projectId}`.
    Champs typés strict : `rootDirectory`, `framework`, `buildCommand`,
    `devCommand`, `installCommand`, `outputDirectory`, `nodeVersion`.
  - `vercel__upsert_env_var` → `POST /v10/projects/{projectId}/env?upsert=true`.
    Champs : `key`, `value`, `target[]`, `type`, `gitBranch?`, `comment?`.
- **Tools.ts** exporte l'union upstream + custom et expose un helper
  `isCustomTool(name)` pour le dispatch.
- **Execute.ts** détecte `isCustomTool(name)` → route vers
  `api.vercel.com` (PATCH/POST + Bearer + `teamId` query param) au lieu du
  JSON-RPC forward vers `mcp.vercel.com`. Tout le reste (audit, policy)
  vit en amont, identique aux tools upstream.

Schémas typés strict (pas de passthrough libre) pour rester discoverable
côté `tools/list` et policy-able par champ.

## Conséquences

**Positives :**

- Les Claudes downstream peuvent enfin modifier les settings projet et les
  env vars sans recourir à la UI ou à la CLI hors-gateway.
- La policy engine reste enforced : un rôle `vercel:viewer` ne voit pas
  `update_project_settings` ; `vercel:editor` peut être autorisé via la
  DSL existante (pas de changement DSL).
- Surface custom **minimale et explicite** : 2 tools listés dans
  `custom-tools.ts`, vs des dizaines de PATCH/POST possibles côté Vercel.
  Tout ajout futur passe par cet ADR + une review.

**Négatives / coûts :**

- On rompt le principe "pur re-wrap" de
  [rewrap-official-mcps.md](./rewrap-official-mcps.md). À chaque tool
  custom ajouté, on assume :
  - Maintenance du schema (drift Vercel REST API).
  - Couverture de tests unitaires propre par tool.
- Deux code paths dans `execute.ts` : forward JSON-RPC (upstream) vs
  REST direct (custom). Le routage par préfixe de nom est trivial mais
  ça reste un branchement supplémentaire.
- Token : on continue d'utiliser le PAT stocké côté admin (broad scope).
  Pas de régression de sécurité — les custom tools restent sous policy
  engine, donc équivalents fonctionnellement aux tools upstream du point
  de vue auth.

## Conditions de bascule

- **Vercel publie nativement ces tools dans `mcp.vercel.com`** → on retire
  les custom et on revient pur re-wrap. Le ré-fetch upstream sera
  l'indicateur.
- **Surface custom > ~5 tools** → re-évaluer : soit l'autonomie devient
  un vrai besoin métier (auquel cas on en discute un wrapper plus
  systématique), soit on a dérivé et il faut remettre en cause.

## Alternatives rejetées

- **Tool `vercel__get_admin_token` qui rend le PAT au downstream.** Le PAT
  est compte-wide non scopable ; le rendre au client = bypass total de la
  policy engine. Recalé.
- **Token éphémère via `POST /v3/user/tokens` puis renvoi au downstream.**
  Toujours broad scope, juste expirable. N'enlève pas le bypass policy.
  Recalé pour les mêmes raisons.
- **Wrapper exhaustif de la REST API Vercel.** Trop d'entretien pour le
  bénéfice. On préfère un ajout incrémental piloté par les vrais besoins.
