---
title: GitHub provider adapter
status: current
date: 2026-05-22
tracks:
  - packages/providers/github/src/
  - supabase/migrations/0001_init.sql
---

# GitHub provider — `@vaubaan/providers-github`

L'unique provider intégré au MVP. OAuth/App install, JIT installation token,
17 MCP tools synthétisés via Octokit.

## Layout

```
packages/providers/github/
  src/
    adapter.ts          # ProviderAdapter contract (générique, ré-exporté)
    app-install.ts      # buildAppJwt + mintInstallationToken (RS256 JWT + POST /access_tokens)
    tools.ts            # availableTools[] — 17 MCP tool declarations
    execute.ts          # executeCall(factory, token, tool, args) — switch sur tool_name
    github-adapter.ts   # GitHubAdapter class — assemble app-install + execute + tools
    index.ts            # barrel
  tests/unit/adapter.test.ts (9 tests)
```

## Le contrat `ProviderAdapter`

Toute intégration provider implémente :

```ts
interface ProviderAdapter {
  readonly provider: Provider;
  readonly availableTools: ReadonlyArray<McpToolDeclaration>;
  authorizationUrl(orgId, returnUrl, state): string;
  handleCallback(orgId, params): Promise<{installation_id?, team_id?, access_token_encrypted?, ...}>;
  mintUpstreamToken(admin): Promise<{token, expiresAt}>;
  validateBinding(admin, resourceRef): Promise<{ok, displayName?, error?}>;
  executeCall(admin, binding, tool, args): Promise<unknown>;
  resolveTarget(target, bindings): string[];
}
```

Vercel et Supabase suivront le même contrat en Phase 5.

## GitHub App install flow

1. Org admin → `Connect GitHub` button.
2. UI redirige vers `https://github.com/apps/vaubaan-gateway/installations/new?state=<nonce>`.
3. GitHub écran consent. Admin choisit org + repos. Click Authorize.
4. GitHub redirige vers `/orgs/<slug>/providers/github/callback?installation_id=<id>&state=<nonce>`.
5. Callback handler :
   - vérifie le `state` cookie (`vbn_oauth_state`, single-use, 5min TTL).
   - upserts `provider_admins` row avec `installation_id` (status='connected').
6. UI : page `/orgs/<slug>` montre GitHub connected ✓.

## JIT installation token

À chaque MCP call autorisé qui vise GitHub :

```ts
// 1. Build JWT (RS256, 9min iat→exp, iss=appId)
const jwt = await buildAppJwt({appId, privateKeyPem});

// 2. Exchange for installation token (1h lifetime)
POST https://api.github.com/app/installations/<installation_id>/access_tokens
Authorization: Bearer <jwt>
→ { token: 'ghs_...', expires_at: '...' }

// 3. Use for the upstream call, then release from memory.
```

La privkey de l'App vit dans `GITHUB_APP_PRIVATE_KEY` (env var Vercel — multiline
PEM avec `\n` escaped). Jamais en DB.

## Tools exposés (18)

- **Read list** : `github__list_branches`, `github__list_commits`,
  `github__list_pull_requests`, `github__list_issues`.
- **Read get** : `github__get_file_contents`, `github__get_pull_request`,
  `github__get_issue`, `github__get_commit`.
- **Search** : `github__search_code`, `github__search_issues`.
- **Write branches** : `github__create_branch`.
- **Write files** : `github__create_or_update_file`, `github__push_files`.
- **Write PR / comments** : `github__create_pull_request`, `github__add_issue_comment`.
- **Ephemeral credential** : `github__mint_install_token` (cf. ADR
  `mint-install-token-credential`) — mint un token ghs\_\* court-vivant
  scopé aux repos du Project. Les flows clone et push appellent ce tool au
  lieu de stocker un PAT sur le host d'exécution.
- **Dangerous (aucun builtin role ne les autorise — default-deny)** :
  `github__merge_pull_request`, `github__delete_file`. Pour les autoriser,
  créer un role custom org-scopé.

Le mapping `tool_name → Octokit call` vit dans `src/execute.ts`. Le mint
vit dans `src/github-adapter.ts` (a accès à `admin.installation_id` + l'App
creds + le callback `loadGithubBindings` injecté par la couche web).

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

## Roles builtin

Seedés en migration `0001_init.sql` :

- `github:reader` — read-only sur les repos bindés.
- `github:developer` — read + writes sur `feature/*`, `fix/*`, `claude/*`,
  PRs vers `main`, pas de merge, pas de delete. **Inclut** `mint_install_token`
  avec `purpose IN ('clone','push')`.
- `github:provisioner` (migration `0005`, **internal**) — mint
  `github__mint_install_token` avec `purpose='clone'` uniquement. Utilisé
  au bootstrap d'une session, **ne pas assigner à des humains**.

## Tests

`npx vitest run packages/providers/github` — 18 tests (~50ms), dont 6 pour
`mint_install_token` (purpose mapping, repoFullName validation, scope par
défaut = tous les bindings).
