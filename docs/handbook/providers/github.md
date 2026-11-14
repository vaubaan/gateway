---
title: GitHub provider plugin
tracks:
  - plugins/github/src/
  - plugins/github/README.md
last_reviewed: 2026-11-14
---

# GitHub provider plugin — handbook

`@vaubaan/plugin-github`: repositories, pull requests, issues, releases, workflow runs and logs,
and the instance's git remote ([git-remote](../git-remote.md),
[gateway-as-git-remote](../../decisions/gateway-as-git-remote.md)). One account is a
fine-grained personal access token
([token first](../../decisions/one-place-to-authorize-services-token-first.md)). No risk is
env-scoped. Rules common to every plugin: [providers README](README.md).

## Start here

- [`src/call.ts`](../../../plugins/github/src/call.ts) — every grammar and `readGithubCall`, shared
  by classify and the dispatcher.
- [`src/octokit-dispatch.ts`](../../../plugins/github/src/octokit-dispatch.ts) — checked call →
  Octokit; the merge-base guard.
- [`src/permissions.ts`](../../../plugins/github/src/permissions.ts) — the one list of token
  permissions and the tools each serves; the connect guide is read off it.
- [`src/git-inspect.ts`](../../../plugins/github/src/git-inspect.ts) — what a push changes.

## Invariants

- **The dispatcher takes every identifier from the checked call**, never from raw `args`; `args`
  only supply contents, titles, flags, page sizes, the search `q` and a file write's blob `sha`.
  Requests are built field by field, so an undeclared argument is ignored, not refused.
- **One spelling per risk-selecting argument**: file paths canonical (no leading `/`, `.`, `..`,
  empty segment or backslash), so the `workflow-via-file` marker never depends on how GitHub
  resolves a path; branches are bare names (`refs/…`, `heads/…` refused). A value GitHub answers is
  held to the same grammar (the default branch read by `create_branch`).
- **`merge_pull_request` is classified on the declared `base`** (`main` when absent), which GitHub's
  endpoint does not take: the dispatcher reads the PR and declines when its real base differs.
- Branch risks are by name, not by label: working prefixes (`feature/*`, `fix/*`…) for
  `feature-branch-write`, `main`, `master`, `prod`, `production`, `release-*` for
  `merge-protected`; any other branch lands on the fallback. The working globs are read from the
  catalog by the git remote (`workingBranchesOf`): the YAML is the one list.
- **Slices walk the data model** (`data-model.ts`, held by `catalogPathIssues` and
  `assertSlicesOnDataModel`): a job through its run and workflow,
  `workflow[*].workflow-run[<run>].job.R` and `workflow[*].workflow-run[*].job[<job>].log.R`
  (`[*]`: not in the arguments); the global search under its own root entity `search`
  (`search.code.R`, `search.issues.R`), which is not a resource. An identifier outside the slice
  grammar (`feature/ü`) is `[*]`, never repaired: a branch so written touches both
  `feature-branch-write` and `merge-protected`.
- `workflow-write-via-file` has no `acceptable_in_envs`: always touched, accepted explicitly.
  `create-release` and `delete-release` never match each other's tool; a pushed tag deliberately
  also matches `create-release`.
- **A push is judged on what it changes under `.github/workflows/`** at each pushed tip and in every
  commit of the range; anything unreadable reports `.github/workflows/` (fail closed). A ref's
  `old` must equal GitHub's current tip; a force or delete is one receive-pack command whose `old`
  GitHub checks under the ref lock.
- `get_job_logs` follows the 302 by hand and fetches the signed `https:` location **without** the
  token; neither URL nor log is logged.

## Traps

- Octokit's `encodeURIComponent` leaves `.` and `..`, which URL parsers then drop: `path: '..'` on
  `delete_file` would send `DELETE /repos/{owner}/{repo}/`. Hence grammars, never escapes.
