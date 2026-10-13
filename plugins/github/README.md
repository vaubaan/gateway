# `@vaubaan/plugin-github`

GitHub provider plugin for Vaubaan Gateway, written against
[`@vaubaan/plugin-sdk`](../../packages/plugin-sdk). One connection is one
**GitHub App installation** on the company's organisation; one resource is
one repository (`owner/repo`); a mission picks repositories, a preset and
the risks it accepts.

Handbook: [`docs/handbook/providers/github.md`](../../docs/handbook/providers/github.md).
Contract: [`docs/handbook/plugin-sdk.md`](../../docs/handbook/plugin-sdk.md),
ADR [`plugin-contract-and-credential-spec`](../../docs/decisions/plugin-contract-and-credential-spec.md).

## Layout

| File                      | Role                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`            | `definePlugin({...})` → `githubPlugin` (default export).                                                         |
| `src/risk-catalog.yaml`   | 14 risks + fallback, 3 presets. Loaded by the SDK at boot; the only catalog artefact.                            |
| `src/data-model.ts`       | Plane `repo`: repo → branch → file / commit; tag, release, pull_request, issue → comment, workflow → run, rules. |
| `src/tools.ts`            | 26 MCP tools `github__<verb>_<noun>`; every repo-scoped tool takes `owner` + `repo`.                             |
| `src/classify.ts`         | Pure `(tool, args, resources) → slices \| denied`. The security-critical file.                                   |
| `src/credential.ts`       | `app-install` `CredentialSpec`, app-config keys, `installationTokenFor(ctx, scope)`.                             |
| `src/app-install.ts`      | RS256 App JWT → `POST /app/installations/{id}/access_tokens` (scoped to repositories and permissions).           |
| `src/execute.ts`          | `execute` (per-call token + Octokit over `ctx.fetch`), `mint_install_token`, `discoverResources` (paged).        |
| `src/octokit-dispatch.ts` | Tool name → Octokit call.                                                                                        |

The plugin imports the SDK only (plus `@octokit/rest` and `jose`); nothing
from `apps/` or `@vaubaan/gateway-core`.

## Data model

Single plane `repo`. The repository is the resource; the **branch is the
environment of files and commits** (`branch[main]` ≠ `branch[feature/x]`),
which is why the catalog distinguishes protected branches by name rather
than by the owner's environment label. Virtual leaves carry intentions that
are not entities: `branch[X].merge-into`, `branch[X].propose-to[Y]`,
`branch[X].workflow-via-file`, `branch[X].files-bulk`.

## Catalog

| Risk                              | Covers                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| `github.read-code`                | branches, files, commits, tags (reads)                                                 |
| `github.read-meta`                | PRs, issues, comments, releases, workflows and runs, branch protection (reads)         |
| `github.search-global`            | `search_code`, `search_issues` — account-shaped, not bounded to mission resources      |
| `github.feature-branch-write`     | branch, file and bulk writes on `feature/*, fix/*, chore/*, bug/*, docs/*, refactor/*` |
| `github.merge-protected`          | any write or PR merge into `main, master, prod, production, release-*`                 |
| `github.workflow-write-via-file`  | a file write under `.github/workflows/*.yml` (privilege-escalation vector)             |
| `github.bulk-file-write`          | `push_files` with 2+ files                                                             |
| `github.create-pr`                | `create_pull_request`                                                                  |
| `github.comment-write`            | `add_issue_comment`                                                                    |
| `github.create-release`           | `create_release` (release record + tag)                                                |
| `github.delete-release`           | `delete_release`                                                                       |
| `github.branch-protection-write`  | `update_branch_protection` (posture shift)                                             |
| `github.mint-install-token-clone` | `mint_install_token` with `purpose=clone`                                              |
| `github.mint-install-token-push`  | `mint_install_token` with `purpose=push`                                               |
| `github.uncategorized-write`      | fallback `github.**.W` — counts only when no specific entry matched the write          |

A write on `main` touches `merge-protected`; a write on `feature/x`
touches `feature-branch-write`; a write on `wip-x` matches no specific
entry and falls to `uncategorized-write`. No preset offers the fallback:
a mission that needs unconventional branch names accepts it explicitly.

## Presets

| Preset            | Grants                                                                                                                                 | Approval gates                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `read-only`       | `read-code`, `read-meta`                                                                                                               | —                                                     |
| `developer`       | reads, `search-global`, `feature-branch-write`, `bulk-file-write`, `create-pr`, `comment-write`, `workflow-write-via-file`, both mints | `workflow-write-via-file`, `mint-install-token-push`  |
| `release-manager` | reads, `feature-branch-write`, `create-pr`, `comment-write`, `merge-protected`, `create-release`, `delete-release`                     | `merge-protected`, `create-release`, `delete-release` |

`developer` is the "one token per code project" preset: it never merges
into a protected branch and never touches branch protection. No preset
grants `branch-protection-write`; the creator adds it explicitly.
Presets are UI sugar — the persisted policy is always the explicit list.

## Credential: the company's GitHub App

1. **Register the App** (once, by the operator): GitHub → Settings →
   Developer settings → GitHub Apps → New GitHub App. Permissions the
   tools need: Contents (read & write), Pull requests (read & write),
   Issues (read & write), Metadata (read), Actions (read), Administration
   (read & write, for branch protection), Workflows (read & write, for
   pushes touching `.github/workflows/`). Generate a **private key** and
   a **client secret**. Under "Identifying and authorizing users", tick
   **Request user authorization (OAuth) during installation** and set the
   **Callback URL** to the gateway's connection callback
   (`<public_url>/connections/callback/github`, shown in Administration →
   Provider apps). With that box ticked GitHub offers no setup URL: the
   callback URL receives both `code` and `installation_id`. Keep "Expire
   user authorization tokens" on.
2. **Configure the instance** with the five app-config keys the spec
   declares: `app_id`, `private_key` (PEM, PKCS#1 or PKCS#8; a one-line
   PEM with literal `\n` is accepted), `app_slug`, `client_id` (the
   App's client ID, not its App ID) and `client_secret`. Missing keys keep
   the provider out of "Connect a provider".
3. **Connect**: the host redirects the user to
   `https://github.com/apps/<app_slug>/installations/new`. On the callback
   it exchanges `code` for a user access token
   (`POST https://github.com/login/oauth/access_token`), checks that
   `installation_id` is among `GET /user/installations` for that token,
   drops the token, and only then stores the installation id encrypted as
   the connection's secret. An installation the installing GitHub account
   cannot reach is refused and audited. All of this is declared in
   `githubCredential.userVerification` and run by the host: the plugin
   never sees the client secret or the user token, sees the private key
   only in `ctx.appConfig`, and never reads `process.env`.
4. **Resources**: `discoverResources` lists the installation's
   repositories (`GET /installation/repositories`, 100 per page, up to 10
   pages) as `owner/repo` resources with `default_branch`, `private`,
   `archived` in `metadata`. The owner labels environments later.

At call time the plugin mints a fresh installation token (JWT RS256, 9 min
→ token, 1 h) scoped to the repository the call names; search tools get an
installation-wide token. `github__mint_install_token` returns a token scoped
to the mission's repositories with the `clone` (`contents:read`) or `push`
(`contents, pull_requests, workflows: write; metadata: read`) permission
set — that token leaves the gateway's perimeter.

No personal-access-token path: the plugin contract carries one
`CredentialSpec` per plugin and an on-prem instance always registers its own
App.

## Tests

```bash
npx vitest run plugins/github
```

- `plugin.test.ts` — SDK kit (`assertPluginWellFormed`, `assertPresetsValid`,
  `assertNoWildcard`, `assertCatalogCoverage` with a sample per tool, every
  risk reachable), fallback lint, preset invariants, credential spec.
- `classify.test.ts` — the classifier's security suite: `(tool, args, resources)` → exact slices or denial.
- `execute.test.ts` — JWT claims, mint request shape, per-call scoping,
  Octokit over `mockFetch`, `UpstreamAuthError`, mint tool, paged discovery.
- `data-model.test.ts` — data-model integrity.
- `token-cache.test.ts` — connection-scoped reuse of installation tokens.

No test reaches GitHub.
