# `@vaubaan/plugin-github`

GitHub provider plugin for Vaubaan Gateway, written against
[`@vaubaan/plugin-sdk`](../../packages/plugin-sdk). One connection is one
**fine-grained personal access token**; one resource is one repository the
token reaches (`owner/repo`); a mission picks repositories and macro-actions at
a trust level, which write the risks it accepts.

Handbook: [`docs/handbook/providers/github.md`](../../docs/handbook/providers/github.md).
Contract: [`docs/handbook/plugin-sdk.md`](../../docs/handbook/plugin-sdk.md),
ADRs [`plugin-contract-and-credential-spec`](../../docs/decisions/plugin-contract-and-credential-spec.md),
[`plugin-identifiers-one-grammar-for-classify-and-execute`](../../docs/decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md),
[`one-place-to-authorize-services-token-first`](../../docs/decisions/one-place-to-authorize-services-token-first.md),
[`gateway-as-git-remote`](../../docs/decisions/gateway-as-git-remote.md).

## Layout

| File                      | Role                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/index.ts`            | `definePlugin({...})` → `githubPlugin` (default export).                                                 |
| `src/identity.ts`         | `PROVIDER_ID` and `TOOL`, every tool name: the one place they are written.                               |
| `src/risk-catalog.yaml`   | The risks, the fallback and the macro-actions. Loaded by the SDK at boot; the only catalog artefact.     |
| `src/data-model.ts`       | Planes `repo` (branch → file / commit; tag, release, PR, issue, workflow → run → job) and `search`.      |
| `src/tools.ts`            | 28 MCP tools `github__<verb>_<noun>`; every repo-scoped tool takes `owner` + `repo`.                     |
| `src/call.ts`             | The grammar of every identifier and `readGithubCall`, the one reader `classify` and `execute` share.     |
| `src/classify.ts`         | Pure `(tool, args, resources) → slices \| denied`. The security-critical file.                           |
| `src/credential.ts`       | The token `CredentialSpec` and its check at paste (`verifyGithubToken`).                                 |
| `src/permissions.ts`      | `GITHUB_TOKEN_PERMISSIONS`: the token permissions and the tools each serves; the connect guide reads it. |
| `src/execute.ts`          | `execute` (Octokit over `ctx.fetch`, the token as bearer) and `discoverResources` (paged).               |
| `src/octokit-dispatch.ts` | Checked call → Octokit call; a merge whose pull request targets another base is declined.                |
| `src/job-logs.ts`         | `get_job_logs`: the redirect followed without the token, the log read bounded.                           |
| `src/git-remote.ts`       | The git remote capability; `git-credential`, `git-inspect`, `git-review`, `git-moves`, `git-rest`.       |

The plugin imports the SDK only (plus `@octokit/rest`); nothing from
`apps/` or `@vaubaan/gateway-core`.

## Data model

One plane, `repo`, with two roots. Under `repo`, the repository is the resource; the **branch is the
environment of files and commits** (`branch[main]` ≠ `branch[feature/x]`),
so the catalog tells protected branches by name, not by the owner's
environment label. A job is named through its run and workflow
(`workflow[*].workflow-run[7].job`), `[*]` where the arguments do not name
the parent. The second root, `search`, is GitHub's global search (`search.code`,
`search.issues`): not a resource, beyond the mission's repositories. Virtual
leaves carry intentions that are not entities: `branch[X].merge-into`,
`branch[X].propose-to[Y]`, `branch[X].workflow-via-file`,
`branch[X].files-bulk`, `release[id].delete`.

An identifier the slice grammar cannot carry (`feature/ü`, `my notes.md`, a
fork head `owner:branch`) is written as "any" (`[*]`), never repaired into
another name: a branch so written touches every risk a branch may.

## Catalog and macro-actions

The risks are in `src/risk-catalog.yaml`; the handbook argues the
classification. What a reviewer must know:

- A write on `main, master, prod, production, release-*` touches
  `merge-protected`; on `feature/*, feat/*, fix/*, chore/*, bug/*, docs/*,
refactor/*` it touches `feature-branch-write`; any other branch name falls
  to the fallback `github.uncategorized-write`, which no macro-action offers.
  A name outside the slice grammar (`feature/ü`) touches both named risks.
- A file under `.github/workflows/` touches `workflow-write-via-file` (a
  privilege-escalation vector), through the API or through a push.
- `search_code` / `search_issues` touch `search-global`: they are bounded by
  the token, not by the mission's repositories.
- A push through the git remote touches `git-push` beside the branch's own
  risk; `force-push`, `branch-delete` and `tag-write` add to it.
- `add_labels` touches `label-write`, one slice per label
  (`issue[N].label[<name>].W`, `[*]` for a name the slice grammar cannot
  carry): a mission can be narrowed to named labels. An empty list is refused
  (GitHub reads it as "remove every label").
- `mint-install-token-clone` / `-push` are deprecated (they belonged to the
  removed GitHub App); no call touches them.

A creator ticks macro-actions, each at a trust level (Careful / Trusting /
Autonomous, risk model §4.6); the trust level sets each risk's gate from its vector and
multiplies the base budget. The fallback sits apart, under "Anything else".

| Macro-action | What it covers                                           | Its risks                                                                                                                         |
| ------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `read`       | Code, metadata and global search.                        | `read-code`, `read-meta`, `search-global`                                                                                         |
| `propose`    | Work branches, push, pull requests, comments and labels. | `feature-branch-write`, `git-push`, `bulk-file-write`, `create-pr`, `comment-write`, `label-write`, `branch-delete`, `force-push` |
| `ship`       | Merge on protected branches, tags and releases.          | `merge-protected`, `tag-write`, `create-release`, `delete-release`                                                                |
| `administer` | Branch protection and workflow files.                    | `branch-protection-write`, `workflow-write-via-file`                                                                              |

`force-push`, `branch-delete`, protected merges, tags, releases and
`administer` ask first below Autonomous; `delete-release` is left out at
Careful and asks first above.

## Classification and execution

What is classified is what is sent. `readGithubCall` (`src/call.ts`) reads
the arguments once, against the mission's repositories; `classify` and
`execute` both start from the call it returns. Each identifier kind has one
grammar (login, repository name, canonical relative path, `git
check-ref-format` branch or tag name, revision, positive integer); a value
outside it is refused, never escaped. Requests are built field by field from
declared arguments. The trap the grammars close: Octokit encodes path
parameters with `encodeURIComponent`, which leaves `.` and `..`, and the URL
parser then drops them — `path: '..'` on `delete_file` would become
`DELETE /repos/{owner}/{repo}/`.

`merge_pull_request` is classified on the declared `base` (`main` when
absent); the merge is declined when the pull request targets another
branch. What `execute` declines itself is an `isError` result; what GitHub
fails is thrown (`UpstreamAuthError` on 401/403, `UpstreamHttpError`
otherwise, `UpstreamProtocolError` for an answer that is not what its API
says). Every answer the plugin reads itself goes through the SDK's
transport (`httpJson`, type guards); Octokit's answers are passed through,
the jobs of a run read field by field.

## Diagnosing a workflow run

`list_workflow_runs` → `list_workflow_jobs` (`run_id`, `filter: latest |
all`) → `get_job_logs` (`job_id`): the job's log as plain text, at most
`max_bytes` (default 64 KiB), `tail: true` for its end. A truncated log
starts with `[log truncated: …]`. All three are `read-meta`, token
permission Actions (read). GitHub answers the log with a redirect to a
short-lived URL: the plugin follows it without the token and never logs the
URL or the log.

## Git remote

The instance is its agents' git remote (`src/git-remote.ts`,
[handbook](../../docs/handbook/git-remote.md)):
`https://<instance>/git/github/<owner>/<repo>.git`, the mission key as the
password. Two host-built tools are decided and audited like any call:

| Tool                | When                                    | Arguments (built by the host)                                                               |
| ------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------- |
| `github__git_fetch` | the object transfer of a clone or fetch | `{ repository, step: 'pack' }` — risk `read-code`                                           |
| `github__git_push`  | one push, every ref of it               | `{ repository, updates[] }`, each `{ ref, old, new, kind, commits, files, workflow_files }` |

- **Upstream credential** (`git-credential.ts`): the connection's token,
  presented as `x-access-token`, in memory, never returned to the agent.
- **Inspect** (`git-inspect.ts`), before the pack leaves: whether each
  update's tip changes `.github/workflows/`.
- **Review** (`git-review.ts`), reads only: each ref is read at GitHub and a
  differing client `old` is refused as stale; the compare API gives the
  kind, commits, changed files and workflow files; every commit of the range
  is read for workflow changes (at most 100 per push). Over 300 files or 250
  commits per comparison, an unrelated history or an empty repository: the
  push is refused. The review ignores the token's permissions — the
  mission's decision comes first.
- **Moves** (`git-moves.ts`), per ref, reported per ref: create
  `POST git/refs`; fast-forward `PATCH git/refs/<ref>` `force: false`; force
  and delete through receive-pack with the reviewed `old` as expected value
  (compare-and-swap). A failure on one ref reports that ref and goes on. When
  GitHub refuses a move for a permission the token lacks (Workflows for a
  change under `.github/workflows/`), the ref's error names the permission.
- **Interface words**: `insteadOf` (`https://github.com/`, rewritten by the
  setup kit), `abilities` (what each risk means for git), `compareUrl`.

## Credential: a fine-grained personal access token

The one way of connecting GitHub (`githubCredential`, `src/credential.ts`).
Often a shared service account: the gateway still decides every call, and
Activity says who made it.

1. At GitHub, signed in as the account the agents will act as: Settings →
   Developer settings → Personal access tokens → Fine-grained tokens →
   Generate new token. Resource owner: the organization; All repositories;
   an expiry; every permission the connect page lists, built from
   `GITHUB_TOKEN_PERMISSIONS` (Contents, Pull requests, Issues, Actions,
   Administration, Workflows; GitHub adds Metadata read). Grant this wide
   once: each mission narrows it to its repositories and permissions, and a
   token that lacks one means a new token.
2. Paste it on "Connect a GitHub account". A classic token (`ghp_`) is
   refused by the field's pattern: it reaches every repository of its
   account.
3. The gateway checks it (`GET /user` names the account; the
   `github-authentication-token-expiration` header, when sent, gives the
   expiry), lists the repositories it reaches (`GET /user/repos`, 100 per
   page, up to 10 pages) as resources, and seals it. Every API tool and the
   git remote send it as the bearer.

GitHub enforces what the token may do; a call it lacks a permission for
comes back as GitHub's refusal. A token GitHub rejects (expired, deleted)
turns the account "Needs reconnecting". Removing the account deletes
nothing at GitHub: delete the token on the fine-grained tokens page.

## Tests

```bash
npx vitest run plugins/github
```

- `plugin.test.ts` — SDK kit (well-formed, no wildcard, catalog coverage
  with samples per tool, `fallbackHits` empty, every pattern and slice a path
  of the data model), the macro-actions at each trust level.
- `risk-catalog.test.ts` — the table `[tool, arguments, risks touched]`: add
  a row whenever a tool, a classifier branch or a catalog pattern changes.
- `classify.test.ts` — the classifier's security suite: exact slices or
  denial.
- `injection.test.ts` — every identifier position fed `..`, `.`, `a/../b`,
  encoded, empty, overlong and multi-line values: refused by `classify` and
  `execute` with nothing sent, or sent as the exact classified path.
- `credential.test.ts` — the check at paste, discovery, the token as bearer.
- `execute.test.ts`, `job-logs.test.ts`, `data-model.test.ts` — Octokit over
  `mockFetch`, declined calls as `isError`, the bounded log, data-model
  integrity.
- `git-inspect.test.ts`, `git-moves.test.ts`, `git-rest.test.ts` — workflow
  detection before the pack leaves, the ref moves and their per-ref reports,
  the REST reads and their typed failures.

None reaches GitHub.