- The merge-base check is a read then the merge, not atomic: a PR retargeted in between merges into
  its new base (GitHub has no "expected base").
- `search_*` is not forced to `repo:<resource>`; `search-global` (blast `account`) is the guard.
- A merge into an unprotected non-working branch (`develop`) lands on the fallback: open catalog
  question.
- `add_labels` with `labels: []` would remove every label at GitHub: the grammar asks 1 to 20 names.
  A label is case-insensitive at GitHub, not in a slice: `E2E` on a mission narrowed to
  `label[e2e]` is refused (fail closed), and a missing label is created, not refused.
- `dispatch_workflow`, `cancel_workflow_run`, `rerun_workflow_run` are retired (risk model §7.2): the plugin's `excludedTools` (`EXCLUDED_TOOLS`, `identity.ts`), refused by name.

## Outside the repo

- **Fine-grained token** only: a classic `ghp_` token is refused by the field pattern (it reaches
  every repo with coarse scopes). Permissions to grant: `src/permissions.ts`; they are the hard
  ceiling at GitHub, which matters where a private repo on a free plan has no branch protection.
- The guide asks for **Only select repositories**, the ones the missions will use (ADR
  one-place-to-authorize-services-token-first, amendment 2026-11-13). Discovery
  (`discoverGithubResources`, `GET /user/repos`) lists the repositories the token reaches: a
  private repository left out of the grant never appears; adding it means editing the token's
  repository access at GitHub (or a new token), then a discovery refresh or a reconnect.

### Repositories outside the grant

- **Why they appear.** A fine-grained token "always includes read-only access to all public
  repositories" (GitHub, Managing your personal access tokens), and `GET /user/repos` lists every
  repository the _user_ owns, collaborates on or reaches through an organization
  (`affiliation=owner,collaborator,organization_member` by default; `visibility`/`affiliation`
  filter on the user's relation, not on the token's grant). Its `permissions` object is the user's
  role on the repository (GitHub's "discovering resources for a user" guide reads it as the user's
  access), not the token's. GitHub has **no endpoint for a token to list its own selected
  repositories** (only a GitHub App's user token has `GET /user/installations/{id}/repositories`).
  Sources: docs.github.com/en/rest/repos/repos (List repositories for the authenticated user),
  the token formats table (`github_pat_` = fine-grained), via Context7 2026-11-14.
- **What the gateway does** (`hiddenByDefault` in `execute.ts`): a private repository is listed as
  usual (a token sees only the private ones it was granted). A public one is marked
  `hiddenByDefault` — under a fine-grained token always (its grant on a public repository cannot
  be read), under any other token when `permissions.push` is false (no token of that user can
  write it). The host stores it hidden from new missions while the owner never hid nor showed it
  (`account_resources.hidden_edited`, ADR connect-driver-and-resource-curation, amendment
  2026-11-14); the account page tags it "the key may only read it".
- **The trade-off.** A public repository that _is_ in the grant is hidden too: the owner shows it
  once on the account page (untick "Hide from new missions"), and every later refresh keeps that.
  Hidden, it is not ticked by "Select all", does not join a card's future resources, and is not in
  `{ scope: 'all' }`; a mission that already names it keeps it (reach is the stored lists). The
  alternative — probing each public repository with a write-shaped call — would cost one request
  per repository per refresh and still prove nothing for read-only grants.
- The gateway cannot change a token's permissions or revoke it: create a new token and reconnect;
  delete the old one on GitHub's token settings page.

## Debug

- "Not connected — GitHub rejected the token" → revoked, expired, or a classic `ghp_` token.
- "connected a way GitHub no longer offers" → a former GitHub App account: reconnect it with a token
  (same id, same missions).
- 403 "Resource not accessible by personal access token" → a missing permission; only a git-remote
  ref move names which.
- A merge declined although accepted → the PR targets another branch: call again with its base.
- Write refused on `github.uncategorized-write` → neither a working prefix nor a protected name.
