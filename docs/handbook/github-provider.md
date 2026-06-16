---
title: GitHub provider adapter
status: current
date: 2026-06-15
tracks:
  - packages/providers/github/src/
  - packages/web/src/app/api/integrations/github/
  - supabase/migrations/0001_init.sql
---

# GitHub provider — `@vaubaan/providers-github`

> **v4 risk-based catalog added — 2026-06-15.** Le pivot
> `chore(v1-drop)` a supprimé le classifier capability-based et le
> ladder `code/ci/rules/access`. Le code expose désormais
> `data-model.ts` (17 entités du plane `repo`), `risk-catalog.{yaml,ts}`
> (14 risks + fallback) et `risk-classifier.ts` (classifyV4 → slices).
> Le présent handbook ne couvre QUE la couche **adapter & integration
> setup** (auth flow, mint upstream, executeCall). Pour le data-model,
> le risk catalog et le mapping tool → slice, lire le handbook v4
> dédié : [`docs/handbook/providers/github.md`](./providers/github.md).

App install + JIT installation token + tools MCP synthétisés via Octokit

- tool éphémère `github__mint_install_token`. Pattern adapter
  (`ProviderAdapter` interface) répliqué par les 4 autres providers
  (vercel, supabase, railway, bash).

## Layout

```
packages/providers/github/
  src/
    adapter.ts          # ProviderAdapter contract (générique, ré-exporté)
    app-install.ts      # buildAppJwt + mintInstallationToken (RS256 JWT + POST /access_tokens)
    risk-classifier.ts  # classifyV4 → Slice[] (cf. providers/github.md)
    risk-catalog.{yaml,ts}  # 14 risks + fallback (cf. providers/github.md)
    data-model.ts       # 17 entités du plane `repo` (cf. providers/github.md)
    tools.ts            # availableTools[] — déclarations MCP
    execute.ts          # executeCall(factory, token, tool, args) — switch par tool_name
    github-adapter.ts   # GitHubAdapter class — assemble app-install + execute + classifyV4 + tools
    index.ts            # barrel
  tests/unit/
    adapter.test.ts          (18 tests — auth + mint + executeCall + mint_install_token)
    risk-catalog.test.ts     (35 tests — catalog shape + vector lint)
    risk-classifier.test.ts  (31 tests — classifyV4 per tool kind)
    risk-catalog-sync.test.ts (18 tests — YAML ↔ TS sync + coverage)
```

## GitHub App install flow

Path **slug-agnostique** côté GitHub App ("Setup URL" stable). Le slug
de l'org est encodé dans le `state` nonce, pas dans l'URL.

1. Org admin → `Connect GitHub` button → `GET /api/integrations/github/connect?org=<slug>`.
2. Handler vérifie `requireOrgMember(slug)`, génère un `state` qui
   encode `orgId` (`lib/oauth/state.ts:generateState`), stocke ce state
   en cookie `vbn_oauth_state` (5min, single-use), et redirige vers
   `https://github.com/apps/<GITHUB_APP_SLUG>/installations/new?state=<state>`.
3. GitHub écran consent. Admin choisit org + repos. Click Authorize.
4. GitHub redirige vers
   `GET /api/integrations/github/callback?installation_id=<id>&state=<state>&setup_action=install`.
5. Callback handler (`callback/route.ts`) :
   - vérifie le `state` cookie + décode `orgId` via `decodeStateOrgId`.
   - upsert `provider_admins` row (service_role) avec `installation_id`
     et `status='connected'`.
6. UI : page `/orgs/<slug>/providers` montre GitHub connected ✓.

## JIT installation token

À chaque MCP call autorisé qui vise GitHub :

```ts
// 1. Build JWT (RS256, 9min iat→exp, iss=appId)
const jwt = await buildAppJwt({ appId, privateKeyPem });

// 2. Exchange for installation token (1h lifetime)
POST https://api.github.com/app/installations/<installation_id>/access_tokens
Authorization: Bearer <jwt>
→ { token: 'ghs_...', expires_at: '...' }

// 3. Use for the upstream call, then release from memory.
```

La privkey de l'App vit dans `GITHUB_APP_PRIVATE_KEY` (env var Vercel — multiline
PEM avec `\n` escaped). Jamais en DB.

## `github__mint_install_token`

Input : `{ repoFullName?: string, purpose: 'clone' | 'push' }`.

L'adapter :

1. Récupère tous les bindings github du Project via `loadGithubBindings`.
2. Si `repoFullName` est fourni, valide qu'il est dans les bindings ; sinon
   utilise tous les bindings.
3. Mappe `purpose` → permissions GitHub (`clone` = `contents:read` ; `push` =
   `contents:write + pull_requests:write + metadata:read + workflows:write`).
   La permission `workflows:write` est requise dès qu'un push touche
   `.github/workflows/*.yml` ; elle doit aussi être grantée au niveau App.
4. Appelle `POST /app/installations/{id}/access_tokens` avec body
   `{ repositories, permissions }` → token `ghs_*` scopé per-call.

Output (passé au caller via le wrap MCP) :

```json
{
  "token": "ghs_...",
  "expires_at": "2026-05-30T16:00:00Z",
  "repositories": [{ "id": 1, "name": "app", "full_name": "acme/app" }],
  "permissions": { "contents": "read" }
}
```

Le caller fait ensuite `git clone https://x-access-token:$TOKEN@github.com/<repo>.git`.

## executeCall — dispatch côté provider

Le mapping `tool_name → Octokit call` vit dans `src/execute.ts`. Le
gateway appelle `adapter.executeCall(admin, binding, tool, args)` après
que la pipeline v4 a validé la slice. L'adapter ne connaît ni le risk
catalog, ni les `accepted_risks` — il classifie (`classifyV4`) et
exécute, mais la décision pure vit côté `@vaubaan/policy-engine`.

Le mint Bearer (`admin.installation_id` → JIT 1h via JWT) vit dans
`src/github-adapter.ts:mintUpstreamToken`. Il reçoit le callback
`loadGithubBindings` (injecté par la couche web) pour résoudre les repos
visibles depuis le project.

## Tests

`npx vitest run packages/providers/github` — 102 tests (~150ms) répartis
sur les 4 suites listées en §Layout. Voir
[`providers/github.md`](./providers/github.md) §Tests pour le détail des
scénarios catalog/classifier.

## Références

- Handbook v4 (data-model + risk catalog + tool → slice) :
  [`docs/handbook/providers/github.md`](./providers/github.md).
- Spec : [`docs/spec/gateway-risk-model.md`](../spec/gateway-risk-model.md)
  §3 (DSL), §4 (catalog).
- ADRs : [[mint-install-token-credential]], [[oauth-app-install-per-provider]].
- Handbooks voisins : [[web-app]] (OAuth flow côté Next.js),
  [[mcp-gateway]] (hot-path dispatch), [[escalation]] (runtime escalation_channel),
  [[policy-engine]] (`evaluateCall` + scope injection).
