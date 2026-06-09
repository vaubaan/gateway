---
title: Next.js web app
status: current
date: 2026-05-26
tracks:
  - packages/web/src/
  - packages/web/next.config.ts
---

# Web app — `@vaubaan/web`

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
      api/v1/tokens/route.ts                           # Access token create (api_key visible 1×)
      api/v1/tokens/[tokenId]/route.ts                 # PATCH (name/status/capabilities) / DELETE
      api/v1/tokens/[tokenId]/rotate-key/route.ts      # Rotate api_key
      api/v1/orgs/[slug]/transfer-ownership/route.ts   # Owner-only ownership transfer
      dashboard/page.tsx                               # User's organizations
      orgs/
        new/page.tsx                                   # Create org (creator becomes owner)
        [slug]/
          page.tsx                                     # Org dashboard
          members/page.tsx                             # Members + owner badge + transfer flow
          audit/page.tsx                               # Audit log
          providers/github/
            connect/page.tsx                           # OAuth → install URL
            callback/route.ts                          # OAuth callback handler
          projects/
            new/page.tsx                               # Create project
            [project]/
              page.tsx                                 # Project detail (bindings + access tokens)
              bindings/new/page.tsx                    # Bind a resource
              tokens/new/page.tsx                      # Create an access token (api_key reveal)
              tokens/[tokenId]/page.tsx                # Access token detail + actions
    components/
      sidebar/Sidebar.tsx                              # Contextual nav (General / Org / Project / Resources)
    lib/
      supabase/server.ts                               # ssr-typed clients (anon + service)
      supabase/client.ts                               # browser client
      auth/require-org-member.ts                       # requireOrgMember + requireOrgOwner guards
      oauth/state.ts                                   # state nonce generator
      gateway/build.ts                                 # wire McpGateway with adapters
  next.config.ts
  tsconfig.json
  .env.local.example
```

## Auth

- Supabase magic-link (`auth.signInWithOtp`) + GitHub SSO.
- Session cookie via `@supabase/ssr`.
- `/auth/callback?code=...` exchanges the code for a session.
- All UI routes check `auth.getUser()` server-side and redirect to `/login`
  if missing.

## Membership model

Cf. [[flat-membership-org-owner-access-token]] (ADR).

- **Flat** : appartenir à `org_members` = full RW sur tout le contenu de l'org.
- **Owner** : `organizations.owner_id` (FK auth.users), 1 par org. Protégé
  contre la suppression depuis `org_members` (RLS refuse). Pour quitter,
  l'owner doit transférer via `POST /api/v1/orgs/:slug/transfer-ownership`.
- Le créateur d'une org devient owner ; un trigger DB l'inscrit
  automatiquement dans `org_members` (`enforce_owner_is_member`).

Guards REST :

- `requireOrgMember(orgSlug)` — utilisé par toutes les mutations org-scoped.
- `requireOrgOwner(orgSlug)` — utilisé uniquement par le transfert d'ownership.

## Sidebar contextuelle

`packages/web/src/components/sidebar/Sidebar.tsx` rend une nav qui s'enrichit
selon l'URL :

- **General** : lien Dashboard + dropdown org switcher.
- **Org section** (si `/orgs/:slug` dans l'URL) : Projects / Cloud providers /
  Members / Audit log / Settings + dropdown project switcher. (Plus de section
  Roles : le modèle de rôles a été remplacé par les capabilities portées
  directement par l'access token — cf. `0011_capabilities_replace_roles.sql`.)
- **Project section** (si `/orgs/:slug/projects/:project`) : Overview / Audit
  log / Access tokens.
- **Resources** : Documentation / Support.

Les listes orgs + projects sont fetched server-side dans
`packages/web/src/app/(app)/layout.tsx` et passées en prop.

## OAuth GitHub flow

1. UI button → `GET /orgs/<slug>/providers/github/connect` (server component).
2. Server generates a `state` nonce, stores it in `vbn_oauth_state` cookie
   (5-min TTL, single-use), and redirects to GitHub App install URL.
3. GitHub callback → `GET /orgs/<slug>/providers/github/callback?installation_id=...&state=...`.
4. Handler verifies state cookie, then upserts `provider_admins` via the
   service_role client (RLS-bypass — the caller is an authenticated org member).

## Access token creation (api_key visible 1×)

Hot path :

```
POST /api/v1/tokens {orgSlug, projectSlug, name, capabilities}
  ├─ capabilities[]: shorthand strings → parseCapability() (400 on malformed)
  ├─ requireOrgMember(orgSlug)
  ├─ generateApiKey('live') → {apiKey, apiKeyPrefix}
  ├─ hashApiKey(apiKey) → apiKeyHash (argon2id)
  ├─ INSERT access_tokens (api_key_prefix, api_key_hash, capabilities jsonb, ...)
  └─ → { access_token, api_key }  ← visible only here
