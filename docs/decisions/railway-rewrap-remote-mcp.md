---
title: Railway — rewrap du MCP remote (mcp.railway.com) via OAuth audience-binding
status: accepted
date: 2026-05-29
---

# Railway — rewrap du MCP remote via OAuth audience-binding

## Contexte

On ajoute Railway (https://railway.com) au catalogue providers. Deux chemins
d'intégration, comme pour les providers existants (cf.
`rewrap-official-mcps.md`) :

- **Synthesis (Option A)** — hit l'API GraphQL `backboard.railway.com/graphql/v2`
  directement, et maintenir à la main un mapping `tool_name → GraphQL query`.
- **Rewrap (Option B)** — forwarder nos `tools/call` au MCP remote officiel
  `https://mcp.railway.com/`, comme on le fait pour Vercel.

Railway expose **les deux** : une API GraphQL ET un MCP remote hosté
(`mcp.railway.com`, transport Streamable HTTP). La question : le MCP remote
est-il forwardable depuis Vaubaan Core (Vercel Functions serverless) avec un
token qu'on détient côté serveur ?

POC réalisé le 2026-05-29 (Auth app Railway "Vaubaan Gateway", flow
authorization_code + PKCE) :

- `mcp.railway.com` annonce comme `authorization_server`
  **`backboard.railway.com`** — exactement l'AS de notre Auth app. Le même
  token OAuth sert donc pour l'API ET pour le MCP.
- L'audience MCP est liée via **RFC 8707 Resource Indicators** : il faut
  passer `resource=https://mcp.railway.com` à l'authorize ET au token
  endpoint. Sans ça le token n'est pas accepté par le MCP.
- Le serveur est **stateless par Bearer** : pas de `Mcp-Session-Id`, chaque
  requête JSON-RPC est authentifiée indépendamment par le header
  `Authorization: Bearer`. `initialize` n'est pas un pré-requis à `tools/call`.
- `tools/list` renvoie **10 tools** : `whoami`, `list-projects`,
  `create-project`, `list-services`, `list-deployments`, `get-status`,
  `get-logs`, `redeploy`, `accept-deploy` (marqué `DESTRUCTIVE` par le serveur
  lui-même), `railway-agent`.

C'est exactement le profil de Vercel : MCP HTTP + Bearer forwardable. À la
différence du **MCP de Supabase** (`mcp.supabase.com`), qui impose un
_Dynamic Client Registration_ navigateur-side (RFC 7591) difficile à forwarder
serveur-side — raison pour laquelle Supabase reste en synthesis (cf.
`rewrap-official-mcps.md`).

## Décision

**Railway = Option B (rewrap), comme Vercel.**

- **Acquisition du credential** : OAuth Auth app "Vaubaan Gateway" (flow
  `authorization_code` + PKCE S256), jamais paste-token (cf.
  `oauth-app-install-per-provider.md`). Scopes :
  `openid offline_access workspace:member`. On passe
  `resource=https://mcp.railway.com` (audience MCP) et `prompt=consent` (pour
  garantir un `refresh_token` via `offline_access`).
- **Stockage** : `access_token` (1h) + `refresh_token` + `expires_at` dans
  `provider_admins` (bytea, clear-at-rest v0 — cf.
  `trust-model-clear-at-rest-idp-style.md`).
