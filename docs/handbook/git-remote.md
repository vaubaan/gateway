---
title: Git remote
tracks:
  - apps/gateway/src/server/git/
  - apps/gateway/src/app/git/
  - apps/gateway/src/proxy.ts
  - packages/plugin-sdk/src/git/
  - plugins/github/src/
  - apps/gateway/src/server/store/repositories/pending-refs.ts
last_reviewed: 2026-11-22
---

# Git remote — handbook

`/git/<service>/<owner>/<repo>.git`, the second door of the execution surface:
plain git with a mission key. Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md)
§2.4, §4.1 ter; ADRs [gateway-as-git-remote](../decisions/gateway-as-git-remote.md),
[protocol-doors-belong-to-the-host](../decisions/protocol-doors-belong-to-the-host.md);
plugin: [services/github](services/github.md).

## Start here

- [`git/door.ts`](../../apps/gateway/src/server/git/door.ts) — path, service, Basic key, admission, dispatch.
- [`git/push.ts`](../../apps/gateway/src/server/git/push.ts) — the push steps, in order.
- [`plugin-sdk/src/git/`](../../packages/plugin-sdk/src/git/) — pkt-line, advertisement, bounded pack reader.
- [`github/src/git-review.ts`](../../plugins/github/src/git-review.ts), [`git-moves.ts`](../../plugins/github/src/git-moves.ts) — what GitHub is asked.

## Invariants

- Nothing is stored but rows of temporary refs: the fetch pack is streamed,
  the service credential lives in memory for the request, the mission key is
  never logged nor sent upstream.
- A push is decided before any byte leaves: `pushRisk` before a write
  credential exists, then the budget preflight and the pack inspection, before
  the pack is stored at GitHub.
- One `github__git_push` call carries every ref: one decision, one request
  when gated, one audit entry; every ref is refused when one is. The pack
  inspection's workflow paths are unioned with the review's
  (`withInspection`): neither can make a push look smaller.
- Fail closed on the wire: every capability asked must be one the door
  advertised. Never advertised: `atomic`, `push-options`, `push-cert`,
  `report-status-v2`.
- Admission is the MCP door's `MissionAdmission`, sharing its surface window
  `mcp:mission:<id>`.
- The door is the host's; any number of plugins declare `gitRemote`, each
  reached only under its own id (`PluginRegistry.gitRemoteOf`). An unknown
  `<service>`, or one without `gitRemote`, is a `404` before the key is read;
  a mission without an account on it is refused by the resource stage,
  audited like any call. `repositoryOf` receives the path after the service
  segment, `.git` removed.

## Traps

- The Next proxy's matcher excludes `/git/`: it would buffer and cut packs.
- Every URL the instance gives (catalog `git_remote`, kit, mission page,
  Reference) comes from `gitRemoteBase` / `gitRemoteUrl` in `git/paths.ts`;
  the kit's `insteadOf` maps the plugin's prefix to `<instance>/git/<service>/`.
  A kit taken before the service segment (2026-11-02) points at
  `/git/<owner>/…` and gets a `404` naming the remotes served: take the kit
  again.
- A POST whose body is a lone flush packet is git's credential probe: `200`
  after admission, not audited.
- `no-thin` is advertised so the inspection reads every object; a thin pack
  anyway counts what it cannot resolve as a workflow change. A gzip-encoded v2
  body is not read and counts as a transfer.
- Temporary refs `refs/vaubaan/<random>` carry no mission id (every reader of
  the repository can list them) and are hidden from every listing. Cleanup has
  its own 60 s deadline, never the request's signal; a row goes only once its
  ref is confirmed gone. On `approval-required` they stay until the request
  expires.
- The review's base is what no branch already holds, and always the default
  branch for a create. A repository with no branch at all (created without a
  README) still names a default branch at GitHub (`main`) that does not exist:
  comparing with it answers 404, which used to refuse the first push as
  "no history in common". With no `refs/heads/*` at GitHub, a create is
  reviewed against nothing — every commit of its history, every path of its
  tip's tree (`?recursive=1`) — under the same 100-commit / 300-file limits.
  An empty initial commit (`--allow-empty`) has git's empty tree
  (`4b825dc6…`): it counts no file and GitHub is not asked to list it.
- "No history in common" is a 404 of the compare API: a history that shares
  no commit with the base. The refusal tells the agent to fetch the branch
  and rebase onto it; it is never lifted, because no base means no diff to
  review against an existing branch.
- Force and delete are one receive-pack command with an empty pack, a
  compare-and-swap under GitHub's ref lock; refs move one by one, reported per
  ref like git without `--atomic`.
- GitHub declares no `admitPush` (it cannot know a pasted token's
  permissions): GitHub's own refusal is named on the ref.
- The in-flight bound (2 pushes per mission) and the relay job are
  single-process. Git LFS answers `501`.
- Bytes on the audit entry (Activity's Overview) come from the git pipeline's
  `gitMeter`: a relayed fetch resolves with `{ sent_bytes, relayed_bytes }`
  (git's request counted through `counted`, the pack through `observed`); a
  push carries its pack's size as `payload_bytes`, its result counted as
  JSON. The pack stored at GitHub before the decision is counted on the push's
  entry only when the push is allowed. A ref listing is not a call and counts
  nothing.

## Outside the repo

- Railway (checked 2026-10-14): a body must finish uploading in 5 minutes, a request lasts at most
  15; 200 MB in 5 minutes is about 5.5 Mbit/s — size `git.max_pack_mb` and
  `git.request_timeout` to the host.

## Debug

- `GIT_TRACE_CURL=1 GIT_TRACE_PACKET=1` shows what the door answered; the key
  appears as a Basic header — never paste such a trace.
- Instance logs: `git push` / `git fetch` (mission, token prefix, outcome,
  refusal code), `temporary refs not deleted at the service`.
- Leftover `refs/vaubaan/*` → rows and deadlines in `git_pending_refs`;
  `root.git.sweeper.runOnce()` sweeps now.
