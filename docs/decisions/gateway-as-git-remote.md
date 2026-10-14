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
> [vaubaan-gateway §2.4, §4.1 ter "Git remote", §4.4](../spec/vaubaan-gateway.md)
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

The capability also carries what the interface says about git, so the host
names no provider: `insteadOf` (the provider's URL prefix the setup kit
rewrites to the instance) and `abilities` (what each permission of the
catalog means for git, which the mission page sorts into "can", "asks you
first" and "cannot" from the mission's policy).

Neither tool is in `tools` nor callable over MCP: `CallRequest.channel`
(`mcp` by default, `git` from the git door) is checked by the resource stage,
and a git tool on the MCP door — or an MCP tool on the git door — is a
structural rejection, audited. So the arguments of a push are always the
host's review, never an agent's claim about its own push.

### D3. Fetch: a streaming relay, protocol v2 when git asks for it

A clone or fetch is relayed to GitHub: the `Git-Protocol` header is
forwarded, so git and GitHub speak protocol v2 when git asks (the default
since git 2.26), v0 or v1 otherwise. The upstream credential is an
installation token scoped to the one repository and `contents: read` (App
connection), or the connection's token (token connection).

Which request is the call: the requests that only list refs — `GET info/refs`
and, in v2, the `ls-refs` command — are **prechecked** (mission, resource and
risk stages; a refusal is audited, a pass is not recorded); the request that
transfers objects (a v0/v1 `git-upload-pack` POST, a v2 `fetch` or any other
command) is the audited, counted call `github__git_fetch { repository, step:
'pack' }`, risk `read-code`, its bytes relayed as they come, never held. A
plain clone is one entry; an incremental fetch that negotiates in several
rounds is one entry per round. Its audit entry is written when the relayed
stream ends.

The head of a v2 request — its capability lines up to the delim packet — is
read strictly: **exactly one** `command=` line, or the request is refused
(`ERR`, audited). The door does not rely on GitHub to refuse a second
command. A gzip-encoded v2 body is not read and is counted as a transfer
(fail closed).

The ref listings — the v0/v1 advertisement and the v2 `ls-refs` answer — are
read whole (at most 16 MiB) and relayed **without the gateway's temporary
refs** (`refs/vaubaan/*`): a mission does not see another mission's pending
pushes through the door. GitHub's own interface and API still list them
(D5).

### D4. Push: command list, limits, temporary ref, review, one decision, moves

1. The door reads the command list (pkt-lines, bounded: 1 MiB for the list,
   65 520 bytes per pkt-line, 1 024 bytes per ref name, 50 commands) and
   leaves the pack in the stream. It is **fail closed**: a capability it did
   not advertise — **on any command line**, since receive-pack honours a
   feature list wherever it is written —, a missing `report-status` (without
   it a client reads a refused push as a success), the same ref twice, a ref
   name with a byte `git check-ref-format` never allows, a malformed shallow
   line, a push certificate, a truncated or malformed pkt-line: a refusal
   (`ERR` line, one audit entry), never ignored. **Every** command is read
   and decided, not the first one only (cf. CVE-2025-54583 in FINOS
   GitProxy, which checked the first branch of a multi-ref push).
2. The mission must hold the plugin's `pushRisk` (`github.git-push`): a
   mission that cannot push gets neither the receive-pack advertisement nor
   a write credential minted for it.
3. At most **2 pushes of one mission in flight** at once; a third is refused
   before its pack is read.
4. **Precheck** with the updates as git sent them (fast-forward assumed, no
   files), **the limits included**: the budget's quota and rate windows are
   read without counting (`BudgetStage.preflight`), so a push its mission,
   its permissions or its limits refuse is refused, with the claim URL when
   there is one, before any byte leaves for GitHub. What cannot move earlier
   — an approval, a refusal of the review — needs the pack at GitHub first.
5. The pack is **streamed** to GitHub under temporary refs
   `refs/vaubaan/<32 random hex>` — no mission id in the name, since every
   reader of the repository can list them at GitHub —, through a byte counter
   that cuts it at the configured cap, within the configured time. Each
   temporary ref is recorded (`git_pending_refs`, with the ref it stands for)
   **before** the pack leaves, with the request's deadline. A mission holds
   at most **100** temporary refs at once.
6. The plugin **reviews** each update: it reads the ref's value at GitHub
   (`GET git/ref`) and refuses the push as _stale info_ when the client's
   `old` differs — the client's old ids are claims, and a later claimed `old`
   would keep out of the review the commits between the real value and the
   claim. Then GitHub's compare API: fast-forward or not (a non-fast-forward
   is compared both ways, so a rewrite that takes a workflow back is seen),
   commit count, the net changed paths (renames: both names). **Every commit
   the range brings is read** (`GET commits/{sha}`, at most 100 per push, a
   commit listing 300 files or more refused): a workflow file changed by an
   intermediate commit and taken back at the tip still counts as a workflow
   change. Workflow files are anything under `.github/workflows/`. The App's
   permissions are checked against what the updates need (`contents:
write`, `workflows: write` for a workflow file) from the one declaration
   of `app-manifest.ts`. The pack is never read.
