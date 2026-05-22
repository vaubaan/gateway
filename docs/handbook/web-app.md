---
title: Next.js web app
status: current
date: 2026-05-22
tracks:
  - packages/web/src/
  - packages/web/next.config.ts
---

# Web app — `@vauban/web`

Le control plane UI + le `/mcp` endpoint. Next.js 15 App Router, Supabase
magic-link auth, server-side rendering, dynamic routes.

## Layout

```
packages/web/
  src/
    app/
      layout.tsx                                       # Root layout
      page.tsx                                         # Landing
      globals.css
      login/page.tsx                                   # Magic-link login
      auth/callback/route.ts                           # Supabase auth callback
      mcp/route.ts                                     # MCP gateway POST
      api/v1/bots/route.ts                             # Bot create (api_key visible 1×)
      dashboard/page.tsx                               # User's organizations
      orgs/
        new/page.tsx                                   # Create org
        [slug]/
          page.tsx                                     # Org dashboard
          audit/page.tsx                               # Audit log
          providers/github/
            connect/page.tsx                           # OAuth → install URL
            callback/route.ts                          # OAuth callback handler
          projects/
            new/page.tsx                               # Create project
            [project]/
              page.tsx                                 # Project detail (bindings + bots)
              bindings/new/page.tsx                    # Bind a resource
              bots/new/page.tsx                        # Create a bot (api_key reveal)
    lib/
      supabase/server.ts                               # ssr-typed clients (anon + service)
      supabase/client.ts                               # browser client
      oauth/state.ts                                   # state nonce generator
      gateway/build.ts                                 # wire McpGateway with adapters
  next.config.ts
  tsconfig.json
  .env.local.example
```

## Auth

- Supabase magic-link (`auth.signInWithOtp`).
- Session cookie via `@supabase/ssr`.
- `/auth/callback?code=...` exchanges the code for a session.
- All UI routes check `auth.getUser()` server-side and redirect to `/login`
  if missing.

## OAuth GitHub flow

1. UI button → `GET /orgs/<slug>/providers/github/connect` (server component).
2. Server generates a `state` nonce, stores it in `vbn_oauth_state` cookie
   (5-min TTL, single-use), and redirects to GitHub App install URL.
3. GitHub callback → `GET /orgs/<slug>/providers/github/callback?installation_id=...&state=...`.
4. Handler verifies state cookie, then upserts `provider_admins` via the
   service_role client (RLS-bypass — the admin we just authenticated would
   be blocked by RLS otherwise).

## Bot creation (api_key visible 1×)

Hot path :

```
POST /api/v1/bots {orgSlug, projectSlug, name, roleIds}
  ├─ verify session + org_member.role === 'admin'
  ├─ generateApiKey('live') → {apiKey, apiKeyPrefix}
  ├─ hashApiKey(apiKey) → apiKeyHash (argon2id)
  ├─ INSERT bots (api_key_prefix, api_key_hash, ...)
  ├─ INSERT bot_roles (...)
  └─ → { bot, api_key }  ← visible only here
```

UI : after create, a modal displays the full api_key with a Copy button and
a warning `won't be shown again`. The modal also shows the snippet to drop in
`~/.config/claude/mcp.json` :

```jsonc
{
  "mcpServers": {
    "vauban": {
      "url": "https://vauban.run/mcp",
      "headers": { "Authorization": "Bearer vbn_live_..." },
    },
  },
}
```

## /mcp endpoint

`packages/web/src/app/mcp/route.ts` is a thin HTTP→McpGateway adapter :

- Parses JSON body, validates JSON-RPC envelope.
- Builds the gateway via `buildGateway()` (loads env vars, wires
  Supabase service client + GitHub adapter + cache + audit writer).
- Calls `gateway.authenticate(authHeader)` → if AuthError, returns 401 with
  `error.code = -32001`.
- Calls `gateway.handle(ctx, req)` → returns the JSON-RPC response (always 200
  for policy denials — the JSON-RPC error envelope encodes them).
- Misconfiguration (missing GITHUB_APP_PRIVATE_KEY etc) → 503 with explicit
  message.

## RLS — practical notes

Read paths use the user-bound `getSupabaseServer()` client (RLS enforced).
Writes that need to bypass RLS (Bot insert, provider_admins upsert, audit_log
insert) use the service_role client (`getSupabaseServiceClient()`).

The service_role client is server-only and never reaches the browser bundle.
