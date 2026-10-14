---
title: The gateway is the agent's git remote — fetch relayed, push decided ref by ref, the provider credential never leaves
status: accepted
date: 2026-10-13
extends:
  - mint-install-token-credential
  - one-approval-request-covers-the-call
  - decision-stages-fail-closed-and-audited
  - execution-door-json-faithful-arguments-and-shared-throttle
---

# The gateway is the agent's git remote — fetch relayed, push decided ref by ref, the provider credential never leaves

> Product owner's decision of 2026-10-14: "if I give a mission token to an
> agent, I want it to need nothing else to clone a repo, commit, push, etc.,
> according to its mission-token permissions." He accepted the proposal
> _The agent's git experience — one mission token, nothing else_ and its eight
> recommended answers. Spec:
> [vaubaan-gateway §2.4, §4.1 bis "Git remote", §4.4](../spec/vaubaan-gateway.md)
> (amendment delivered with this decision). Handbooks:
> [git-remote](../handbook/git-remote.md),
> [execution-door](../handbook/execution-door.md),
> [threat-model](../handbook/threat-model.md),
> [providers/github](../handbook/providers/github.md).

## Context

An agent that writes code needs git: a working tree, local tests, history,
rebases. Until now a mission gave it two ways to reach GitHub, neither of
which met the owner's sentence:

- **the API tools** (`push_files`, `create_or_update_file`) — enforced file by
  file, but no working tree, one blob per file, no history;
- **`github__mint_install_token`** — a one-hour installation token the agent
  puts in a URL. During that hour no Vaubaan rule applies, the approval page
  approves a capability rather than an action, the token lands in
  `.git/config`, and a connection made with a personal access token cannot
  narrow it at all.

The proposal compared five mechanisms (API tools only, mint + plain git, a
credential helper trading the key for minted tokens, the gateway as git
remote, and variants: a bundle tool, push options, SSH, a `gh` proxy) and
recommended the gateway as the remote. The owner accepted it and its answers:
build now; remove the two mint risks from the `developer` preset; force-push
gated by approval in `developer`; a `tag-write` risk overlapping
`create-release`; the temporary ref kept while an approval is pending, with a
compare link on the request; pushes beyond the provider's compare limits
refused in v1; the `insteadOf` line in the setup kit; spec amendment and this
ADR first.

## Decision

### D1. A second door of the execution surface: `/git/<repository>.git`

The instance answers git's smart HTTP protocol under
`https://<instance>/git/<owner>/<repo>.git` (the `.git` suffix optional):
`GET …/info/refs?service=…`, `POST …/git-upload-pack`,
`POST …/git-receive-pack`. The mission key arrives as the HTTP Basic
**password**; the user name is ignored. Admission is the execution door's,
shared code and not a copy: the same token verifier, the same `401` reasons,
the same `wrong-credential-kind` for a delegated token or a session, the same
per-mission surface rate limit (`mcp:mission:<id>`, one budget of requests
for both doors), the same origin rule. A missing or rejected password is a
`401` with `WWW-Authenticate: Basic`, so git asks its credential helper. A
structural test holds `/git/*` behind the shared admission.

The Next proxy (`src/proxy.ts`) does not run on `/git/`: it clones and
buffers every request body it sees, up to a limit, which would hold a pack in
memory and truncate it.

### D2. A plugin capability, two audited tools that are not MCP tools

`ProviderPlugin.gitRemote` (`@vaubaan/plugin-sdk`) declares the provider side:
which URL path names which repository, the upstream endpoint and the
credential to present there (`upstream(ctx, repository, 'read' | 'write')`),
the review of a push (`review`), a compare page for the approver, and two tool
names — `github__git_fetch` and `github__git_push` — that the plugin
classifies like any tool and that the pipeline decides, counts and audits like
any tool. At most one registered plugin declares a git remote (the path is
shared); GitHub is the one.