```

`capabilities` is an array of notation strings (`'github:repo/code:read'`,
`'vercel:runtime/deployment:write@prod'`, `'supabase:db/rows:read@staging'`, …)
parsed via `parseCapability` from `@vaubaan/shared` and stored inline as the
full `(provider, plane, level, action, env?)` tuples on the
`access_tokens.capabilities` jsonb column. There is no more `roles` /
`access_token_roles` join — the old role model was dropped in migration
`0011_capabilities_replace_roles.sql`. Same swap applies to
`POST /api/v1/mgmt/tokens` and the optional `capabilities` field of
`PATCH /api/v1/tokens/[tokenId]`.

**Policy + approval flow** (migrations `0012` & `0013`). At mint, both the
mgmt and user routes consult `policy_rules` for the project and refuse any
capability that resolves to `gate='human'` — by inserting an
`approval_requests` row dispatched via the project's `ApprovalChannel`
(manual or telegram) and returning **HTTP 202** with `{ approval_id, status:
'pending', poll_url, channel, gated }`. Once the operator clicks ✅, the
poll endpoint mints the access_token and returns the `api_key` once.
`POST /api/v1/tokens` returns 201 immediately on the all-ai fast path.
`POST /api/v1/mgmt/tokens` also accepts `singleUse?: bool` (the gateway
consumes the token on the first call that matches a capability — spec §8)
and `ttlSeconds?: number` (capped at 3600s) for short-lived single-use
tokens.

UI : after create, a modal displays the full api_key with a Copy button and
a warning `won't be shown again`. The modal also shows the snippet to drop in
`~/.config/claude/mcp.json` :

```jsonc
{
  "mcpServers": {
    "vauban": {
      "url": "https://vaubaan.com/mcp",
      "headers": { "Authorization": "Bearer vbn_live_..." },
    },
  },
}
```

The vocabulary is intentionally neutral — an access token can be consumed by
an LLM agent, a CI job, a script, or a human curl. The UI placeholder is
`ci-deploy` rather than `claude-dev` to avoid presuming agent usage.

### Capability picker (create + edit)

Both `tokens/new/page.tsx` and the `Capabilities` card of
`tokens/[tokenId]/controls.tsx` drive the grant set the same way :

- A checklist of curated presets from
  `packages/web/src/lib/capabilities/presets.ts` (`CAPABILITY_PRESETS`,
  label → shorthand). Each row submits its shorthand value.
- A free-text field for an arbitrary capability shorthand, validated with
  `parseCapability` from `@vaubaan/shared` before being added (rejects
  malformed grammar client-side).
- The submitted body is `capabilities: string[]` (shorthands). On the detail
  page, the stored full tuples are read off `access_tokens.capabilities` and
  rendered back to shorthand via `formatCapability` ; presets vs. custom are
  split by membership in `PRESET_VALUES`.

The per-token audit table and the org/project audit logs show
`capability_matched` (the shorthand of the capability that allowed the call,
or the denial reason) — renamed from `role_matched` in
`0011_capabilities_replace_roles.sql`.

## Ownership transfer

```
POST /api/v1/orgs/:slug/transfer-ownership { newOwnerId }
  ├─ requireOrgOwner(slug)           # only the current owner
  ├─ verify newOwnerId is in org_members
  └─ UPDATE organizations SET owner_id = newOwnerId
```

UI surface : Members page → if `currentUser === ownerId`, a "Transfer
ownership" section appears under the members table with a dropdown of other
members and an explicit confirm dialog.

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
Writes that need to bypass RLS (access_token insert, provider_admins upsert,
audit_log insert) use the service_role client (`getSupabaseServiceClient()`).

The service_role client is server-only and never reaches the browser bundle.