7. **One call** `github__git_push { repository, updates[] }`, the reviewed
   updates as arguments: one decision, one request when gated, one audit
   entry for the whole push, every ref refused when one is.
8. Allowed: the plugin moves each ref, in order, each reporting on its own
   like git without `--atomic`; a provider failure on one ref reports that
   ref and the others go on:
   - create: `POST git/refs` (GitHub refuses an existing ref);
   - fast-forward: `PATCH git/refs/<ref>` with `force: false` (GitHub
     refuses a non-fast-forward against the ref's value at that moment);
   - force-push (only when `force-push` was accepted) and delete (only when
     `branch-delete` or `tag-write` was): a command `<old> <new> <ref>` to
     GitHub's receive-pack with an empty pack — the objects are already
     there under the temporary ref — whose `old` GitHub checks under the
     ref's lock: a **compare-and-swap** on the reviewed value.
9. The temporary refs are deleted on every path — success, refusal, provider
   failure, a client that hung up — with a deadline of their own, never the
   request's signal. A row goes only when GitHub confirmed its ref gone (per
   ref, `ok` in the report, or no longer listed); a ref GitHub kept keeps its
   row, for the sweeper.

The moves follow the owner's decision ("fast-forward via PATCH refs
force:false") and his answer to the question of accepted risk A31: the REST
API has no compare-and-swap, so a forced `PATCH` or a `DELETE` after a re-read
could overwrite a push that landed in between. Force and delete therefore go
through receive-pack, whose expected old value GitHub checks atomically;
create and fast-forward keep the REST writes, which are safe without it.

### D4 bis. The capabilities the door advertises

| Capability              | Advertised                | Why                                                                                                                                                          |
| ----------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `report-status`         | yes, and required         | git needs it to print a per-ref outcome; a push without it is refused, since a client that does not ask for it reads any answer as a success.                |
| `report-status-v2`      | no                        | Per-ref options for proc-receive; nothing to report with them. A client asking for it is refused.                                                            |
| `delete-refs`           | yes                       | Deletions are decided (`branch-delete`, `tag-write`) and implemented.                                                                                        |
| `side-band-64k`         | yes                       | Carries the gateway's messages on `remote:` lines (the approval URL).                                                                                        |
| `quiet`                 | yes                       | Harmless; GitHub's own progress is not relayed.                                                                                                              |
| `ofs-delta`             | when GitHub advertises it | The pack is relayed untouched.                                                                                                                               |
| `object-format=sha1`    | yes                       | Object ids are SHA-1 throughout; a SHA-256 repository is refused.                                                                                            |
| `agent=vaubaan-gateway` | yes                       | Identification only.                                                                                                                                         |
| `atomic`                | no                        | The decision is all-or-nothing, the moves are not atomic across refs: advertising it would promise what the door cannot keep. git refuses `--atomic` itself. |
| `push-options`          | no                        | They would reach only the temporary refs. git refuses `-o` itself.                                                                                           |
| `push-cert`             | no                        | Signed pushes are neither verified nor relayed; refused. A signed **commit** is an object like any other and crosses byte for byte, signature intact.        |

A capability the door did not advertise is refused wherever the client wrote
it — first command line or any other.

### D5. Approval and replay: the same push again

The fingerprint is over the reviewed arguments, which are deterministic for
`(ref, old, new)`: replaying is pushing the same commits again, and an amended
commit asks again. The refusal reaches git as `ng <ref> approval required —
<url>` on each ref, and the side-band progress channel prints the URL and the
instruction on lines of their own. The temporary refs stay while the request
is pending, so the person reads the diff at GitHub (the request page links
GitHub's compare view); their rows in `git_pending_refs` (migration 0015)
then carry the request's expiry instead of the push's deadline. A later push
of the same mission to the same ref **supersedes** them: its own refs wait,
the earlier ones are deleted. The replay stores the pack again under new
temporary refs: nothing of the first push is reused.

A sweeper (every five minutes) deletes at GitHub every temporary ref whose
deadline passed — an expired request, a push that never finished (a crash, a
client gone, a provider that did not answer or kept the ref). One run takes
batches of 100 until nothing is left to try (at most 20); a group GitHub
refused this run is postponed by one interval, to the back of the queue,
instead of heading every batch; a row older than 48 hours is given up and
logged; a connection that is gone drops its rows.

### D6. Limits fail closed, every refusal audited

`git.max_pack_mb` (default 200) and `git.request_timeout` (default 10 min)
are configuration keys; the others are constants of the git module: 50 refs
per push, 2 pushes of a mission in flight, 100 temporary refs per mission,
100 commits reviewed one by one per push, 16 MiB of ref listing. A push over
a cap, a push GitHub's compare cannot review in full (300 files or 250
commits per ref, an unrelated history, an empty repository), a protocol
violation: refused with a sentence git prints, and one audit entry
(`CallPipeline.reject`, `refused` with no code). A push refused after its
pack was stored — the review, an approval — has cost one upload; the
in-flight bound and the surface rate limit bound how often. The defaults are
chosen under Railway's limits, read on 2026-10-14 in docs.railway.com
"Public networking — specs and limits": "HTTP requests can run for up to 15
minutes if data keeps transferring", they close "after 5 minutes with no data
transferred", "request bodies must finish uploading within 5 minutes",
headers are limited to 32 KB, and no body size limit is stated. 200 MB in 5
minutes is about 5.5 Mbit/s of upload.

