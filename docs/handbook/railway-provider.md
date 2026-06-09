---
title: Railway provider adapter
status: current
date: 2026-06-08
tracks:
  - packages/providers/railway/src/
  - packages/web/src/app/api/integrations/railway/
  - supabase/migrations/0004_add_railway_provider.sql
---

# Railway provider — `@vaubaan/providers-railway`

Rewrap du MCP remote officiel `mcp.railway.com`. OAuth Auth app
(`authorization_code` + PKCE), token 1h refreshé sur le hot-path, 10 MCP tools
forwardés en JSON-RPC. Même style d'adapter que Vercel.

ADR : `docs/decisions/railway-rewrap-remote-mcp.md`.

## Layout

```
packages/providers/railway/
  src/
    railway-adapter.ts   # RailwayAdapter — mint (+ refresh), executeCall, classify, toolCapabilities
    classify.ts          # classifyRailway + railwayToolCapabilities (capability model)
    execute.ts           # JSON-RPC forward → mcp.railway.com, parse SSE frame
    tools.ts             # availableTools[] + toUpstreamName (strip railway__)
    upstream-tools.json  # 10 tools frozen from upstream
    index.ts             # barrel
  tests/unit/adapter.test.ts (15 tests)
```

## Setup opérateur (une fois)

1. Railway → Workspace → Developer → **Auth apps** → New app
   (`https://railway.com/workspace/developer/apps/new`). Name : `Vaubaan Gateway`.
2. **Device Flow : OFF** (on a un navigateur, on utilise `authorization_code`).
3. Redirect URIs (HTTPS obligatoire, jamais `localhost`) :
   - prod : `https://vaubaan.com/api/integrations/railway/callback`
   - local : `https://127.0.0.1:3000/api/integrations/railway/callback`
4. Récupère `client_id` + `client_secret` → env vars Vaubaan Core :
   - `RAILWAY_CLIENT_ID`
   - `RAILWAY_CLIENT_SECRET`
   - `RAILWAY_REDIRECT_URI` (local uniquement — voir ci-dessous)

> **redirect_uri en local.** Railway exige HTTPS + `127.0.0.1` (pas
> `localhost`, pas `http`). `req.url` en dev vaut `http://localhost:3000`, qui
> ne matche pas une URI registered. Setter
> `RAILWAY_REDIRECT_URI=https://127.0.0.1:3000/api/integrations/railway/callback`
> et servir Next derrière un proxy HTTPS sur 127.0.0.1 (ou un tunnel). En prod
> l'origin `https://vaubaan.com` matche directement, pas besoin de l'override.

## OAuth flow (authorization_code + PKCE)

1. Org admin → `Connect Railway` button.
2. `GET /api/integrations/railway/connect?org=<slug>` :
   - vérifie membership de l'org.
   - génère `state` (cookie `vbn_oauth_state`, 5min) + PKCE `verifier`/`challenge`
     (cookie `vbn_oauth_verifier`, 5min, single-use).
   - redirige vers `https://backboard.railway.com/oauth/auth` avec
     `response_type=code`, `scope=openid offline_access workspace:member`,
     `resource=https://mcp.railway.com` (audience MCP — RFC 8707),
     `prompt=consent` (garantit le `refresh_token`), `code_challenge` (S256).
3. Railway écran consent. Admin grant l'accès workspace. Redirige vers le
   callback avec `code` + `state` (+ `iss`).
4. `GET /api/integrations/railway/callback` :
   - vérifie `state` (== cookie) + présence du `verifier`.
   - échange le code : `POST backboard.railway.com/oauth/token`, Basic auth
     `client_id:secret`, form `grant_type=authorization_code`, `code`,
     `redirect_uri`, `code_verifier`, `resource=https://mcp.railway.com`.
   - upserts `provider_admins` (provider=`railway`) avec `access_token` (1h) +
     `refresh_token` + `expires_at` (bytea, clear-at-rest v0).
5. UI : `/orgs/<slug>/providers` montre Railway connected ✓ + la liste des
   projets visibles.

## Token refresh (hot-path)

À chaque MCP call autorisé qui vise Railway, `RailwayAdapter.mintUpstreamToken` :

