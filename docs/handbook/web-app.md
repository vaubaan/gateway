---
title: Next.js web app
status: current
date: 2026-06-11
tracks:
  - packages/web/src/app/
  - packages/web/src/components/sidebar/Sidebar.tsx
  - packages/web/src/components/providers/
  - packages/web/src/lib/approvals/
  - packages/web/src/lib/mint/
  - packages/web/src/lib/risk-catalog/
  - packages/web/src/lib/auth/
  - packages/web/src/lib/oauth/
  - packages/web/src/lib/providers/
  - packages/web/src/lib/supabase/
  - packages/web/src/lib/gateway/
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
      layout.tsx
      (public)/                                         # Marketing + legal shell
        layout.tsx
        page.tsx                                        # Landing
        login/page.tsx                                  # Magic-link + GitHub SSO
        {about,pricing,changelog,integrations,contact,support}/page.tsx
        {privacy,terms,security,dpa,subprocessors,brand}/page.tsx
      (app)/                                            # Authenticated shell
        layout.tsx                                      # Sidebar + auth gate
        dashboard/page.tsx                              # User's organizations
        docs/{page,mgmt/page}.tsx                       # In-app reference
        orgs/
          new/page.tsx                                  # Create org (creator → owner)
          [slug]/
            page.tsx                                    # Org dashboard
            members/page.tsx                            # Members + owner badge + transfer
            audit/page.tsx                              # Org audit log
            providers/page.tsx                          # Org-wide providers catalogue
            providers/[provider]/page.tsx               # Per-provider connect/state
            settings/{page,management-keys/page}.tsx    # Org settings + mgmt key vault
            projects/
              new/page.tsx                              # Create project
              [project]/
                page.tsx                                # Project overview (bindings + bash + tokens cards)
                audit/page.tsx                          # Project audit log
                tokens/page.tsx                         # Access tokens list + create
                rings/page.tsx                          # Capability rings reference
                policy/page.tsx                         # Policy rules editor
                approvals/page.tsx                      # Pending approval requests
                settings/page.tsx                       # Project settings
                bash/page.tsx                           # Redirect → bindings/new
                bash-bindings/[bindingId]/page.tsx      # Script + hosts + runner cards
      api/
        integrations/{github,vercel,supabase,railway}/{connect,callback}/route.ts
        v1/
          tokens/{route, [tokenId]/route, [tokenId]/rotate-key/route}.ts
          mgmt/tokens/{route, [tokenId]/route, pending/[id]/route}.ts
          mgmt/approvals/[id]/route.ts                  # operator decide (allow/deny)
          mgmt/projects/route.ts
          orgs/[slug]/{route, transfer-ownership/route}.ts
          orgs/[slug]/management-keys/{route, [keyId]/route}.ts
          projects/[projectId]/{route, policy/route, policy/[ruleId]/route}.ts
          projects/[projectId]/approvals/{route, [approvalId]/route}.ts
          providers/[provider]/route.ts                 # disconnect
          bindings/[bindingId]/route.ts                 # remove a provider binding
          bash-bindings/{route, [bindingId]/route}.ts
          bash-bindings/[bindingId]/hosts/{route, [hostId]/route, [hostId]/test/route}.ts
          bash-bindings/[bindingId]/run-tool/route.ts
          members/{route, [userId]/route}.ts
          integrations/telegram/webhook/route.ts        # Bot approval callbacks
      mcp/route.ts                                      # MCP gateway POST
      auth/callback/route.ts                            # Supabase auth callback
      agent-bootstrap.md/route.ts                       # served bootstrap doc
    components/
      sidebar/Sidebar.tsx                               # Contextual nav (orgs / projects)
      ui/                                               # Card, Button, Badge, Code, Table…
      public/                                           # PublicShell, Prose
      LocalDate.tsx, icons.tsx
    lib/
      supabase/{server, client}.ts                      # ssr-typed clients (anon + service)
      auth/{require-org-member, require-management-key}.ts
      oauth/{state, railway}.ts                         # nonce + PKCE helpers
      providers/{state, bytea}.ts                       # provider_admins helpers
      gateway/build.ts                                  # wire McpGateway with adapters
      approvals/{channel, manual, telegram, mint, decide, index}.ts
      capabilities/{ring-catalog, ring-grid}.tsx        # UI cap composer
      bash/{parse, exec}.ts                             # annotated-bash provider — cf. bash-provider handbook
  next.config.ts
  tsconfig.json
  .env.local.example
