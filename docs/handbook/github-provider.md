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

## Tools exposés (17)

- **Read list** : `github__list_branches`, `github__list_commits`,
  `github__list_pull_requests`, `github__list_issues`.
- **Read get** : `github__get_file_contents`, `github__get_pull_request`,
  `github__get_issue`, `github__get_commit`.
- **Search** : `github__search_code`, `github__search_issues`.
- **Write branches** : `github__create_branch`.
- **Write files** : `github__create_or_update_file`, `github__push_files`.
- **Write PR / comments** : `github__create_pull_request`, `github__add_issue_comment`.
- **Dangerous (deny-listed par github:developer)** : `github__merge_pull_request`,
  `github__delete_file`.

Le mapping `tool_name → Octokit call` vit dans `src/execute.ts`. Test
structural à ajouter en Phase 5 (cf. spec §14.4).

## Roles builtin

Seedés en migration `0001_init.sql` :

- `github:reader` — read-only sur les repos bindés.
- `github:developer` — read + writes sur `feature/*`, `fix/*`, `claude/*`,
  PRs vers `main`, pas de merge, pas de delete.

## Tests

`npx vitest run packages/providers/github` — 9 tests, ~50ms.