A mission key revoked or rotated while one of its requests is streaming does
not stop that request: admission runs once per request, like a tool call on
the MCP door. A request lasts at most `git.request_timeout`.

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

### D9 bis. The wire code is ours, and small

No maintained library covers the part we need: on npm, `git-pkt-line`
(0.1.0, last published 2022), `git-http-backend` (1.1.2, 2022) and
`node-git-server` (1.0.0, 2022) are unmaintained, and none reads a
receive-pack command list strictly. The SDK keeps its own pkt-line framing,
command-list reader, report-status and advertisement codec, the strict
reader of a v2 request head and the filters of the ref listings
(`packages/plugin-sdk/src/git/`, a few hundred lines), with exhaustive unit
tests and seeded property tests of the command-list reader, of the door's
judgement of a command list and of the v2 head; everything after the command
list — the pack — is bytes the door never parses. One helper streams "a head
already read, then the rest" (`prependChunk`).

An independent adversarial review of the branch (2026-10-14) found no policy
escape and seven issues of cost, residue and strictness; D3 to D6 describe
the code after their fixes, and each has a regression test
(`apps/gateway/tests/integration/git/git-remote-review.test.ts`).

### D10. The upstream credential

App connection: an installation token minted for the one repository,
`contents: read` to fetch and review; to push, `contents: write` +
`workflows: write` when the installation holds both, else `contents: write`
alone (GitHub answers 422 to a token asking for more than the installation
holds). The token's permissions, as GitHub reports them, are checked against
what a push needs (D4): a push that changes a workflow file without
`workflows: write` is refused by the permission's name, from the App's one
permission declaration (`app-manifest.ts`, ADR
company-app-created-from-a-manifest). Cached for the connection like the
API tools' tokens. Token
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
- A push costs GitHub requests: two for the advertisement and the pack, one
  ref read and one or two compares per ref, one REST write per ref (two for a
  force or a delete), one receive-pack for the cleanup.
- The temporary refs are visible to whoever reads the repository while they
  exist (seconds, or the lifetime of a pending request).
- Missions issued from the v5 `developer` preset keep their mint risks: the
  policy is stored, not derived from the preset.

## Rejected alternatives

- **A persistent mirror per repository on the instance** (`git
http-backend` over a bare clone, a `pre-receive` hook calling the
  decision, the hook forwarding to GitHub): real git speaks the protocol,
  but a copy of every repository lives on the instance's disk, storage grows
  with the repositories, and the instance stops being stateless, which
  horizontal scaling needs. Refused by the owner (2026-10-14). Verified on
  the way, for the record: with git 2.48.1 a `pre-receive` hook can push the
  quarantined objects to another host, and the mirror's refs move only after
  the upstream accepted.
- **An ephemeral partial clone per push** (a blobless clone into a temporary
  directory, the pack received there, the review computed with
  `git diff --name-only`): no compare limits, but a disk and a clone per
  push. Kept as the way out if GitHub's compare limits bite in practice.
- **FINOS GitProxy** (`@finos/git-proxy`, Apache-2.0): a full application
  with its own database, users, interface and approval workflow; it would
  duplicate missions, approvals and the audit, and it checked only the first
  ref of a multi-ref push (CVE-2025-54583).
- **Hand the decision to GitHub** (rulesets and branch protection, the agent
  given a minted token): branch protection exists only on public
  repositories on GitHub Free, rulesets know nothing of the mission's budget
  or approvals, and a token connection cannot be narrowed at all.
  `mint_install_token` stays for the rare case that needs a raw token.
- **Every move through GitHub's receive-pack** (this branch's first
  implementation, `atomic` when GitHub offers it): one transport for all, but
  the owner chose the REST writes for create and fast-forward, which need no
  compare-and-swap.
- **Force and delete through REST after a re-read** (the second
  implementation): a push landing between the re-read and the write is
  overwritten — the API has no compare-and-swap. Replaced by receive-pack for
  those two (D4).
- **Trust the client's old ids, or GitHub to refuse a second v2 command**:
  both are claims of someone else; the door checks them itself.
- **A credential helper trading the key for minted tokens** (proposal option
  c): the token still leaves; nothing is enforced at push time; useless for a
  token connection.
- **A bundle uploaded through an MCP tool**: same enforcement, a special
  workflow for the agent.
- **SSH remote**: key management for nothing.
- **Count and audit every git HTTP request**: a clone would be two or three
  entries and three credits; an approval on `read-code` would be consumed by
  the advertisement.
- **Read the pack** to classify by content: the instance would parse
  attacker-supplied data and hold it; the policy is on refs and paths.
- **Advertise `atomic` and `push-options` to git**: see D4 bis.
