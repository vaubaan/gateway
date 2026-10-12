---
title: Next.js web app
status: legacy
date: 2026-06-16
tracks:
  - apps/gateway/src/app/
  - apps/gateway/src/components/sidebar/Sidebar.tsx
  - apps/gateway/src/components/providers/
  - apps/gateway/src/lib/mint/
  - apps/gateway/src/lib/risk-catalog/
  - apps/gateway/src/lib/auth/
  - apps/gateway/src/lib/oauth/
  - apps/gateway/src/lib/providers/
  - apps/gateway/src/lib/crypto/
  - apps/gateway/src/lib/supabase/
  - apps/gateway/src/lib/gateway/
  - apps/gateway/next.config.ts
---

> **Legacy v4 document.** Kept for history; superseded by the v5 spec. Not maintained.

# Web app — `@vaubaan/gateway-app`

Le control plane UI + le `/mcp` endpoint. Next.js 15 App Router, Supabase
magic-link auth, server-side rendering, dynamic routes.

## Layout

```
apps/gateway/
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
        docs/page.tsx                                    # In-app reference
        orgs/
          new/page.tsx                                  # Create org (creator → owner)
          [slug]/
            page.tsx                                    # Org dashboard
            members/page.tsx                            # Members + owner badge + transfer
            audit/page.tsx                              # Org audit log
            providers/page.tsx                          # Org-wide providers catalogue
            providers/[provider]/page.tsx               # Provider info — data-model mermaid + risk catalog + tools
            settings/page.tsx                             # Org settings
            projects/
              new/page.tsx                              # Create project
              [project]/
                page.tsx                                # Project overview (bindings + bash + tokens cards)
                audit/page.tsx                          # Project audit log
                tokens/page.tsx                         # Access tokens list
                tokens/new/*.{ts,tsx}                   # Risk-checklist mint flow (10 files)
                                                        # page.tsx (server) + mint-form.tsx (orchestrator)
                                                        # + binding-risks-section / provider-risks-card
                                                        # + risk-row / vector-row / preview-footer
                                                        # + mint-result-dialog + mint-types + qualify-helpers
                bindings/new/{page,binding-form}.tsx    # Generic binding creation (any provider — provider/bash)
                bindings/[bindingId]/edit/page.tsx      # Edit an existing binding
                settings/page.tsx                       # Project settings
                bash/page.tsx                           # Redirect → bindings/new
                bash-bindings/[bindingId]/page.tsx      # Script + hosts + runner cards
      api/
        integrations/{github,vercel,supabase,railway}/{connect,callback}/route.ts
        v1/
          tokens/                                       # unified-tokens API
            {[tokenId]/route, [tokenId]/rotate-key/route}.ts
            mint/route.ts                               # POST — mint child from any vbn_live_*
            preview/route.ts                            # POST — preview (acceptable / inherited)
          orgs/[slug]/{route, transfer-ownership/route}.ts
          projects/[projectId]/{route}.ts
          providers/[provider]/route.ts                 # disconnect
          bindings/[bindingId]/route.ts                 # remove a provider binding
          bash-bindings/{route, [bindingId]/route}.ts
          bash-bindings/[bindingId]/hosts/{route, [hostId]/route, [hostId]/test/route}.ts
          bash-bindings/[bindingId]/run-tool/route.ts
          members/{route, [userId]/route}.ts
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
      risk-catalog/loader.ts                            # boot-time provider catalog index
      mint/{preview, risk-preview, child-mint, token-name}.ts  # pure preview, child-mint, name regex
      bash/{parse, exec, args, exec-host}.ts            # annotated-bash provider — cf. bash-provider handbook
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

Guards REST (`apps/gateway/src/lib/auth/`) :

- `requireOrgMember(orgSlug)` — utilisé par toutes les mutations org-scoped.
- `requireOrgOwner(orgSlug)` — utilisé uniquement par le transfert d'ownership.
- `requireToken(authHeader, options?)` — pour les routes
  `/api/v1/tokens/*` qui consomment un Bearer `vbn_live_*` (cf. ADR
  [[unified-tokens-delegation-chain-and-escalation-channel]]).
  Retourne un union discriminé : `mode='bearer'` (child mint, parent
  token résolu) ou `mode='session'` (root mint, session cookie).
  Avec `options.allowSessionFallback: { orgId }`, le guard
  bascule en mode cookie-auth quand le Bearer est absent : il résout
  la session Supabase et vérifie la membership de l'org cible. Le mint
  endpoint crée alors un root token directement (`parent_id IS NULL`,
  `depth=0`, pas de subset check). C'est ce qui permet à la UI mint
  `/tokens/new` de fonctionner sans Bearer — la session suffit.

## Sidebar contextuelle

`apps/gateway/src/components/sidebar/Sidebar.tsx` rend une nav qui s'enrichit
selon l'URL :

- **General** : lien Organizations (Dashboard).
- **Org section** (si `/orgs/:slug` dans l'URL) : `Projects` /
  `Cloud providers` / `Members` / `Audit log` / `Settings` + dropdown
  org switcher (`HeadSelect`).
- **Project section** (si `/orgs/:slug/projects/:project`) : `Overview` /
  `Audit log` / `Access tokens` + dropdown project switcher.
- **Resources** : `Documentation` / `Support`.

Les sous-pages projet `tokens/new/`, `settings/`,
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
`apps/gateway/src/app/(app)/layout.tsx` et passées en prop. La sidebar
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
   est un membre d'org authentifié). GitHub ne stocke pas de token
   (App Install mode), donc l'upsert est direct.

Les autres providers OAuth (Vercel, Supabase, Railway) suivent le même
shape : `/api/integrations/<provider>/{connect,callback}/route.ts`.
Les callbacks qui stockent des tokens (Vercel, Supabase, Railway)
chiffrent côté app via `encryptProviderSecret(orgId, token)` puis
upsertent avec `encodeByteaHexRaw(...)` dans `provider_admins` (cf.
ADR [[per-org-encryption-app-level]], migration `0037`). Les refresh
flows (Supabase, Railway) réécrivent via
`.from('provider_admins').update()` avec le même pattern encrypt. Les
lectures déchiffrent via `decodeBytea()` → `decryptProviderSecret()`
(`lib/crypto/provider-secrets.ts`).

## Token creation (api_key visible 1×, unified-tokens + drop-confirm)

> **2026-06-16** : refacto unified-tokens + drop-confirm — un seul endpoint
> mint consommant n'importe quel `vbn_live_*`, qui répond 201 ou 4xx
> (plus de 202 mint-pending). Cf. ADR
> [[unified-tokens-delegation-chain-and-escalation-channel]] +
> [[unified-gates-drop-confirm]] et handbook [[escalation]] pour le
> runtime fallback quand un risk manque.

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
  ├─ computeMintPreview     (catalogs × bindings × parent.accepted_risks)
  │     → per-risk { acceptable, inherited }
  │
  ├─ !preview.ok → 403 { error, not_acceptable, not_inherited, risks }
  └─ preview.ok  → mintChildToken (subset/depth/expires invariants enforced) :
        ├─ generateApiKey('live') → {apiKey, apiKeyPrefix}
        ├─ hashApiKey(apiKey) → apiKeyHash (argon2id)
        ├─ delegation_chain = parent.delegation_chain + parent
        ├─ INSERT tokens (parent_id, depth, delegation_chain,
        │                  accepted_risks, denied_risks, …)
        └─ → 201 { token, api_key, accepted_risks }  ← visible only here
```

Le wire format est porté par `RiskId[]` plutôt que par des tuples
capability `(provider, plane, level, action, env?)`. Le catalog
canonique de chaque provider vit dans
`plugins/<vendor>/src/risk-catalog.{yaml,ts}` et est chargé
au boot par `lib/risk-catalog/loader.ts` (cf.
[`policy-engine.md`](./policy-engine.md) §Wiring côté gateway).
L'helper `computeMintPreview` (`lib/mint/preview.ts`) wraps le pur
`computePreview` (`lib/mint/risk-preview.ts`) — pas de DB read
post-drop-confirm. Les deux sont consommés par le mint endpoint et le
preview endpoint.

Le mint endpoint accepte `singleUse?: bool` (le gateway consume le
token sur le premier call — spec §8), `ttlHours?: number` (default
24h, max 7j) et `ttlSeconds?: number` (capé à 3600s — single-use
obligatoire, cf. Zod refine). Full details in
[`escalation.md`](./escalation.md).

L'endpoint preview `POST /api/v1/tokens/preview` calcule la même
résolution sans persister — utilisé par le composant `mint-form.tsx`
pour afficher la checklist des risques en temps réel. Chaque row
porte deux booleans : `acceptable` (catalog `acceptable_in_envs` OK
pour le binding env) et `inherited` (risk_id présent dans
`parent.accepted_risks`). Une row est mintable iff les deux sont true ;
sinon la UI désactive la checkbox avec un tooltip explicatif.

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

`tokens/new/mint-form.tsx` est le composer post drop-confirm :

- Pour chaque provider × binding, le serveur passe le catalog inline
  (la page `tokens/new/page.tsx` projette les `RiskEntry` du catalog
  loader vers un shape client-side).
- Render en **checklist plat** (pas de buckets). Chaque row porte
  deux flags dérivés de la preview serveur : `acceptable` (catalog
  `acceptable_in_envs` OK pour le binding env) et `inherited`
  (`risk_id ∈ parent.accepted_risks`). Une row est disabled iff
  `!acceptable || !inherited`, avec un tooltip qui dit quel côté
  bloque.
- Soumet `accepted_risks: RiskId[]` + `denied_risks?: RiskId[]` à
  `POST /api/v1/tokens/mint`. Le serveur répond 201 (apparition du
  modal api_key) ou 4xx (erreur inline avec
  `{ not_acceptable, not_inherited, risks }`).

`lib/mint/risk-preview.ts` est la **single source of truth** pour la
résolution (pure compute). `lib/mint/preview.ts` la wrappe avec le
catalog load (pas de DB read post drop-confirm). Les routes
`tokens/mint` et `tokens/preview` consomment le wrap.

`lib/mint/token-name.ts` exporte `TOKEN_NAME_REGEX` — la single source
of truth pour la règle kebab-case des noms de token (`^[a-z0-9](-?[a-z0-9])*$`).
Consommé par le mint endpoint, le PATCH `/api/v1/tokens/:id`, la UI mint
(`mint-form.tsx`) et la UI rename (`token-row-controls.tsx`) : rule-of-three
honoré, pas de drift possible entre validation client et serveur.

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

`apps/gateway/src/app/mcp/route.ts` is a thin HTTP→McpGateway adapter :

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
upsert, audit_log insert, bash_bindings) use the service_role client
(`getSupabaseServiceClient()`).

Le service_role client est server-only et n'atteint jamais le bundle
browser.