- **Mint upstream** : l'access_token expire en 1h. L'adapter refresh le token
  **sur le hot-path** si `expires_at - now < 60s` (Basic auth `client_id:secret`
  → `backboard.railway.com/oauth/token`, grant `refresh_token`, avec
  `resource=https://mcp.railway.com`), et re-persiste la nouvelle paire. C'est
  plus strict que Vercel (token long-lived → use direct) et que Supabase (dont
  le refresh ne vit qu'au niveau UI). Railway **doit** refresher en gateway car
  le token est toujours court.
- **Exécution** : `executeCall` forwarde `tools/call` en JSON-RPC à
  `https://mcp.railway.com/`, strip le préfixe `railway__`, parse la frame SSE
  (`parseFirstJsonRpcFrame`) — identique à l'adapter Vercel.
- **tools/list frozen** : les 10 tools sont figés dans
  `packages/providers/railway/src/upstream-tools.json` (capture verbatim le
  2026-05-30 depuis `mcp.railway.com tools/list`, avec un Bearer scopé
  `resource=https://mcp.railway.com`). Les `required[]`, enums et
  `additionalProperties:false` sont les vrais — pas de guesses. Refresh =
  re-fetch tools/list + commit (même procédure que Vercel).

### Roles builtin

- `railway:viewer` — read seul : `whoami`, `list-*`, `get-*`.
- `railway:member` — read + write contraint : `create-project`, `redeploy`,
  `railway-agent`. **deny explicite** sur `accept-deploy` (le seul tool que
  Railway marque `DESTRUCTIVE` : il commit des changements staged et déclenche
  un deploy). Aligné sur le pattern `github:developer` qui deny
  `merge_pull_request`/`delete_*`.

Les deux roles utilisent `target: '*'` (comme `vercel:viewer` /
`supabase:reader`) : plusieurs tools Railway (`whoami`, `list-projects`,
`create-project`) ne portent pas d'identifiant de projet, donc un
`target: project.railway` les denierait à tort. La résolution
`project.railway` reste disponible pour des roles custom org-scopés.

## Conséquences

**Positives :**

- **Railway hérite gratis des 10 tools officiels** + leurs descriptions +
  schemas. Pas de mapping GraphQL à maintenir, pas de drift quand Railway
  ajoute des tools (re-fetch + commit suffit).
- **Un seul token** sert l'API et le MCP (même AS `backboard.railway.com`).
- **Cohérent avec Vercel** : même adapter rewrap, même freeze
  `upstream-tools.json`, mêmes tests structurels.

**Négatives / coûts :**

- **Refresh sur le hot-path.** Contrairement à Vercel (long-lived), chaque
  call Railway peut déclencher un refresh OAuth (token 1h). Mitigation : on ne
  refresh que sous le seuil de 60s d'expiry ; le coût amorti reste faible.
- **`resource=` obligatoire.** Si on oublie l'audience-binding au token
  endpoint, le token est silencieusement refusé par le MCP. Encapsulé dans
  l'adapter + les routes OAuth, documenté ici.
- **redirect_uri stricte.** Railway impose `https://127.0.0.1` (jamais
  `localhost`, jamais `http`) pour le loopback. En prod `https://vaubaan.com`
  passe ; en local il faut `RAILWAY_REDIRECT_URI` + un tunnel/https sur
  127.0.0.1. Documenté dans le handbook.
- **`tools/list` frozen** — même drift potentiel que Vercel, même remède
  (re-fetch trimestriel).

## Conditions de bascule

- **Railway → synthesis** : si `mcp.railway.com` change de modèle d'auth
  (ex: impose un DCR navigateur comme Supabase), on retomberait sur l'API
  GraphQL. Nouvel ADR à drafter.

## Alternatives rejetées

- **Synthesis via GraphQL.** Rejeté : on devrait réimplémenter et maintenir un
  mapping qui duplique `mcp.railway.com` pour rien, alors que le MCP est
  directement forwardable (contrairement à GitHub/Supabase dont le MCP est
  stdio ou DCR-only).
- **Paste-token (Railway API token).** Rejeté pour la même raison que les
  autres providers : provenance opaque, scope non garanti, pas de révocation
  propre (cf. `oauth-app-install-per-provider.md`).
- **Device Flow.** Railway le propose ("Enable for CLIs and devices that
  cannot open a browser") mais on a un navigateur (l'org admin clique Connect)
  → `authorization_code` + PKCE est le bon grant. Device Flow reste désactivé
  sur l'Auth app.
