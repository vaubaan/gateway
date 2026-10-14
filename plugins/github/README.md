# `@vaubaan/plugin-github`

GitHub provider plugin for Vaubaan Gateway, written against
[`@vaubaan/plugin-sdk`](../../packages/plugin-sdk). One connection is one
**GitHub App installation** on the company's organisation; one resource is
one repository (`owner/repo`); a mission picks repositories, a preset and
the risks it accepts.

Handbook: [`docs/handbook/providers/github.md`](../../docs/handbook/providers/github.md).
Contract: [`docs/handbook/plugin-sdk.md`](../../docs/handbook/plugin-sdk.md),
ADRs [`plugin-contract-and-credential-spec`](../../docs/decisions/plugin-contract-and-credential-spec.md),
[`plugin-identifiers-one-grammar-for-classify-and-execute`](../../docs/decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md),
[`plugin-arguments-closed-surface-and-typed-refusals`](../../docs/decisions/plugin-arguments-closed-surface-and-typed-refusals.md).
Plugin version 3.0.0, catalog version 4.

## Layout

| File                      | Role                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/index.ts`            | `definePlugin({...})` → `githubPlugin` (default export).                                                                                   |
| `src/risk-catalog.yaml`   | 14 risks + fallback, 3 presets. Loaded by the SDK at boot; the only catalog artefact.                                                      |
| `src/data-model.ts`       | Plane `repo`: repo → branch → file / commit; tag, release (→ `delete`, a verb leaf), pull_request, issue → comment, workflow → run, rules. |
| `src/tools.ts`            | 26 MCP tools `github__<verb>_<noun>`; every repo-scoped tool takes `owner` + `repo`.                                                       |
| `src/call.ts`             | The grammar of every identifier and `readGithubCall`, the one reader `classify` and `execute` share.                                       |
| `src/classify.ts`         | Pure `(tool, args, resources) → slices \| denied`. The security-critical file.                                                             |
| `src/credential.ts`       | `app-install` `CredentialSpec`, app-config keys, `installationTokenFor(ctx, scope)`.                                                       |
| `src/app-install.ts`      | RS256 App JWT → `POST /app/installations/{id}/access_tokens` (scoped to repositories and permissions).                                     |
| `src/execute.ts`          | `execute` (per-call token + Octokit over `ctx.fetch`), `mint_install_token`, `discoverResources` (paged).                                  |
| `src/octokit-dispatch.ts` | Checked call → Octokit call; a merge first checks the pull request's real base against the declared one and declines a mismatch.           |

The plugin imports the SDK only (plus `@octokit/rest` and `jose`); nothing
from `apps/` or `@vaubaan/gateway-core`.

## Data model

Single plane `repo`. The repository is the resource; the **branch is the
environment of files and commits** (`branch[main]` ≠ `branch[feature/x]`),
which is why the catalog distinguishes protected branches by name rather
than by the owner's environment label. Virtual leaves carry intentions that
are not entities: `branch[X].merge-into`, `branch[X].propose-to[Y]`,
`branch[X].workflow-via-file`, `branch[X].files-bulk`,
`release[id].delete`.

## Catalog

| Risk                              | Covers                                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| `github.read-code`                | branches, files, commits, tags (reads)                                                        |
| `github.read-meta`                | PRs, issues, comments, releases, workflows and runs, branch protection (reads)                |
| `github.search-global`            | `search_code`, `search_issues` — account-shaped, not bounded to mission resources             |
| `github.feature-branch-write`     | branch, file and bulk writes on `feature/*, fix/*, chore/*, bug/*, docs/*, refactor/*`        |
| `github.merge-protected`          | any write or PR merge into `main, master, prod, production, release-*`                        |
| `github.workflow-write-via-file`  | a file write under `.github/workflows/*.yml` (privilege-escalation vector)                    |
| `github.bulk-file-write`          | `push_files` with 2+ files                                                                    |
| `github.create-pr`                | `create_pull_request`                                                                         |
| `github.comment-write`            | `add_issue_comment`                                                                           |
| `github.create-release`           | `create_release` (release record + tag): `release.W`, `tag[**].W`                             |
| `github.delete-release`           | `delete_release`: `release[**].delete.W`, its own verb leaf — not covered by `create-release` |
| `github.branch-protection-write`  | `update_branch_protection` (posture shift)                                                    |
| `github.mint-install-token-clone` | `mint_install_token` with `purpose=clone`                                                     |
| `github.mint-install-token-push`  | `mint_install_token` with `purpose=push`                                                      |
| `github.uncategorized-write`      | fallback `github.**.W` — counts only when no specific entry matched the write                 |

A write on `main` touches `merge-protected`; a write on `feature/x`
touches `feature-branch-write`; a write on `wip-x` matches no specific
entry and falls to `uncategorized-write`. No preset offers the fallback:
a mission that needs unconventional branch names accepts it explicitly.

The classifier refuses what it cannot place exactly: a file path that is
not canonical (leading `/`, empty, `.` or `..` segment, backslash), a ref
where a branch name is expected (`refs/heads/main`), a malformed `files`
list. `merge_pull_request` is classified on the declared `base` (`main`
when absent) and the merge is declined when the pull request targets
another branch.

What is classified is what is sent. `readGithubCall` (`src/call.ts`) reads
the arguments once, against the mission's repositories, and both
`classify` and `execute` start from the call it returns; `execute` declines
— an `isError` result, before the token mint — whatever `classify` refuses.
Each kind of identifier has one grammar, and a value outside it is refused,
never escaped or repaired. Requests are built field by field from declared
arguments, so an argument no tool declares is never read.

`execute` has two ways out besides its result. What it declines itself —
the reader's refusal, a merge whose pull request targets another base — is
thrown inside as the SDK's `ExecutorRefusal` and turned into an `isError`
result by `declining` at the entry point. What GitHub fails is thrown out:
`UpstreamAuthError` on 401/403, `UpstreamHttpError` (with the status) for
any other failed status of the token mint or of the repository listing.

| Identifier                                  | Grammar                                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `owner`, `repo`, `repoFullName`             | A login (`[A-Za-z0-9_-]`, ≤ 39) and a repository name (`[A-Za-z0-9._-]`, ≤ 100, not `.` or `..`), together one of the mission's repositories.          |
| file `path`                                 | Relative, `/`-separated, no empty, `.` or `..` segment, no backslash, no control character, ≤ 4096 characters.                                         |
| `branch`, `from_branch`, `base`, `head`     | A git branch name (`git check-ref-format`): no `..`, no component starting with `.`, no blank, none of `~ ^ : ? * [ \`; not a ref; `owner:` on a head. |
| `tag_name`                                  | The same, as a tag name.                                                                                                                               |
| `ref`, `sha`, `target_commitish`            | A revision: a branch, a tag, a full ref or a SHA, optionally with `~N` / `^N`.                                                                         |
| `pull_number`, `issue_number`, `release_id` | A positive integer.                                                                                                                                    |
| `workflow_id`                               | A positive integer, or one file name (no `/`, not `.` or `..`).                                                                                        |

Octokit percent-encodes a path parameter with `encodeURIComponent`, which
leaves `.` and `..` untouched, and a URL parser then removes those
segments: without the grammars, `path: '..'` on `delete_file` would be
sent as `DELETE /repos/{owner}/{repo}/`. The installation id of the
connection (digits only) and the repository names discovery returns go
through the same kind of check.

## Presets

| Preset            | Grants                                                                                                                                 | Approval gates                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `read-only`       | `read-code`, `read-meta`                                                                                                               | —                                                     |
| `developer`       | reads, `search-global`, `feature-branch-write`, `bulk-file-write`, `create-pr`, `comment-write`, `workflow-write-via-file`, both mints | `workflow-write-via-file`, `mint-install-token-push`  |
| `release-manager` | reads, `feature-branch-write`, `create-pr`, `comment-write`, `merge-protected`, `create-release`, `delete-release`                     | `merge-protected`, `create-release`, `delete-release` |

`developer` is the "one mission per code repository" preset: it never merges
into a protected branch and never touches branch protection. No preset
grants `branch-protection-write`; the creator adds it explicitly.
Presets are UI sugar — the persisted policy is always the explicit list.

## Credential: the company's GitHub App

1. **Register the App** (once, by an administrator): GitHub → Settings →
   Developer settings → GitHub Apps → New GitHub App. Permissions the
   tools need: Contents (read & write), Pull requests (read & write),
   Issues (read & write), Metadata (read), Actions (read), Administration
   (read & write, for branch protection), Workflows (read & write, for
   pushes touching `.github/workflows/`). Generate a **private key** and
   a **client secret**. Under "Identifying and authorizing users", tick
   **Request user authorization (OAuth) during installation** and set the
   **Callback URL** to the gateway's connection callback
   (`<public_url>/connections/callback/github`, shown in Settings → Administration → Company apps). With that box ticked GitHub offers no setup URL: the
   callback URL receives both `code` and `installation_id`. Keep "Expire
   user authorization tokens" on.
2. **Configure the instance** with the five app-config keys the spec
   declares: `app_id`, `private_key` (PEM, PKCS#1 or PKCS#8; a one-line
   PEM with literal `\n` is accepted), `app_slug`, `client_id` (the
   App's client ID, not its App ID) and `client_secret`. Missing keys leave the
   service unavailable in "Connect an account", which says why.
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
  `assertNoWildcard`, `assertCatalogCoverage` with samples per tool: the 14
  named risks touched, `fallbackHits` empty), preset invariants, credential spec.
- `risk-catalog.test.ts` — the table `[tool, arguments, risks touched]`: add a
  row whenever a tool, a classifier branch or a catalog pattern changes.
- `classify.test.ts` — the classifier's security suite: `(tool, args, resources)` → exact slices or denial.
- `execute.test.ts` — JWT claims, mint request shape, per-call scoping,
  Octokit over `mockFetch`, `UpstreamAuthError`, declined calls as `isError`
  results, mint tool, paged discovery.
- `injection.test.ts` — every identifier position fed `..`, `.`, `a/../b`,
  encoded forms, an empty, an overlong and a multi-line value, to `classify`
  and to `execute`: refused by both with nothing sent, or sent as the exact
  path that was classified.
- `data-model.test.ts` — data-model integrity.
- `token-cache.test.ts` — connection-scoped reuse of installation tokens.

587 tests; none reaches GitHub.
