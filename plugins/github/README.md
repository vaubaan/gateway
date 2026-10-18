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
Plugin version 3.3.0, catalog version 8.

## Layout

| File                      | Role                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/index.ts`            | `definePlugin({...})` → `githubPlugin` (default export).                                                                                               |
| `src/risk-catalog.yaml`   | 18 risks + fallback, 3 presets. Loaded by the SDK at boot; the only catalog artefact.                                                                  |
| `src/data-model.ts`       | Plane `repo`: repo → branch → file / commit; tag, release (→ `delete`, a verb leaf), pull_request, issue → comment, workflow → run → job → log, rules. |
| `src/tools.ts`            | 28 MCP tools `github__<verb>_<noun>`; every repo-scoped tool takes `owner` + `repo`.                                                                   |
| `src/call.ts`             | The grammar of every identifier and `readGithubCall`, the one reader `classify` and `execute` share.                                                   |
| `src/classify.ts`         | Pure `(tool, args, resources) → slices \| denied`. The security-critical file.                                                                         |
| `src/credential.ts`       | `app-install` `CredentialSpec`, app-config keys, `installationTokenFor(ctx, scope)`.                                                                   |
| `src/app-install.ts`      | RS256 App JWT → `POST /app/installations/{id}/access_tokens` (scoped to repositories and permissions).                                                 |
| `src/execute.ts`          | `execute` (per-call token + Octokit over `ctx.fetch`), `mint_install_token`, `discoverResources` (paged).                                              |
| `src/app-manifest.ts`     | `GITHUB_APP_PERMISSIONS` (the one list of the App's permissions and the tools each serves), the manifest flow.                                         |
| `src/permission-check.ts` | A call the installation has no permission for is declined by name, before anything is sent.                                                            |
| `src/octokit-dispatch.ts` | Checked call → Octokit call; a merge first checks the pull request's real base against the declared one and declines a mismatch.                       |
| `src/job-logs.ts`         | `get_job_logs`: the redirect to the log's download followed without the token, the log read bounded (`max_bytes`, `tail`).                             |

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

| Risk                              | Covers                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `github.read-code`                | branches, files, commits, tags (reads)                                                         |
| `github.read-meta`                | PRs, issues, comments, releases, workflows, runs, jobs and job logs, branch protection (reads) |
| `github.search-global`            | `search_code`, `search_issues` — account-shaped, not bounded to mission resources              |
| `github.feature-branch-write`     | branch, file and bulk writes on `feature/*, feat/*, fix/*, chore/*, bug/*, docs/*, refactor/*` |
| `github.merge-protected`          | any write or PR merge into `main, master, prod, production, release-*`                         |
| `github.workflow-write-via-file`  | a file write under `.github/workflows/*.yml` (privilege-escalation vector)                     |
| `github.bulk-file-write`          | `push_files` with 2+ files                                                                     |
| `github.create-pr`                | `create_pull_request`                                                                          |
| `github.comment-write`            | `add_issue_comment`                                                                            |
| `github.create-release`           | `create_release` (release record + tag): `release.W`, `tag[**].W`                              |
| `github.delete-release`           | `delete_release`: `release[**].delete.W`, its own verb leaf — not covered by `create-release`  |
| `github.branch-protection-write`  | `update_branch_protection` (posture shift)                                                     |
| `github.mint-install-token-clone` | `mint_install_token` with `purpose=clone`                                                      |
| `github.mint-install-token-push`  | `mint_install_token` with `purpose=push`                                                       |
| `github.git-push`                 | every ref a push through the git remote moves (leaf `push`), beside the branch's own risk      |
| `github.force-push`               | a non-fast-forward update of a branch through the git remote (leaf `force`)                    |
| `github.branch-delete`            | a branch deleted through the git remote (leaf `delete`); the branch's own risk counts too      |
| `github.tag-write`                | a tag pushed or deleted through the git remote; overlaps `create-release` on `tag[**].W`       |
| `github.uncategorized-write`      | fallback `github.**.W` — counts only when no specific entry matched the write                  |

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

| Identifier                                                      | Grammar                                                                                                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `owner`, `repo`, `repoFullName`                                 | A login (`[A-Za-z0-9_-]`, ≤ 39) and a repository name (`[A-Za-z0-9._-]`, ≤ 100, not `.` or `..`), together one of the mission's repositories.          |
| file `path`                                                     | Relative, `/`-separated, no empty, `.` or `..` segment, no backslash, no control character, ≤ 4096 characters.                                         |
| `branch`, `from_branch`, `base`, `head`                         | A git branch name (`git check-ref-format`): no `..`, no component starting with `.`, no blank, none of `~ ^ : ? * [ \`; not a ref; `owner:` on a head. |
| `tag_name`                                                      | The same, as a tag name.                                                                                                                               |
| `ref`, `sha`, `target_commitish`                                | A revision: a branch, a tag, a full ref or a SHA, optionally with `~N` / `^N`.                                                                         |
| `pull_number`, `issue_number`, `release_id`, `run_id`, `job_id` | A positive integer.                                                                                                                                    |
| `workflow_id`                                                   | A positive integer, or one file name (no `/`, not `.` or `..`).                                                                                        |

Octokit percent-encodes a path parameter with `encodeURIComponent`, which
leaves `.` and `..` untouched, and a URL parser then removes those
segments: without the grammars, `path: '..'` on `delete_file` would be
sent as `DELETE /repos/{owner}/{repo}/`. The installation id of the
connection (digits only) and the repository names discovery returns go
through the same kind of check.

## Presets

| Preset            | Grants                                                                                                                                               | Approval gates                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `read-only`       | `read-code`, `read-meta`                                                                                                                             | —                                                                  |
| `developer`       | reads, `search-global`, `feature-branch-write`, `bulk-file-write`, `create-pr`, `comment-write`, `workflow-write-via-file`, `git-push`, `force-push` | `workflow-write-via-file`, `force-push`                            |
| `release-manager` | reads, `feature-branch-write`, `create-pr`, `comment-write`, `merge-protected`, `create-release`, `delete-release`, `git-push`, `tag-write`          | `merge-protected`, `create-release`, `delete-release`, `tag-write` |

`developer` is the "one mission per code repository" preset: it never merges
into a protected branch and never touches branch protection. No preset
grants `branch-protection-write`; the creator adds it explicitly.
Presets are UI sugar — the persisted policy is always the explicit list.
Since catalog v6 no preset holds a `mint-install-token-*` risk: git goes
through the gateway's git remote, and a creator adds a mint risk by hand
when a sandbox truly needs a raw token (it leaves the gateway; ADR
[gateway-as-git-remote](../../docs/decisions/gateway-as-git-remote.md)).

## Diagnosing a workflow run

`github__list_workflow_runs` finds the run, `github__list_workflow_jobs`
(`run_id`, optional `filter: latest | all`) lists its jobs — name, status,
conclusion, steps with their conclusions, `html_url`, start and end — and
`github__get_job_logs` (`job_id`) returns one job's log as plain text, at most
`max_bytes` (default 65536, at most 1048576); `tail: true` keeps the end of
the log, where a failure usually is. A truncated log starts with a
`[log truncated: …]` line. All three are reads of `github.read-meta`, under
the App permission Actions (read). GitHub answers the log with a redirect to a
short-lived download URL: the plugin follows it without the installation
token, and neither the URL nor the log is ever logged.

## Git remote

The plugin declares the instance as its agents' git remote
(`githubGitRemote`, `src/git-remote.ts`): `https://<instance>/git/<owner>/<repo>.git`,
the mission key as the password. Two tools that are not MCP tools are
decided and audited like any call:

| Tool                | When                                    | Arguments (built by the host)                                                               |
| ------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------- |
| `github__git_fetch` | the object transfer of a clone or fetch | `{ repository, step: 'pack' }` — risk `read-code`                                           |
| `github__git_push`  | one push, every ref of it               | `{ repository, updates[] }`, each `{ ref, old, new, kind, commits, files, workflow_files }` |

- **Upstream credential**: an installation token for the one repository,
  `contents: read` to fetch, `contents: write` (+ `workflows: write` when
  the installation holds it) to push; or the token of a token connection
  (`api-key`, field `token`). Cached 50 minutes at most per repository and
  access, with the permissions GitHub reported for it.
- **Admission** (`admitPush`), after the mission decided on what the push's
  own objects change and before the pack leaves: a CI workflow change on a
  token without `workflows: write` is refused by the permission's name, with
  nothing sent to GitHub. A cached token short of it is minted afresh once
  first, so a permission granted on the App is seen at the next push. The
  mission's own check (`github.workflow-write-via-file`) never depends on
  the token: it comes first.
- **Review** (`review`): each ref's value is read at GitHub (`GET git/ref`) —
  a client's `old` that differs is refused as stale — then the compare API
  gives fast-forward or not, commits, changed paths and workflow files
  (anything under `.github/workflows/`), and every commit of the range is
  read for workflow changes (at most 100 per push). Over 300 files or 250
  commits the push is refused: split it. The review does not look at the
  token: the decision comes next.
- **Moves** (`execute` of `github__git_push`), per ref, reported per ref:
  `POST git/refs`, `PATCH git/refs/<ref>` `force: false` for a
  fast-forward; an accepted force-push or delete through GitHub's
  receive-pack with the reviewed `old` as the expected value
  (compare-and-swap); a provider failure on one ref reports that ref. The
  token must cover what the review found (`permission-check.ts`); a move
  GitHub refuses for a missing permission is tried once more with a token
  minted afresh, then named on the ref.
- **Interface words**: `insteadOf` (`https://github.com/`, rewritten to the
  instance by the setup kit) and `abilities` (what each risk means for git,
  sorted on the mission page), `compareUrl` (GitHub's comparison, linked
  from a waiting push).

## Credential: the company's GitHub App

1. **Create the App from the gateway** (once, by an administrator):
   Settings → Administration → Company apps → GitHub. Choose the owner (an
   organisation, or your own account), keep or change the name (`Vaubaan
<host>` by default) and the permissions — by default what the tools need;
   Contents write, Administration and Workflows are marked sensitive and can
   be withheld, and the page says which tools stop without each. The gateway
   posts GitHub's App manifest (private App, user authorization on install,
   the callback below, no webhook); GitHub shows the App and asks you to
   confirm, then sends you back; the gateway exchanges the one-hour code for
   the App's id, key and secrets and stores them encrypted. Nothing to copy.
   Then "Install it on your repositories" is connecting an account (step 3).
   The App belongs to you: every gateway has its own, never a shared one
   (ADR [company-app-created-from-a-manifest](../../docs/decisions/company-app-created-from-a-manifest.md)).

   **Or register it by hand** ("Enter an app registered by hand" on the same
   page): GitHub → Settings → Developer settings → GitHub Apps → New GitHub
   App. Permissions the tools need: Contents (read & write), Pull requests (read & write),
   Issues (read & write), Metadata (read), Actions (read), Administration
   (read & write, for branch protection), Workflows (read & write, for
   pushes touching `.github/workflows/`). Generate a **private key** and
   a **client secret**. Under "Identifying and authorizing users", tick
   **Request user authorization (OAuth) during installation** and set the
   **Callback URL** to the gateway's connection callback
   (`<public_url>/connections/callback/github`, shown in Settings → Administration → Company apps). With that box ticked GitHub offers no setup URL: the
   callback URL receives both `code` and `installation_id`. Keep "Expire
   user authorization tokens" on.

2. **By hand only: configure the instance** with the five app-config keys the spec
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

## Credential, the other way: a fine-grained personal access token

When no GitHub App is registered — or when a person prefers it — an account
is connected with a **fine-grained personal access token** pasted by hand
(`githubTokenCredential`, `src/token.ts`, declared in
`alternativeCredentials`). Often a shared service account: the gateway still
decides every call, and Activity says who made it.

1. At GitHub, signed in as the account the agents will act as: Settings →
   Developer settings → Personal access tokens → Fine-grained tokens →
   Generate new token. Choose the organisation as resource owner, only the
   repositories the missions need, an expiry (90 days recommended), and the
   permissions the connect page lists, derived from `guide.permissions`
   (Contents, Pull requests, Issues, Actions, Workflows, Administration;
   Metadata read is added by GitHub).
2. Paste it on "Connect a GitHub account" ("Use a token instead" when the App
   is registered). A classic token (`ghp_`) is refused: it reaches every
   repository of its account.
3. The gateway checks it (`GET /user`; the expiry header when GitHub sends
   it), lists the repositories it reaches (`GET /user/repos`), and seals it.
   Every API tool sends it as the bearer.

`github__mint_install_token` needs the App (it hands out an installation
token): on a token account it is not listed and is refused before the budget.
A token GitHub rejects (expired, deleted) turns the account "Needs
reconnecting". Removing the account deletes nothing at GitHub: delete the
token on the fine-grained tokens page. ADR
[`token-connections-beside-the-integration-app`](../../docs/decisions/token-connections-beside-the-integration-app.md).

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
- `job-logs.test.ts` — the jobs of a run and the bounded log of a job:
  slices, refused arguments, the redirect followed without the token, head
  and tail truncation.
- `permission-remint.test.ts` — a stale cached grant minted afresh once (API
  tools, `admitPush`, the ref moves), GitHub's missing-permission refusals
  retried once then named.
- `token-cache.test.ts` — connection-scoped reuse of installation tokens.
- `app-manifest.test.ts` — the permission declaration, the manifest per
  choice, the code exchange, and the refusal of a call by its missing permission.

A call the App has no permission for is declined by name
(`github__create_branch needs the GitHub App permission Contents …`), never
left to GitHub's 403. A permission granted on the App since the token was
cached is seen at the next call: a cached token short of the call, or one
GitHub refuses with "Resource not accessible by integration", is minted
afresh once and the call sent once more.

737 tests; none reaches GitHub.