Neither tool is in `tools` nor callable over MCP: `CallRequest.channel`
(`mcp` by default, `git` from the git door) is checked by the resource stage,
and a git tool on the MCP door — or an MCP tool on the git door — is a
structural rejection, audited. So the arguments of a push are always the
host's review, never an agent's claim about its own push.

### D3. Fetch: a streaming relay, protocol v2 when git asks for it

A clone or fetch is relayed byte for byte, both ways, never buffered: the
`Git-Protocol` header is forwarded, so git and GitHub speak protocol v2 when
git asks (the default since git 2.26), v0 otherwise; the request body may be
gzip-encoded and is forwarded as it is. The upstream credential is an
installation token scoped to the one repository and `contents: read`
(App connection), or the connection's token (token connection).

Which request is the call: the requests that only list refs — `GET info/refs`
and, in v2, the `ls-refs` command — are **prechecked** (mission, resource and
risk stages, nothing written) and a precheck that fails runs the full
pipeline, which refuses and audits; the request that transfers objects (a v0
`git-upload-pack` POST, a v2 `fetch` command) is the audited, counted call
`github__git_fetch { repository, step: 'pack' }`, risk `read-code`. A plain
clone is one entry; an incremental fetch that negotiates in several rounds is
one entry per round. Its audit entry is written when the relayed stream ends,
so its latency covers the transfer and a stream that broke is an upstream
error.

### D4. Push: command list, precheck, temporary ref, review, one decision, compare-and-swap

1. The door reads the command list (pkt-lines, bounded) and leaves the pack in
   the stream. Refs outside `refs/heads/` and `refs/tags/`, the gateway's own
   `refs/vaubaan/`, malformed names and push certificates are refused
   (`ng`). The door advertises `report-status`, `delete-refs`,
   `side-band-64k`, `quiet`, `ofs-delta` and the object format only — never
   `atomic`, `push-options`, `push-cert` or `report-status-v2`.
2. **Precheck** with the updates as git sent them (fast-forward assumed, no
   files): a push the mission can never make is refused before any byte
   leaves for GitHub.
3. The pack is **streamed** to GitHub under temporary refs
   `refs/vaubaan/<mission>/<nonce>/<n>`, through a byte counter that cuts it
   at the configured cap, within the configured time.
4. The plugin **reviews** each update from GitHub's compare API: fast-forward
   or not (a non-fast-forward is reviewed both ways, so a rewrite that takes a
   workflow back is seen), commit count, changed paths (renames: both names),
   workflow files. The pack is never read.
5. **One call** `github__git_push { repository, updates[] }`, the reviewed
   updates as arguments: one decision, one request when gated, one audit
   entry for the whole push, every ref refused when one is.
6. Allowed: the plugin moves the real refs through GitHub's receive-pack with
   a command list and an **empty pack** — the objects are already there — the
   reviewed `old` id of each ref as the compare-and-swap value, `atomic` when
   GitHub advertises it. The temporary refs are then deleted.

This replaces the proposal's `PATCH /git/refs` with `force: false`. The ref
moves only if it still points where the review saw it; a fast-forward is a
fast-forward because the review said so and the swap guarantees nothing moved
since; a force-push moves exactly what was approved; it is the same transport
for an App and a token connection; and `atomic` gives a push its all-or-nothing
meaning where GitHub offers it.

### D5. Approval and replay: the same push again

The fingerprint is over the reviewed arguments, which are deterministic for
`(ref, old, new)`: replaying is pushing the same commits again, and an amended
commit asks again. The refusal reaches git as `ng <ref> approval required —
<url>` on each ref, and the side-band progress channel prints the URL and the
instruction on lines of their own. The temporary refs stay while the request
is pending, so the person reads the diff at GitHub (the request page links
GitHub's compare view); a sweeper deletes them at the request's expiry
(`git_pending_refs`, migration 0015). The replay stores the pack again under
new temporary refs: nothing of the first push is reused.

### D6. Limits fail closed, every refusal audited

`git.max_pack_mb` (default 200) and `git.request_timeout` (default
10 min) are configuration keys. A push over the cap, a push GitHub's compare
cannot review in full (300 files or 250 commits per ref, an unrelated
history, an empty repository), a protocol violation: refused with a sentence
git prints, and one audit entry (`CallPipeline.reject`, `refused` with no
code). The defaults are chosen under Railway's limits (a request body must
finish uploading within 5 minutes; a request may last 15 minutes while data
flows): 200 MB in 5 minutes is about 5.5 Mbit/s.

