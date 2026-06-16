---
title: Railway provider adapter
status: current
date: 2026-06-15
tracks:
  - packages/providers/railway/src/
  - packages/web/src/app/api/integrations/railway/
  - supabase/migrations/0004_add_railway_provider.sql
---

# Railway provider — `@vaubaan/providers-railway`

> **v4 risk-based catalog added — 2026-06-15.** Le pivot
> `chore(v1-drop)` a supprimé le classifier capability-based + le
> ladder `runtime/account/deployment`. Le code expose désormais
> `data-model.ts` (8 entités du plane `runtime`),
> `risk-catalog.{yaml,ts}` (11 risks + fallback) et `risk-classifier.ts`
> (classifyRailwayV4). Corrections au passage : `upsert-variables` lit
> `args.replace` et émet un slice distinct (`service-var[*].W` wildcard
> pour `replace=true`) qui trigge le `bulk-variables-replace` deny risk ;
> `railway-agent` émet trois parallel slices (account+deployment+service-var)
> et le token doit accepter l'union. Pour le data-model + risk catalog +
> tool → slice, lire le handbook v4 dédié :
> [`docs/handbook/providers/railway-ssh.md`](./providers/railway-ssh.md)
> §1.

Rewrap du MCP remote officiel `mcp.railway.com`. OAuth Auth app
(`authorization_code` + PKCE), token 1h refreshé sur le hot-path, 10 MCP tools
forwardés en JSON-RPC. Même style d'adapter que Vercel.

ADR : `docs/decisions/railway-rewrap-remote-mcp.md`.

## Layout

```
packages/providers/railway/
  src/
    railway-adapter.ts       # RailwayAdapter — mint (+ refresh), executeCall, classifyV4
    risk-classifier.ts       # classifyRailwayV4 → Slice[] (cf. providers/railway-ssh.md §1)
    risk-catalog.{yaml,ts}   # 11 risks + fallback
    data-model.ts            # 8 entités du plane `runtime`
    execute.ts               # JSON-RPC forward → mcp.railway.com, parse SSE frame
    tools.ts                 # availableTools[] + toUpstreamName (strip railway__)
    upstream-tools.json      # 10 tools frozen from upstream
    index.ts                 # barrel
  tests/unit/
    adapter.test.ts            (15 tests)
    risk-catalog.test.ts       (16 tests)
    risk-classifier.test.ts    (20 tests)
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
5. UI : `/orgs/<slug>/providers` montre Railway connected ✓.

## Token mint / hot-path (refresh JIT)

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

## executeCall — dispatch côté provider

`execute.ts` forward chaque `tools/call` à `https://mcp.railway.com/`
en JSON-RPC, avec strip du préfixe `railway__` côté upstream. Le SSE
frame de réponse est parsé et le `result` retourné au gateway.

10 tools rewrapped, préfixe `railway__`. La liste + leurs
classifications v4 vit dans
[`providers/railway-ssh.md`](./providers/railway-ssh.md) §1.

## Tests

`npx vitest run packages/providers/railway` — 51 tests (~50ms). Voir
[`providers/railway-ssh.md`](./providers/railway-ssh.md) §1 §Tests pour
le détail des scénarios catalog/classifier.

## Références

- Handbook v4 (data-model + risk catalog + tool → slice) :
  [`docs/handbook/providers/railway-ssh.md`](./providers/railway-ssh.md) §1.
- Spec : [`docs/spec/gateway-risk-model.md`](../spec/gateway-risk-model.md).
- ADR : [[railway-rewrap-remote-mcp]].
- Handbooks voisins : [[github-provider]] (pattern de référence),
  [[mcp-gateway]] (hot-path dispatch), [[escalation]] (runtime escalation_channel),
  [[policy-engine]] (`evaluateCall` + scope injection).
