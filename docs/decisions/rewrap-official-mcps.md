---
title: Rewrap des MCP officiels par provider (Vercel = oui, Supabase = non, GitHub = non)
status: accepted
date: 2026-05-23
---

> **Pre-v5 document (French).** Not translated; read with the mapping in [[legacy-status-of-v4-adrs-and-handbooks]].

# Rewrap des MCP officiels par provider

## Contexte

L'ADR `dispatch-upstream-option-a-synthese.md` figeait l'**Option A** (synthèse
via SDK) pour GitHub en MVP. Trois providers landed plus tard, la question
revient : faut-il les implémenter aussi en synthesis, ou rewrapper leur
MCP officiel ?

Surface réelle des MCPs officiels disponibles aujourd'hui :

| Provider | MCP officiel                        | Transport          | Auth                                      |
| -------- | ----------------------------------- | ------------------ | ----------------------------------------- |
| GitHub   | `ghcr.io/github/github-mcp-server`  | **stdio** (Docker) | PAT env var                               |
| Vercel   | `https://mcp.vercel.com/`           | **HTTP+SSE**       | Bearer (team token ou OAuth user session) |
| Supabase | `npx @supabase/mcp-server-supabase` | **stdio** (Node)   | `--access-token` flag                     |

Vaubaan Core tourne en **Vercel Functions (serverless Node)**. Contraintes
opérationnelles :

- **Pas de Docker en runtime** — exclut `ghcr.io/github/github-mcp-server`
  côté Vercel Functions. Migrer vers Fly Machines = changement profond
  d'hébergement, hors-scope MVP.
- **Subprocess spawn en cold start** — possible mais coûteux : `npx -y @supabase/mcp-server-supabase`
  télécharge un paquet npm à chaque cold start (Vercel functions sont
  éphémères). Latence cold ≈ 5–15s, inacceptable pour le hot-path.
- **HTTP forward** — gratuit en surface ops. Juste un `fetch` POST.

## Décision

Per-provider :

- **GitHub** : Option A (synthesis via Octokit). Le MCP officiel est Docker
  stdio, infaisable depuis Vercel Functions. On garde le mapping
  `tool_name → SDK call` dans `packages/providers/github/src/execute.ts`
  comme prévu dans l'ADR initiale.

- **Vercel** : **Option B (rewrap)**. Le MCP officiel `mcp.vercel.com` est
  HTTP+SSE et accepte un Bearer team token directement. Notre adapter
  JSON-RPC-forward chaque `tools/call` au upstream, strip le préfixe
  `vercel__` avant envoi, parse la frame SSE. La liste des 18 tools est
  fetched depuis l'upstream et frozen comme `upstream-tools.json`.

- **Supabase** : Option A (synthesis via Management API). Le MCP officiel
  est stdio, même argument que GitHub : pas viable depuis Vercel
  Functions. On hit `api.supabase.com/v1` directement avec le PAT
  `sbp_...`.

## Conséquences

**Positives :**

- **Vercel hérite gratis des 18 tools officiels** + de leurs descriptions
  - de leurs schemas. Pas de mapping à maintenir, pas de drift quand
    Vercel ajoute des tools (un re-fetch + commit suffit à refresh).
- **GitHub + Supabase gardent leur Option A** — surface contrôlée,
  filtering possible des réponses, tests unitaires triviaux.
- **Pas de dépendance d'hébergement** : Vaubaan Core reste serverless
  Vercel-friendly.

**Négatives / coûts :**

- **Vercel `tools/list` retourne 18 tools que je n'ai pas conçus.** Ils
  peuvent contenir des verbes destructifs (ex: `deploy_to_vercel`) qu'on
  voudrait deny-list par défaut dans `vercel:viewer`. Mitigation :
  policy engine filtre déjà — `vercel:viewer` n'allow que `vercel__list_*`
  et `vercel__get_*`, donc les autres sont implicitement deny par
  default-deny. C'est cohérent avec la spec §6.
- **Frozen schemas** — si Vercel met à jour les schemas in-place
  (compatibilité cassée), notre `upstream-tools.json` part en drift. À
  re-fetch manuellement chaque trimestre + bump version. À automatiser
  via un cron en v1.1.
- **2 styles d'adapter à maintenir** — rewrap (Vercel) vs synthesis
  (GitHub, Supabase). Léger, gérable.

## Conditions de bascule

- **GitHub → rewrap** : si on switch d'hébergement (Fly Machines, Render
  workers, etc.). Nouvel ADR à drafter.
- **Supabase → rewrap** : pareil. Ou si Supabase publie un MCP HTTP-hosted
  comme Vercel.
- **Vercel → synthesis** : si `mcp.vercel.com` change de modèle d'auth
  (ex: exige OAuth user session non-token), on re-tomberait sur
  l'API REST.

## Alternatives rejetées

- **Tout rewrap, avec sidecar Fly Machines pour GitHub/Supabase.** Rejeté
  pour MVP : changement d'hébergement majeur, opex non-justifié pour le
  profil client MVP. À reconsidérer en v1.5 si besoin de couvrir plus de
  providers stdio-only.
- **Tout synthesis.** Rejeté pour Vercel : on perd les 18 tools gratis +
  on doit maintenir une bibliothèque qui duplique mcp.vercel.com pour
  rien.
