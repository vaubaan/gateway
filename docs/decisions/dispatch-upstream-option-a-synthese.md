---
title: Dispatch upstream — Option A (synthèse REST), pas de sidecar Docker MVP
status: accepted
date: 2026-05-22
tracks:
  - docs/spec/mcp-proxy.md
  - packages/providers/github/src/execute.ts
---

# Dispatch upstream — Option A (synthèse REST), pas de sidecar Docker MVP

## Contexte

Quand le policy engine `allow` un MCP call, le gateway doit exécuter
l'action côté Provider et renvoyer la réponse à l'agent. Deux stratégies :

- **Option A — Synthèse.** Le gateway implémente lui-même chaque tool MCP
  en tapant directement l'API REST du Provider via son SDK officiel
  (Octokit pour GitHub, vercel sdk pour Vercel, supabase-js / Mgmt API
  pour Supabase). Le mapping `tool_name → SDK call` vit dans
  `packages/providers/<provider>/execute.ts`.
- **Option B — Sidecar.** Le gateway lance le MCP server officiel du
  Provider (ex: `ghcr.io/github/github-mcp-server`) en sous-processus /
  container, lui forwarde le JSON-RPC `tools/call` avec le token éphémère
  mintée, et reverse-proxie la response au client.

## Décision

**Option A pour le MVP**, pour GitHub d'abord, puis Vercel + Supabase
phase 5. Le gateway garde le contrôle de la liste des tools exposés et
de leur shape de response.

Implémentation :

- `packages/providers/github/src/tools.ts` exporte un array
  `availableTools: McpToolDeclaration[]` (sous-ensemble du MCP GitHub
  officiel — ~15-20 tools les plus pertinents pour coding agents).
- `packages/providers/github/src/execute.ts` exporte `executeCall(admin,
binding, toolName, args)` qui dispatch via un switch sur `toolName`
  vers les appels Octokit correspondants.
- Le shape des responses MCP suit la spec MCP officielle (`content:
[{type: 'text', text: '...'}]` ou JSON brut selon le tool).

## Conséquences

**Positives :**

- **Contrôle fin des tools exposés.** On choisit quels tools de l'API
  GitHub on expose. On peut ajouter du metadata (description annotée,
  schémas Zod stricts).
- **Pas de sous-processus / container à opérer sur Vercel Functions.**
  Vercel serverless functions n'autorisent pas trivialement le lancement
  de containers — Option B nécessiterait Fly Machines ou un équivalent
  long-running, qui change le profil d'hosting et de pricing.
- **Filtering possible des responses** (strip champs sensibles, transformer
  format pour économiser tokens côté agent).
- **Tests unitaires triviaux.** On mocke Octokit dans Vitest, on vérifie
  `executeCall('github__create_pull_request', {...}) → Octokit.pulls.create({...})`
  avec les bons args.
- **Latence minimale.** Pas de hop sous-processus, pas de framing
  JSON-RPC double.

**Négatives / coûts :**

- **Mapping `tool_name → SDK call` à maintenir.** ~15-20 tools côté
  GitHub MVP, plus quand on étend. Si le MCP GitHub officiel ajoute des
  tools ou change leur shape, on est en drift jusqu'à mise à jour
  manuelle. Mitigation : test structural (cf. spec §14.4) qui assert
  chaque tool a une signature Octokit valide à l'import time.
- **Doit redocumenter le contrat MCP.** L'agent peut référencer la spec
  MCP officielle GitHub _à condition_ qu'on expose un sous-ensemble
  conforme. On documente les tools exposés dans `docs/handbook/github-provider.md`.
- **Surface de bug propre.** Si on mappe mal un champ d'argument,
  l'erreur sort de chez Vauban (pas du provider). Mitigation : tests
  unitaires + tests E2E réels qui valident le round-trip.

## Conditions de bascule Option B

On reconsidère Option B en v1.5 si :

- Le mapping atteint >50 tools / provider et la charge de maintenance
  devient pénible.
- Le MCP officiel ajoute des features (annotations, schemas avancés)
  qu'on ne veut pas re-implémenter.
- On change de plateforme d'hosting pour quelque chose qui supporte les
  long-running containers (Fly, Render workers).

Switch nécessitera un nouvel ADR + le sidecar containerisé devra tourner
avec `--cap-drop=ALL --read-only --network=internal` + egress allowlist
(cf. spec §11).

## Alternatives rejetées

- **Option B dès MVP.** Rejeté : sur-engineering, plateforme Vercel mal
  adaptée aux containers, audit harder (response transparente du sidecar
  rend filtering plus pénible).
- **Forwarder le JSON-RPC tel quel au MCP officiel du provider via fetch
  HTTP.** Rejeté : la plupart des MCP servers officiels ne sont pas
  HTTP-exposés (ils tournent en stdio), donc Option B "sidecar process"
  reste la voie. Et HTTP forward = on perd le contrôle de la liste des
  tools.
- **Hybride** (Option A pour les tools "critiques", Option B pour le
  reste). Rejeté : double surface à maintenir, double posture de
  filtering, complexité du switch tool-par-tool.
