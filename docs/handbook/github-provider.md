---
title: GitHub provider adapter
status: current
date: 2026-06-11
tracks:
  - packages/providers/github/src/
  - packages/web/src/app/api/integrations/github/
  - supabase/migrations/0001_init.sql
---

# GitHub provider — `@vaubaan/providers-github`

Le provider de référence : App install + JIT installation token + 18 MCP
tools synthétisés via Octokit, plus le tool éphémère `github__mint_install_token`.
Le pattern (contrat `ProviderAdapter` + classifier + executor) est répliqué
par les 4 autres providers (vercel, supabase, railway, bash).

## Layout

```
packages/providers/github/
  src/
    adapter.ts          # ProviderAdapter contract (générique, ré-exporté)
    app-install.ts      # buildAppJwt + mintInstallationToken (RS256 JWT + POST /access_tokens)
    classify.ts         # classifyGithub + githubToolCapabilities (capability model)
    tools.ts            # availableTools[] — 18 MCP tool declarations
    execute.ts          # executeCall(factory, token, tool, args) — switch sur tool_name
    github-adapter.ts   # GitHubAdapter class — assemble app-install + execute + classify + tools
    index.ts            # barrel
  tests/unit/adapter.test.ts (25 tests)
```

## Le contrat `ProviderAdapter`

Défini dans [`adapter.ts:36`](../../packages/providers/github/src/adapter.ts).
Implémenté par les 5 providers ; le gateway dispatche dessus sans
spécificité (cf. [[mcp-gateway]]).

```ts
interface ProviderAdapter {
  readonly provider: Provider;
  readonly availableTools: ReadonlyArray<McpToolDeclaration>;
  authorizationUrl(orgId, returnUrl, state): string;
  handleCallback(
    orgId,
    params,
  ): Promise<{
    installation_id;
    team_id;
    access_token_encrypted;
    refresh_token_encrypted;
    expires_at;
  }>;
  mintUpstreamToken(admin): Promise<{ token; expiresAt }>;
  validateBinding(admin, resourceRef): Promise<{ ok; displayName?; error? }>;
  executeCall(admin, binding, tool, args): Promise<unknown>;
  // Capability model (spec §3, §6) :
  toolCapabilities(tool): readonly Capability[]; // env-less surface — for tools/list filter
  classify(tool, args, bindings): ClassifyResult; // → { capability } | { denied }
}
```

`resolveTarget(target, bindings)` n'existe plus — l'autorisation se fait
maintenant par classification capability + exact-tuple match côté
[[policy-engine]] / `evaluateCapability`, pas par résolution de cible.

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
const jwt = await buildAppJwt({appId, privateKeyPem});

// 2. Exchange for installation token (1h lifetime)
POST https://api.github.com/app/installations/<installation_id>/access_tokens
Authorization: Bearer <jwt>
→ { token: 'ghs_...', expires_at: '...' }

// 3. Use for the upstream call, then release from memory.
```

La privkey de l'App vit dans `GITHUB_APP_PRIVATE_KEY` (env var Vercel — multiline
PEM avec `\n` escaped). Jamais en DB.

## Tools exposés (21)

- **Read list** : `github__list_branches`, `github__list_commits`,
  `github__list_pull_requests`, `github__list_issues`.
- **Read get** : `github__get_file_contents`, `github__get_pull_request`,
  `github__get_issue`, `github__get_commit`.
- **Search** : `github__search_code`, `github__search_issues`.
- **Read ci** : `github__list_workflows`, `github__list_workflow_runs`
  (Octokit `actions.listRepoWorkflows` / `listWorkflowRuns(ForRepo)`).
  Classifiés sur `repo/ci:read`.
- **Read rules** : `github__get_branch_protection` (Octokit
  `repos.getBranchProtection`). Classifié sur `repo/rules:read`.
- **Write branches** : `github__create_branch`.
- **Write files** : `github__create_or_update_file`, `github__push_files`.
- **Write PR / comments** : `github__create_pull_request`, `github__add_issue_comment`.
- **Ephemeral credential** : `github__mint_install_token` (cf. ADR
  [[mint-install-token-credential]]) — mint un token `ghs_*` court-vivant
  scopé aux repos du Project. Les flows clone et push appellent ce tool au
  lieu de stocker un PAT sur le host d'exécution.
- **Sensitive (gated par policy)** : `github__merge_pull_request`,
  `github__delete_file`. Classifiés sur `repo/code:write@main` (resp.
  `code:write` sur la branche cible) ; la policy par défaut force
  `confirm` (human-gate) sur tout write env-less ou `@main` cf.
  [[capability-policy-and-approvals]].

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

## Capability surface

Le classifier `classifyGithub` (`classify.ts:91`) mappe chaque
`(tool, args)` en capability `github:repo/<level>:<action>[@<env>]` (cf.
spec `gateway-capability-model.md` §3, §6).

Ladder du plane `repo` (interne → externe) :

| Niveau | Slug     | Concerne                                         |
| ------ | -------- | ------------------------------------------------ |
| niv1   | `code`   | Files, commits, branches, PRs, issues            |
| niv2   | `ci`     | Workflows (`.github/workflows/*.yml`), Actions   |
| niv3   | `rules`  | Branch protection, required reviews, merge rules |
| niv4   | `access` | Repo, collaborators, install tokens, secrets     |

**Env sur `code`** = la branche cible (décision spec §4 #5 : la branche
EST l'env). `code:write@main` ≡ merge / canonical write ;
`code:write@<feature>` ≡ propose. Reads sont env-less.

Exemples de classification (`classify.ts:31-50`) :

| Tool                          | Capability classifiée                                           |
| ----------------------------- | --------------------------------------------------------------- |
| `github__list_branches`       | `code:read` (env-less)                                          |
| `github__push_files`          | `code:write@<args.branch>`                                      |
| `github__create_pull_request` | `code:write@<args.head>`                                        |
| `github__merge_pull_request`  | `code:write@<args.base ?? 'main'>`                              |
| `github__search_code`         | `code:read` (global, env-less)                                  |
| `github__mint_install_token`  | clone → `access:read` ; push → `code:write` (env-less, fan-out) |

La protection des writes sensibles (merge sur `main`, delete sur prod)
est portée par les `policy_rules` du projet ([[capability-policy-and-approvals]]),
pas par des rôles builtin. Le modèle Roles seedé en `0001_init.sql` a été
remplacé par les capabilities en migration `0015_capabilities_replace_roles.sql`
— les tables `roles` et `access_token_roles` ont été droppées
(`0015:27-28`).

## Tests

`npx vitest run packages/providers/github` — 25 tests (~50ms), dont :

- 6 pour `mint_install_token` (purpose mapping, repoFullName validation,
  scope par défaut = tous les bindings).
- Tests `classifyGithub` couvrant chaque kind du `TOOL_KIND` (`classify.ts:31`)
  - branches d'erreur (unknown tool, missing owner/repo, repo non-bindé).
- Tests `mintInstallationToken` (JWT signing avec `jose` réel, échange
  via fetch mocké, gestion des 4xx).

## Références

- Spec : [`docs/spec/gateway-capability-model.md`](../spec/gateway-capability-model.md) §3, §6 (capability model + classifier).
- ADRs : [[mint-install-token-credential]], [[oauth-app-install-per-provider]], [[dispatch-upstream-option-a-synthese]].
- Handbooks voisins : [[web-app]] (OAuth flow côté Next.js), [[mcp-gateway]] (hot-path dispatch), [[capability-policy-and-approvals]] (policy + approval flow), [[policy-engine]] (evaluateCapability).
