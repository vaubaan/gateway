---
title: Next.js web app
status: current
date: 2026-06-16
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
            providers/[provider]/page.tsx               # Provider info — data-model mermaid + risk catalog + tools
            settings/{page,management-keys/page}.tsx    # Org settings + mgmt key vault
            projects/
              new/page.tsx                              # Create project
              [project]/
                page.tsx                                # Project overview (bindings + bash + tokens cards)
                audit/page.tsx                          # Project audit log
                tokens/page.tsx                         # Access tokens list
                tokens/new/*.{ts,tsx}                   # v4 risk-checklist mint flow (9 files)
                                                        # page.tsx (server) + mint-form.tsx (orchestrator)
                                                        # + binding-risks-section / provider-risks-card
                                                        # + risk-row / vector-row / preview-footer
                                                        # + mint-result-dialog + mint-types + qualify-helpers
                approvals/page.tsx                      # Pending approval requests
                settings/page.tsx                       # Project settings
                bash/page.tsx                           # Redirect → bindings/new
                bash-bindings/[bindingId]/page.tsx      # Script + hosts + runner cards
      api/
        integrations/{github,vercel,supabase,railway}/{connect,callback}/route.ts
        v1/
          tokens/                                       # unified-tokens API (post-2026-06-16)
            {[tokenId]/route, [tokenId]/rotate-key/route}.ts
            mint/route.ts                               # POST — mint child from any vbn_live_*
            preview/route.ts                            # POST — gate preview (no persist)
            pending/[id]/route.ts                       # GET — long-poll approval
          mgmt/approvals/[id]/route.ts                  # operator decide via Bearer vbn_live_*
          mgmt/projects/route.ts                        # listing for SDK compat
          orgs/[slug]/{route, transfer-ownership/route}.ts
          orgs/[slug]/management-keys/{route, [keyId]/route}.ts  # UI shim: root org-scoped tokens
          projects/[projectId]/{route}.ts
          projects/[projectId]/approvals/{route, [approvalId]/route}.ts
          providers/[provider]/route.ts                 # disconnect
          bindings/[bindingId]/route.ts                 # remove a provider binding
          bash-bindings/{route, [bindingId]/route}.ts
          bash-bindings/[bindingId]/hosts/{route, [hostId]/route, [hostId]/test/route}.ts
          bash-bindings/[bindingId]/run-tool/route.ts
          members/{route, [userId]/route}.ts
          integrations/telegram/webhook/route.ts        # Telegram approval callbacks
          integrations/email/decide/route.ts            # Email approval (signed link)
          catalog/route.ts                              # Risk catalog dump (per-provider)
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
      auth/{require-org-member, require-token}.ts       # session + Bearer guards (post-unified-tokens)
      oauth/{state, railway}.ts                         # nonce + PKCE helpers
      providers/{state, bytea}.ts                       # provider_admins helpers
      gateway/build.ts                                  # wire McpGateway with adapters + catalogs
      risk-catalog/loader.ts                            # boot-time provider catalog index (v4)
      mint/{preview, risk-preview}.ts                   # gate-resolution helpers (pure compute + DB plumbing)
      approvals/{channel, manual, telegram, email, email-token,
                 mint, decide, external-mint, load-parent, index}.ts
      bash/{parse, exec, args, exec-host}.ts           # annotated-bash provider — cf. bash-provider handbook
    components/providers/
      provider-info.ts                                  # static per-provider strings (label, planes, mint mode)
      MermaidDiagram.tsx                                # client component rendering data-model mermaid
      data-model-to-mermaid.ts                          # DataModel → mermaid source
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
- `requireToken(authHeader)` — pour les routes `/api/v1/tokens/*` +
  `/api/v1/mgmt/approvals/*` qui consomment un Bearer `vbn_live_*`.
  Remplace l'ancien `requireManagementKey` (`vbn_mgmt_*` n'existe plus
  post-unified-tokens, cf. ADR
  [[unified-tokens-delegation-chain-and-escalation-channel]]).

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

Les sous-pages projet `tokens/new/`, `approvals/`, `settings/`,
`bash-bindings/[bindingId]/` ne figurent **pas** dans la sidebar — elles
sont atteintes via les cards de l'Overview (`projects/[project]/page.tsx`)
ou par lien direct. Le modèle Roles + le modèle Capabilities v1 ont
été remplacés en bloc par le modèle v4 **risk-based** : l'access token
porte directement `accepted_risks: RiskId[]` (cf. spec
[`gateway-risk-model.md`](../spec/gateway-risk-model.md)). La page
`/orgs/[slug]/providers/[provider]/` rend pour chaque provider le
data-model en mermaid + le risk catalog YAML + la liste des tools MCP,
en s'appuyant sur `components/providers/` et `lib/risk-catalog/`.

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

## Token creation (api_key visible 1×, unified-tokens)

> **2026-06-16** : refacto unified-tokens — un seul endpoint mint
> consommant n'importe quel `vbn_live_*` (org-scoped root ou
> project-scoped child). Cf. ADR
> [[unified-tokens-delegation-chain-and-escalation-channel]] et
> handbook [[approvals]] §Mint flow pour le détail complet.

Hot path utilisateur (cf. spec
[`gateway-risk-model.md`](../spec/gateway-risk-model.md) §9) :

```
POST /api/v1/tokens/mint
  Authorization: Bearer vbn_live_…
  { scope: 'org' | 'project',
    projectId? | projectSlug?,
    bindings[], accepted_risks[], denied_risks?,
    name?, ttlHours?, ttlSeconds?, singleUse?, context? }
  │
  ├─ requireToken           (vbn_live_* → guard.token = MintParent)
  ├─ computeMintPreview     (catalogs × project_risk_policies × bindings)
  │     → per-risk effective_gate (allow | confirm | deny)
  │
  ├─ any deny → 403 { error, denied_risks, risks }
  ├─ all allow → mintChildToken (subset/depth/expires invariants enforced) :
  │     ├─ generateApiKey('live') → {apiKey, apiKeyPrefix}
  │     ├─ hashApiKey(apiKey) → apiKeyHash (argon2id)
  │     ├─ delegation_chain = parent.delegation_chain + parent
  │     ├─ INSERT tokens (parent_id, depth, delegation_chain,
  │     │                  accepted_risks, denied_risks, …)
  │     └─ → 201 { token, api_key, accepted_risks }  ← visible only here
  │
  └─ any confirm → INSERT approval_requests + pickChannel + notify
                → 202 { approval_id, status:'pending', channel, poll_url,
                        needs_approval, risks }
```

Le wire format est porté par `RiskId[]` plutôt que par des tuples
capability `(provider, plane, level, action, env?)`. Le catalog
canonique de chaque provider vit dans
`packages/providers/<vendor>/src/risk-catalog.{yaml,ts}` et est chargé
au boot par `lib/risk-catalog/loader.ts` (cf.
[`policy-engine.md`](./policy-engine.md) §Wiring côté gateway).
L'helper `computeMintPreview` (`lib/mint/preview.ts`) wraps le pur
`computePreview` (`lib/mint/risk-preview.ts`) avec le DB load des
`project_risk_policies` ; les deux sont consommés par le mint endpoint
et le preview endpoint.

Le mint endpoint accepte `singleUse?: bool` (le gateway consume le
token sur le premier call — spec §8), `ttlHours?: number` (default
24h, max 7j) et `ttlSeconds?: number` (capé à 3600s — single-use
obligatoire, cf. Zod refine). Full details in
[`approvals.md`](./approvals.md).

L'endpoint preview `POST /api/v1/tokens/preview` calcule la même
résolution sans persister — utilisé par le composant `mint-form.tsx`
pour afficher la checklist des risques en temps réel.

UI : après create, un modal affiche la `api_key` complète avec bouton
Copy et un warning `won't be shown again`. Le modal montre aussi le
snippet à coller dans `~/.config/claude/mcp.json` :

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

### Risk checklist picker (mint form)

`tokens/new/mint-form.tsx` est le composer v4 :

- Pour chaque provider × binding, fetch le catalog via
  `GET /api/v1/catalog?provider=<p>` (cf.
  `app/api/v1/catalog/route.ts`) — liste de risques avec
  `effective_gate` (dérivé côté serveur via `computeMintPreview`).
- Render en checklist groupée par bucket de sévérité : `allow`
  (cochable freely) / `confirm` (cochable, mais le mint passera en 202)
  / `deny` (greyed-out — blocked par project policy + tooltip avec la
  raison).
- Soumet `accepted_risks: RiskId[]` + `denied_risks?: RiskId[]` à
  `POST /api/v1/tokens/mint`.

`lib/mint/risk-preview.ts` est la **single source of truth** pour la
résolution de gate (pure compute) ; `lib/mint/preview.ts` wraps avec
le DB load. Les deux routes mint/preview les consomment.

La table d'audit (`audit_log`) stocke désormais `slices_executed`,
`risks_touched`, et `token_accepted_risks_snapshot` (cf.
[`mcp-gateway.md`](./mcp-gateway.md) §Audit).

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
Writes that need to bypass RLS (`tokens` insert, provider_admins
upsert, audit_log insert, bash_bindings, approval_requests) use the
service_role client (`getSupabaseServiceClient()`).

Le service_role client est server-only et n'atteint jamais le bundle
browser.