### D7. What git shows

- push: `! [remote rejected] <ref> (<reason>)` from the `ng` lines, with the
  approval or claim URL in the reason and on `remote:` lines;
- fetch refused at the advertisement: HTTP 403 with a `text/plain` body, which
  git prints as `remote:` lines; refused at the transfer: an `ERR` pkt-line,
  printed `fatal: remote error: <reason>`;
- the key stopped working: HTTP 401 with the reason in the body.

### D8. Git LFS is out of scope, and says so

`…/info/lfs/*` answers `501` with the LFS JSON error
`{"message": "Git LFS is not supported by the Vaubaan git remote…"}`, which the
LFS client prints. A mission that needs LFS uses `mint_install_token`.

### D9. Catalog v6 of GitHub, presets

New risks, nothing renamed: `github.git-push` (every pushed ref, leaf `push`),
`github.force-push` (leaf `force`), `github.branch-delete` (leaf `delete` on a
branch), `github.tag-write` (leaves `push` and `delete` on a tag). A deleted
branch also writes the branch (`merge-protected` for `main`); a pushed tag
also writes `tag[<name>]`, which `create-release` covers — the deliberate
overlap. `workflow-write-via-file` also matches a tag whose commits change a
workflow. `developer` gains `git-push` (auto) and `force-push` (approval) and
loses both mint risks; `release-manager` gains `git-push` (auto) and
`tag-write` (approval). The plugin is `3.1.0`.

### D10. The upstream credential

App connection: an installation token minted for the one repository,
`contents: read` to fetch and review, `contents: write` + `workflows: write`
to push (GitHub refuses a workflow change without the second; the App itself
must hold it), cached for the connection like the API tools' tokens. Token
connection (`feat/v5-token-connections`): the connection's token, field
`token`. Either way it is minted or decrypted in memory, presented to GitHub,
never returned, never logged.

## Consequences

- An agent needs git, an MCP client and one environment variable. The setup
  kit gains a fourth snippet: an inline credential helper that reads the
  variable (never `store` or `cache`), and the recommended
  `url."https://<instance>/git/".insteadOf "https://github.com/"`.
- The mission page shows the remote and what git may do with it; the catalog
  endpoint gives the remote URL per repository; the reference page of GitHub
  has a "Git" section.
- `mint_install_token` stays, out of the presets, described as the token that
  leaves.
- A push costs GitHub requests: two for the advertisement and the pack, one or
  two compares per ref, one receive-pack for the refs, one for the cleanup.
- The temporary refs are visible to whoever reads the repository while they
  exist (seconds, or the lifetime of a pending request).
- Missions issued from the v5 `developer` preset keep their mint risks: the
  policy is stored, not derived from the preset.

## Rejected alternatives

- **A credential helper trading the key for minted tokens** (proposal option
  c): the token still leaves; nothing is enforced at push time; useless for a
  token connection.
- **A bundle uploaded through an MCP tool**: same enforcement, a special
  workflow for the agent.
- **SSH remote**: key management for nothing.
- **`PATCH /repos/…/git/refs` to move the ref** (the proposal's mechanism): no
  compare-and-swap on the reviewed `old`, no atomicity across refs, a second
  transport to maintain; see D4.
- **Count and audit every git HTTP request**: a clone would be two or three
  entries and three credits; an approval on `read-code` would be consumed by
  the advertisement.
- **Read the pack** to classify by content: the instance would parse
  attacker-supplied data and hold it; the policy is on refs and paths.
- **Advertise `atomic` and `push-options` to git**: the door cannot promise
  atomicity across the decision, and push options would reach only the
  temporary refs.