```ts
// 1. décode l'access_token stocké.
// 2. si expires_at - now < 60s :
//    POST backboard.railway.com/oauth/token (Basic auth, grant_type=refresh_token,
//    resource=https://mcp.railway.com) → { access_token, refresh_token, expires_in }
//    puis persistRefresh() re-stocke la nouvelle paire en DB.
// 3. forward `tools/call` à https://mcp.railway.com/ avec le Bearer.
```

`persistRefresh` est injecté par la couche web (`lib/gateway/build.ts` et
`lib/providers/state.ts`) — l'adapter reste DB-agnostic. Le `client_id/secret`
viennent des env vars. Contrairement à Vercel (token long-lived) Railway
**doit** refresher car le token est toujours court (1h).

## Tools exposés (10)

Rewrap intégral de `mcp.railway.com`, préfixe `railway__` (les noms upstream
sont en kebab-case) :

- **Read** : `railway__whoami`, `railway__list-projects`,
  `railway__list-services`, `railway__list-deployments`, `railway__get-status`,
  `railway__get-logs`.
- **Write deployment** (`railway:runtime/deployment:write`) : `railway__redeploy`,
  `railway__accept-deploy` (commit les changements staged + déclenche un
  deploy), `railway__railway-agent`.
- **Write account** (`railway:runtime/account:write`) : `railway__create-project`.

Refresh de la liste : `POST tools/list` à `mcp.railway.com` avec un Bearer
scopé `resource=https://mcp.railway.com`, recopier chaque tool avec le préfixe
dans `src/upstream-tools.json`.

## Classification (capability model)

`src/classify.ts` remplace l'ancien modèle « roles + policy DSL »
(`resolveTarget` supprimé). Une capability est un tuple
`{ provider, plane, level, action, env? }` (cf.
`docs/spec/gateway-capability-model.md`). Pour Railway le `provider` est
`railway`, le `plane` est `runtime` (ladder : `deployment` → `config` →
`project-settings` → `account` ; le MVP n'expose que les niveaux `deployment`
et `account`).

`classifyRailway(tool, args, bindings)` mappe un call concret vers la
capability requise (ou un `{ denied }` structurel) :

| Tools                                                         | Capability                         |
| ------------------------------------------------------------- | ---------------------------------- |
| `whoami`, `list-projects`                                     | `railway:runtime/account:read`     |
| `list-services`, `list-deployments`, `get-status`, `get-logs` | `railway:runtime/deployment:read`  |
| `redeploy`, `accept-deploy`, `railway-agent`                  | `railway:runtime/deployment:write` |
| `create-project`                                              | `railway:runtime/account:write`    |

`railwayToolCapabilities(tool)` renvoie la surface env-less d'un tool (pour le
filtrage statique `tools/list`) : un tableau d'une seule capability, ou `[]`
pour un tool inconnu.

**ENV non résolu (MVP).** Les « environments » Railway demandent un lookup de
nom upstream que le MVP ne fait pas (pas de check stateful dans le
classifier) ; `env` est donc laissé `undefined` sur toutes les capabilities.
Le câblage atterrira depuis la binding/les args quand la résolution sera
ajoutée — pas inventé.

**Binding check.** La binding Railway a pour `resource_ref` le `projectId`. Le
call le porte sous `args.projectId` ou `args.project_id`. S'il est présent, il
doit appartenir aux `resource_ref` des bindings railway du Project, sinon
`{ denied: "railway project '<id>' is not bound to this project." }`. S'il est
absent on ne fail PAS (scope-injection remplit le projectId pour les Projects
mono-binding) ; les tools account-level (`whoami`, `list-projects`,
`create-project`, `railway-agent`) ne portent jamais de `projectId` et passent
sans binding check. Un tool inconnu →
`{ denied: "unknown railway tool '<tool>'." }`.

## Tests

`npx vitest run packages/providers/railway` — 15 tests, ~10ms (dont 6 pour
`classify` : reads → `runtime/account|deployment:read`, redeploy →
`runtime/deployment:write`, create-project → `runtime/account:write`,
deny unbound, deny unknown).