```

> Le sous-arbre bash provider (`api/v1/bash-bindings/...`, `lib/bash/`,
> UI `bash-bindings/[bindingId]/`) est documenté en détail dans
> [`bash-provider.md`](./bash-provider.md).

## Auth

- Supabase magic-link (`auth.signInWithOtp`) + GitHub SSO
  (cf. [`auth-github-sso.md`](./auth-github-sso.md)).
- Session cookie via `@supabase/ssr`.
- `/auth/callback?code=...` exchanges the code for a session.
- All UI routes check `auth.getUser()` server-side and redirect to `/login`
  if missing (gated par `(app)/layout.tsx`).

## Membership model

Cf. [[flat-membership-org-owner-access-token]] (ADR).

- **Flat** : appartenir à `org_members` = full RW sur tout le contenu de l'org.
- **Owner** : `organizations.owner_id` (FK auth.users), 1 par org. Protégé
  contre la suppression depuis `org_members` (RLS refuse). Pour quitter,
  l'owner doit transférer via `POST /api/v1/orgs/:slug/transfer-ownership`.
- Le créateur d'une org devient owner ; un trigger DB l'inscrit
  automatiquement dans `org_members` (`enforce_owner_is_member`).

Guards REST (`packages/web/src/lib/auth/`) :

- `requireOrgMember(orgSlug)` — utilisé par toutes les mutations org-scoped.
- `requireOrgOwner(orgSlug)` — utilisé uniquement par le transfert d'ownership.
- `requireManagementKey(req)` — pour les routes `/api/v1/mgmt/*` qui
  consomment un PAT Vaubaan (`vbn_mgmt_…`) au lieu d'une session.

## Sidebar contextuelle

`packages/web/src/components/sidebar/Sidebar.tsx` rend une nav qui s'enrichit
selon l'URL :

- **General** : lien Organizations (Dashboard).
- **Org section** (si `/orgs/:slug` dans l'URL) : `Projects` /
  `Cloud providers` / `Members` / `Audit log` / `Settings` + dropdown
  org switcher (`HeadSelect`).
- **Project section** (si `/orgs/:slug/projects/:project`) : `Overview` /
  `Audit log` / `Access tokens` + dropdown project switcher.
- **Resources** : `Documentation` / `Support`.

Les sous-pages projet `rings/`, `policy/`, `approvals/`, `settings/`,
`bash-bindings/[bindingId]/` ne figurent **pas** dans la sidebar — elles
sont atteintes via les cards de l'Overview (`projects/[project]/page.tsx`)
ou par lien direct. Le modèle Roles n'est plus représenté : les
capabilities portées directement par l'access token l'ont remplacé
(migration `0015_capabilities_replace_roles.sql`).

Les listes orgs + projects sont fetched server-side dans
`packages/web/src/app/(app)/layout.tsx` et passées en prop. La sidebar
re-fetch côté router quand l'URL pointe vers un projet absent du
payload (cache stale, projet créé dans un autre onglet — `Sidebar.tsx:101-105`).

## OAuth GitHub flow

Le path est **fixe et slug-agnostique** côté GitHub App (un seul "Setup URL"
configuré). Le slug est ré-encodé dans le `state` nonce.

1. UI button → `GET /api/integrations/github/connect?org=<slug>`.
2. Le handler vérifie `requireOrgMember`, génère un `state` qui encode
   `orgId` (`lib/oauth/state.ts:generateState`), stocke ce state dans le
   cookie `vbn_oauth_state` (5min, single-use), et redirige vers
   `https://github.com/apps/<GITHUB_APP_SLUG>/installations/new`.
3. GitHub callback → `GET /api/integrations/github/callback?installation_id=...&state=...&setup_action=install`.
4. Le handler vérifie le cookie state, décode `orgId`, puis upserte
   `provider_admins` via le service_role client (RLS-bypass — le caller
   est un membre d'org authentifié).

Les autres providers OAuth (Vercel, Supabase, Railway) suivent le même
shape : `/api/integrations/<provider>/{connect,callback}/route.ts`.

## Access token creation (api_key visible 1×)

Hot path utilisateur :

```
POST /api/v1/tokens {orgSlug, projectSlug, name, capabilities, context?}
  ├─ capabilities[]: shorthand strings → parseCapability() (400 on malformed)
  ├─ requireOrgMember(orgSlug)
  ├─ load policy_rules eq project_id
  ├─ evaluatePolicy(caps, rules)
  │     ├─ any 'deny' → 403 (no override)
  │     ├─ any 'confirm' → open approval flow → 202 { approval_id, ... }
  │     └─ all 'allow'  → mint immediately:
  │         ├─ generateApiKey('live') → {apiKey, apiKeyPrefix}
  │         ├─ hashApiKey(apiKey) → apiKeyHash (argon2id)
  │         ├─ INSERT access_tokens (api_key_prefix, api_key_hash,
  │         │                         capabilities jsonb, ...)
  │         └─ → 201 { access_token, api_key }  ← visible only here
```

`capabilities` is an array of notation strings (`'github:repo/code:read'`,
`'vercel:runtime/deployment:write@prod'`, `'supabase:db/rows:read@staging'`,
`'bash:logs:read@vps-rp'`, …) parsed via `parseCapability` from
`@vaubaan/shared` and stored inline as the full
`(provider, plane, level, action, env?)` tuples on the
`access_tokens.capabilities` jsonb column. There is no more `roles` /
`access_token_roles` join — the old role model was dropped in migration
`0015_capabilities_replace_roles.sql`. Same swap applies to
`POST /api/v1/mgmt/tokens` and the optional `capabilities` field of
`PATCH /api/v1/tokens/[tokenId]`.

**Policy + approval flow** (migrations `0013_approvals.sql`,
`0014_single_use_tokens.sql`, `0016_policy_rules.sql`,
`0018_gate_allow_confirm_deny.sql`). At mint, both the mgmt and user
routes consult `policy_rules` for the project. The decision per capability
is `allow | confirm | deny` (`evaluatePolicy`). Any `deny` → 403 final.
Any `confirm` → insert an `approval_requests` row dispatched via the
project's `ApprovalChannel` (manual or telegram, cf.
`packages/web/src/lib/approvals/`) and return **HTTP 202** with
`{ approval_id, status: 'pending', poll_url, channel, gated }`. Once the
operator clicks ✅ (Telegram callback or
`POST /api/v1/mgmt/approvals/:id`), the pending row is consumed by the
poll endpoint which mints the access_token and returns the `api_key`
once. `POST /api/v1/tokens` returns 201 immediately on the all-ai fast
path. `POST /api/v1/mgmt/tokens` also accepts `singleUse?: bool` (the
gateway consumes the token on the first call that matches a capability —
spec §8) and `ttlSeconds?: number` (capped at 3600s) for short-lived
single-use tokens. Full details in
[`capability-policy-and-approvals.md`](./capability-policy-and-approvals.md).

UI : after create, a modal displays the full api_key with a Copy button
and a warning `won't be shown again`. The modal also shows the snippet to
drop in `~/.config/claude/mcp.json` :

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

The vocabulary is intentionally neutral — an access token can be consumed
by an LLM agent, a CI job, a script, or a human curl. The UI placeholder
is `ci-deploy` rather than `claude-dev` to avoid presuming agent usage.

### Capability picker (create + edit)

`packages/web/src/lib/capabilities/ring-catalog.ts` est la source de vérité
UI : un catalogue statique des planes × levels (rings) × archetypes par
provider, utilisé par `ring-grid.tsx` (le composer visuel sur la page
`tokens/new` et la card `Capabilities` de `tokens/[tokenId]`).

- Une grille concentrique (ring 1 = innermost → ring N = outermost) avec
  une action `read` / `write` par cellule.
- Un sélecteur d'env quand `LevelDescriptor.envScoped === true` ; sinon
  le tuple est env-less.
- Un free-text field pour une notation arbitraire, validée par
  `parseCapability` côté client avant ajout.
- Le body soumis est `capabilities: string[]` (shorthands). Sur la detail
  page, les tuples stockés sont rendus en shorthand via
  `formatCapability`.

> Note runtime : le catalog est **descriptif**, pas enforcing. Le
> classifier d'un provider accepte des slugs arbitraires ; un cap typé
> dans le free-text passe même si absent du catalog (cf. `ring-catalog.ts:10-15`).

La table d'audit (`audit_log`) stocke `capability_matched` (la notation
de la capability qui a autorisé l'appel, ou la denial reason) — renommé
depuis `role_matched` par `0015_capabilities_replace_roles.sql`.

## Ownership transfer

```
POST /api/v1/orgs/:slug/transfer-ownership { newOwnerId }
  ├─ requireOrgOwner(slug)           # only the current owner
  ├─ verify newOwnerId is in org_members
  └─ UPDATE organizations SET owner_id = newOwnerId
```

UI surface : Members page → if `currentUser === ownerId`, a "Transfer
ownership" section appears under the members table with a dropdown of
other members and an explicit confirm dialog.

## /mcp endpoint

`packages/web/src/app/mcp/route.ts` is a thin HTTP→McpGateway adapter :

- Parses JSON body, validates JSON-RPC envelope.
- Builds the gateway via `buildGateway()` (`lib/gateway/build.ts`,
  loads env vars, wires Supabase service client + provider adapters +
  cache + audit writer).
- Calls `gateway.authenticate(authHeader)` → if AuthError, returns 401
  with `error.code = -32001`.
- Calls `gateway.handle(ctx, req)` → returns the JSON-RPC response
  (always 200 for policy denials — the JSON-RPC error envelope encodes
  them).
- Misconfiguration (missing GITHUB_APP_PRIVATE_KEY etc) → 503 with
  explicit message.

Cf. [`mcp-gateway.md`](./mcp-gateway.md) pour le flow interne du gateway.

## RLS — practical notes

Read paths use the user-bound `getSupabaseServer()` client (RLS enforced).
Writes that need to bypass RLS (access_token insert, provider_admins
upsert, audit_log insert, bash_bindings, approval_requests) use the
service_role client (`getSupabaseServiceClient()`).

Le service_role client est server-only et n'atteint jamais le bundle
browser.
