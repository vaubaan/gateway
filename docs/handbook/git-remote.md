---
title: Git remote — /git/<owner>/<repo>.git, the second door of the execution surface
status: current
date: 2026-10-14
last_synced: 2026-10-18
tracks:
  - apps/gateway/src/server/git/
  - apps/gateway/src/app/git/
  - apps/gateway/src/proxy.ts
  - apps/gateway/src/server/execution/admission.ts
  - apps/gateway/src/server/execution/resource-stage.ts
  - apps/gateway/src/server/execution/tools.ts
  - apps/gateway/src/server/store/repositories/pending-refs.ts
  - apps/gateway/migrations/0015_git_pending_refs.sql
  - apps/gateway/src/server/config/sources.ts
  - apps/gateway/src/server/missions/bootstrap-kit.ts
  - apps/gateway/src/server/missions/git-view.ts
  - apps/gateway/src/server/requests/provider-pages.ts
  - apps/gateway/src/app/agent-bootstrap.md/content.md
  - packages/plugin-sdk/src/git/
  - packages/gateway-core/src/pipeline.ts
  - plugins/github/src/git-remote.ts
  - plugins/github/src/git-credential.ts
  - plugins/github/src/git-rest.ts
  - plugins/github/src/git-review.ts
  - plugins/github/src/git-inspect.ts
  - plugins/github/src/git-heads.ts
  - plugins/github/src/git-moves.ts
  - plugins/github/src/git-call.ts
  - apps/gateway/tests/integration/git/
  - apps/gateway/tests/e2e/v5/git-remote.spec.ts
  - packages/plugin-sdk/tests/unit/git-wire.test.ts
  - apps/gateway/tests/unit/server/git/
  - plugins/github/tests/unit/git-moves.test.ts
  - apps/gateway/src/server/budget/budget-stage.ts
  - apps/gateway/src/server/budget/session-service.ts
---

# Git remote — `/git/<owner>/<repo>.git`, the second door of the execution surface

How an agent holding a mission key clones, fetches and pushes with plain git,
the instance standing between it and the provider: the routes, the shared
admission, the fetch relay, the push and its decision, the temporary refs,
what git prints. Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §2.4,
§4.1 ter "Git remote", §4.4 (setup kit). Decision:
[gateway-as-git-remote](../decisions/gateway-as-git-remote.md). Neighbours:
[execution-door](execution-door.md) (admission, stages, audit),
[providers/github](providers/github.md) (the one plugin that declares a
remote), [threat-model](threat-model.md).

Nothing is stored but rows of temporary refs: the pack is streamed, never
held; the provider's credential is decrypted in memory for the
request, never returned; the mission key is never logged and never sent
upstream.

## Layout

```
apps/gateway/src/app/git/[...path]/route.ts   GET | POST | PUT | DELETE /git/** → root.git.handle (nodejs runtime)
apps/gateway/src/proxy.ts                     `config.matcher` excludes /git/: the Next proxy would buffer and cut the pack
apps/gateway/src/server/git/                  host-agnostic, never imports `next`
  index.ts          createGitModule(deps) → root.git { door, pipeline, sweeper, handle }
  door.ts           GitDoor.handle(): path, Basic key, admission, probe, dispatch; bearerOf()
  scope.ts          Scope (one admitted request), fetchCall/pushCall, targetOf, refsRefusal, the refusal answers
  fetch.ts          FetchSide: the upload-pack advertisement and ls-refs (filtered), the decided pack relay, the v2 head
  push-side.ts      PushSide: the receive-pack advertisement, the push's first checks (pushRisk), then Push
  push.ts           Push: one receive-pack request, the steps below; withInspection()
  pack-buffer.ts    readPack(): the pack read whole, at most git.max_pack_mb
  push-stop.ts      PushStop, tooLarge(), interrupted()
  command-list.ts   readPushCommands(), commandListIssue(), provisional(), ACCEPTED_PUSH_CAPABILITIES
  temporary-refs.ts TemporaryRefs (upstream, renewUpstream, store, keepForApproval, cleanUp), deleteTemporaryRefs(), temporaryRefName()
  report.ts         reportOf(), refuseAll(), messagesOf(), refOutcomes()
  in-flight.ts      InFlightPushes, inMemoryInFlightPushes() (single-process only)
  constants.ts      HTTP statuses, units, every bound of the door
  upstream.ts       executeContextFor(), callUpstream(), relayedResponse(), observed(); RelayJobs; the git pipeline's upstream stage
  sweeper.ts        startPendingRefSweeper(): deletes temporary refs past their deadline
  paths.ts          parseGitPath(), gitRemoteBase(public_url)
  wire.ts           gitText(), unauthorized(), errPacket(), lfsUnsupported(), pushReport()
  words.ts          refusalLine(), refusalText(), prefixed() ("Vaubaan: " lines), resultText()
apps/gateway/src/server/store/repositories/pending-refs.ts   PendingRefsRepo (migration 0015 git_pending_refs)
apps/gateway/src/server/budget/{budget-stage,session-service}.ts   preflight(): the limits read without counting
packages/plugin-sdk/src/git/
  pkt-line.ts      pktLine(), parsePktLines(), PktLineReader (one pkt-line at a time, rest() streams the remainder), side-band,
                   encodePkt(), printableRef()
  streams.ts       prependChunk(head, rest), streamOf(reader): the one "head, then the rest" helper
  receive-pack.ts  readCommandList() (a feature list on any line), encodeCommandList(), emptyPack(), report-status, sendRefUpdates()
  upload-pack.ts   readV2RequestHead() (exactly one command), advertisementWithout(), lsRefsWithout()
  advertisement.ts parse/encodeAdvertisement() (v0/v1)
  pack.ts          readPackObjects() (bounded, hashed, never throws), parseCommit/Tree/Tag(), applyDelta()
  remote.ts        GitRemoteCapability (pushRisk, inspectPack, admitPush, abilities, insteadOf…), GitRefUpdate, GitInspectedUpdate, GitReviewedUpdate, GIT_TEMPORARY_REF_PREFIX
plugins/github/src/
  git-remote.ts      githubGitRemote: the capability, assembled from the modules below
  git-credential.ts  upstream(), repositoryOf(), targetOf()
  git-rest.ts        GithubRest: refValue, defaultBranch, compare (with its commits), commitPaths, gitObject, gitTree, request
  git-inspect.ts     inspectPack(): what each pushed tip changes under .github/workflows/, before the pack leaves
  git-review.ts      review(): stale info, kind, net files, every commit's workflow paths; compareUrl(); branchHeads()
  git-moves.ts       executeGit(): REST create and fast-forward, receive-pack compare-and-swap for force and delete
  git-call.ts        GIT_FETCH_TOOL, GIT_PUSH_TOOL, readGitCall(), pushedRef() — shared by classify and execute
```

## Routes

| Request                                                | What the door does                                                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `GET …/info/refs?service=git-upload-pack`              | precheck of `github__git_fetch { step: 'refs' }`, then the provider's advertisement without `refs/vaubaan/*`             |
| `POST …/git-upload-pack` (v2 `command=ls-refs`)        | same precheck, the provider's answer without `refs/vaubaan/*`                                                            |
| `POST …/git-upload-pack` (v0/v1 negotiation, v2 other) | the audited, counted call `github__git_fetch { step: 'pack' }`; bytes relayed by its upstream stage                      |
| `GET …/info/refs?service=git-receive-pack`             | precheck (read), the mission's `pushRisk`, then the provider's refs minus `refs/vaubaan/*`, with the door's capabilities |
| `POST …/git-receive-pack`                              | the same two checks, then a push (`push.ts`)                                                                             |
| `…/info/lfs/*`                                         | `501`, Git LFS's JSON error: not supported (a known gap since the GitHub App left)                                       |
| `info/refs` without `service` (dumb protocol), other   | `403` / `404` text: smart HTTP only                                                                                      |
| wrong method                                           | `405` with `Allow`                                                                                                       |

`<owner>/<repo>` is cut by `parseGitPath` (`.git` optional) and named by the
plugin (`gitRemote.repositoryOf`). `registry.gitRemote()` is the one plugin
that declares a remote (the registry refuses two). A POST whose body is a
flush packet alone (`0000`, `Content-Length: 4`) is git's credential probe
(remote-curl `probe_rpc`, sent before a body larger than `http.postBuffer`):
answered `200` empty after the admission, neither decided nor audited.

## Admission

The key arrives as the HTTP Basic **password** (`bearerOf`; any user name; a
`Bearer` header is accepted as is). None → `401` with
`WWW-Authenticate: Basic realm="Vaubaan Gateway"`, so git asks its credential
helper. Then `MissionAdmission.admit(request, 'Bearer <key>')` — the MCP
door's own instance ([execution-door](execution-door.md#admission-admissionts)):

| Denial                                   | Git sees                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `cross-origin`                           | `403` text                                                                |
| `verification-throttled`, `rate-limited` | `429` with `Retry-After`; the surface window `mcp:mission:<id>` is shared |
| `unauthenticated` (reason when proven)   | `401` Basic, "This key stopped working: token-rotated."                   |
| `refused` (`wrong-credential-kind`)      | `403` text, the refusal's line and hint                                   |

Every request then carries an `AbortSignal` that fires at
`git.request_timeout` or when git hangs up.

## Fetch: a relay

The `Git-Protocol` header, `Content-Encoding`, `Content-Type`, `Accept` and
`User-Agent` are forwarded, so git and GitHub speak v2 when git asks (v0 and
v1 otherwise; tests clone with `protocol.version` 0, 1 and 2). Requests that
only list refs are **prechecked** (`CallPipeline.precheck`: mission,
resource, risk stages; a refusal is audited, a pass writes nothing) and their
answer is read whole — at most `MAX_REF_LISTING_BYTES` (16 MiB) — to leave
out the gateway's temporary refs (`advertisementWithout` for v0/v1,
`lsRefsWithout` for v2).

Under protocol v2 the head of an upload-pack POST is read up to its delim
packet (`readV2RequestHead`): exactly one `command=` line, or `ERR` and one
audit entry; `ls-refs` is a listing, any other command a transfer. The head's
bytes and the rest of the body go on unchanged (`prependChunk`). A
gzip-encoded v2 body is not read: it is counted as a transfer (fail closed).

The request that transfers objects is the call: the door attaches a
`RelayJob` to the `CallRequest` (`RelayJobs`, a `WeakMap` keyed by the call —
**single-process only**: a job lives for one request in one process; a
multi-replica host needs nothing more, the job never leaves the request) and
runs `pipeline.execute`. After the decision and the budget decrement, the git
pipeline's upstream stage resolves the read credential, calls the provider and
hands the response to git through `observed()`; the audit entry is written
when the stream ends, so its latency covers the transfer, and a broken stream
or a client that went away is an upstream error. A plain clone is one entry;
an incremental fetch negotiating in several rounds is one entry per round.

## Push

`PushSide` first: the mission's read (`refsRefusal`) and its `pushRisk`
(`github.git-push`) — a mission without it is refused, audited, before any
write credential exists. Then `Push.handle()`:

1. **Read** the command list (`readPushCommands`): at most
   `MAX_COMMAND_LIST_BYTES` (1 MiB). A compressed body, a truncated or
   malformed list, a push certificate → `ERR` pkt-line, one audit entry.
   **Fail closed** (`commandListIssue`): every capability the client asks,
   on **any** command line, must be one the door advertised
   (`ACCEPTED_PUSH_CAPABILITIES`, `agent=…`, `object-format=sha1`) —
   `atomic`, `push-options`, `report-status-v2`, anything new is refused, not
   ignored; `report-status` is required; at most `MAX_PUSH_COMMANDS` (50)
   refs; ref names at most 1024 bytes, none with a byte
   `git check-ref-format` never allows; the same ref twice; a `shallow` line
   that is not an object id.
2. **In flight**: at most `MAX_PUSHES_IN_FLIGHT_PER_MISSION` (2) pushes of a
   mission at once (`InFlightPushes`, **single-process only**; a
   multi-replica host replaces it by a shared counter with a lease).
3. **Precheck** with the updates as git sent them (fast-forward assumed, no
   files), **limits included** (`precheck(…, { limits: true })` →
   `BudgetStage.preflight` → `SessionService.preflightLimits`: the quota and
   rate windows read, nothing counted; a limit refusal is recorded as the
   decision would record it, claim request included): a push the mission, its
   permissions or its limits refuse — main without `merge-protected`, a tag
   without `tag-write`, a ref outside `refs/heads/` and `refs/tags/`,
   `refs/vaubaan/*`, `git-push` spent — is refused and audited before any
   byte leaves. **Every ref** is classified: one `github__git_push` call
   carries all of them.
4. **Inspect** (ADR
   [git-push-inspected-before-it-leaves](../decisions/git-push-inspected-before-it-leaves.md)):
   the pack is read whole into memory (`readPack`, `pack-buffer.ts`; beyond
   `git.max_pack_mb`, refused, nothing sent), its objects read by the SDK's
   `readPackObjects` (commits, trees and tags kept under the SHA-1 computed
   from their content, blobs hashed and dropped; bounded, never throws), and
   the plugin's `inspectPack` says, per update, which paths under
   `.github/workflows/` the pushed tip changes (`git-inspect.ts`, below in
   [providers/github](providers/github.md)). When one does, the precheck runs
   again with those paths: a mission without `workflow-write-via-file` is
   refused by the permission's name, audited, **before any byte leaves**. A
   plugin that throws or leaves an update out refuses the push. Nothing is
   inspected for a push of deletions only.
   Then **admit** (`gitRemote.admitPush`, optional; amendment of 2026-10-18 to
   the ADR): once the mission has decided, a plugin may say whether its
   credential can carry the push, and a sentence then refuses the push by
   name, audited, **before any byte leaves**. Asked after the precheck, so
   the mission's own refusal (`workflow-write-via-file`) comes first whatever
   the credential holds. The write endpoint is then asked for again
   (`TemporaryRefs.renewUpstream`): the pack leaves with the credential
   admitted. A plugin that throws refuses the push. The GitHub plugin
   declares none since it connects with a pasted token whose permissions
   it does not know: GitHub's own refusal, once the pack is sent, is named
   on the ref (step 8).
5. **Store** (`TemporaryRefs.store`) the pack at GitHub under temporary refs
   `refs/vaubaan/<32 random hex>` (`temporaryRefName`; no mission id: every
   reader of the repository at GitHub can list them): first the mission's
   ceiling (`MAX_TEMPORARY_REFS_PER_MISSION`, 100), then each ref recorded in
   `git_pending_refs` with the ref it stands for and the deadline
   `now + git.request_timeout + 5 min`, then the pack sent untouched (the
   command list and the buffered pack, two chunks). A store GitHub refuses (its
   report names the ref) drops the connection's cached credentials (none for
   the GitHub plugin, which caches nothing).
6. **Review** (`gitRemote.review`, `git-review.ts`): for each ref, its value
   at GitHub (`GET git/ref/<ref>`) must equal the client's `old` — a client
   that claims a later `old` is refused as _stale info_ —; a **tag** is
   reviewed through the commit it points at: an annotated tag's `new` (and
   `old`, on a move) is a tag object with no history of its own, peeled
   (`GET git/commits|tags/{sha}`, 4 deep at most, as the inspection does) to
   the commit GitHub's compare and listing can read, under the same
   `tag-write` as a lightweight tag — the tag message is no security
   boundary; a tag naming no commit (a blob, a tree) is refused "does not
   point at a commit", and the ref is still moved to the tag object; the
   **base** is
   what no branch already holds (`BaseFinder`, ADR D4 ter): the nearest
   existing branch heads in `new`'s history (the upload-pack advertisement's
   `refs/heads/*`, `GET commits?sha=<new>`, 3 pages, 3 candidates, the
   narrowest comparison kept) and **the default branch, always a candidate**
   (amendment of 2026-10-16) — for a create; for an update, `old`, or a
   nearer head or the default branch when `old..new` brings more than one
   commit; the compare API
   gives fast-forward or not (a non-fast-forward is compared both ways),
   commits, the net changed paths (renames: both names); **each commit the
   range brings** is read (`GET commits/{sha}`, `COMMITS_REVIEWED_MAX` 100 per
   push, 8 at a time) and its paths under `.github/workflows/` count as
   workflow files of the update; a commit GitHub lists 300 files of (a large
   merge) is read by its trees instead (`workflowPathsOfCommit`: no change
   when its workflows equal one parent's; unreadable: a change). Beyond 300
   files or 250 commits per comparison, 100 commits per push, an unrelated
   history, an empty repository: refused. The review does not read the
   credential's permissions (amendment of 2026-10-18): the decision comes
   first.
7. **Decide**: one `github__git_push { repository, updates[] }`, the reviewed
   updates as arguments, each with the inspection's workflow paths added
   (`withInspection`: the union, so neither can make a push look smaller): one
   decision, one request when gated, one audit entry; every ref refused when
   one is.
8. **Move**, allowed (`executeGit`, `git-moves.ts`), per ref, in order,
   reported per ref like git without `--atomic`: create `POST git/refs`;
   fast-forward `PATCH git/refs/<ref> force:false` (GitHub refuses a
   non-fast-forward); force (an accepted `force-push`) and delete: one
   receive-pack command `<old> <new|0> <ref>` with an empty pack — a
   compare-and-swap GitHub checks under the ref's lock. A provider failure on
   one ref reports that ref (`GitHub did not apply this update`) and the next
   ones are tried; a failure before any ref fails the call. A move GitHub
   refuses for a permission the token lacks is named on the ref: the token
   needs Contents, and Workflows for a change under `.github/workflows/`
   (`refusedForPermissionSentence`, `git-moves.ts`).
9. **Clean up** (`TemporaryRefs.cleanUp`) on every path — success, refusal,
   provider failure, a client gone mid-pack: `deleteTemporaryRefs`
   (receive-pack, compare-and-swap on the object id, per ref; a ref GitHub
   refused is re-read in the advertisement and counts as gone only when it is
   no longer listed) with a deadline of its own (60 s), never the request's
   signal; only the rows of refs confirmed gone go. Refused
   `approval-required` (`keepForApproval`): the refs stay, their deadline
   becomes the request's expiry, and an earlier push of the mission waiting
   for the same ref is superseded (its refs deleted). An allowed replay of
   the same commits removes what the earlier push left.

The sweeper (`startPendingRefSweeper`, every 5 min, timer `unref`'d) deletes
at the provider every row past its deadline, grouped by connection and
repository, in batches of 100 until nothing is left (at most 20 batches a
run). A group GitHub kept is postponed by one interval — to the back of the
queue, so it never blocks the rows behind it; a row older than 48 h is given
up and logged; a connection that is gone drops its rows. Several replicas may
sweep: a second delete of a deleted ref is reported gone.

### What the door advertises

`report-status`, `delete-refs`, `side-band-64k`, `quiet`, `no-thin` (git then
sends a self-contained pack, every object of which the inspection can read;
a thin pack anyway is read, and what it cannot resolve counts as a workflow
change), then `ofs-delta` and `object-format=sha1` when GitHub advertises
them, `agent=vaubaan-gateway`.
Never `atomic`, `push-options`, `push-cert`, `report-status-v2`: git itself
then refuses `--atomic`, `-o` and `--signed` with its own sentence, and a
client that asks anyway is refused. A repository in another object format is
refused at the advertisement. A signed commit is an ordinary object: it
crosses byte for byte, signature intact (tested with an SSH signature).

## What git shows

- a refused push: `! [remote rejected] <ref> (<line>)` on **each** ref
  (`ng` lines), the instruction on `remote: Vaubaan: …` lines (side-band
  channel 2): "Hand this URL to your human: …", "push the same commits again
  within N s";
- an unreadable push, a refused transfer: `fatal: remote error: <line>`
  (`ERR` pkt-line);
- a refused refs listing: `403` text, printed under `remote:`;
- a key that stopped: `401` with the reason.

Lines come from `words.ts` (`refusalLine`, keyed by refusal code so a new code
fails to compile).

## Configuration

| Key                   | Default | Where                                                                                                                             |
| --------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `git.max_pack_mb`     | `200`   | `git/pack-buffer.ts` (`readPack`): the pack is read whole into memory up to this; a larger push is refused, audited, nothing sent |
| `git.request_timeout` | `10m`   | `git/door.ts`: the request's `AbortSignal`                                                                                        |

Railway (checked 2026-10-14, docs.railway.com "Specs and limits"): a request
body must finish uploading within 5 minutes; a request may last 15 minutes
while data flows; no body size limit is stated. 200 MB in 5 minutes is about
5.5 Mbit/s. The surface rate limit is `mcp.rate_limit_per_minute`, shared with
`/mcp`.

## Where people see it

- **Setup kit** step 4 (`bootstrap-kit.ts`, also in the management door's
  kit): `credential.<instance origin>.helper` set to an inline helper that
  prints `password=$VAUBAAN_MISSION_TOKEN` (never `store` or `cache`, never
  the key in a URL), the recommended `url.<instance>/git/.insteadOf
<gitRemote.insteadOf>`, one `git clone` per repository; a "Git" section in
  the agent's instructions.
- **Mission page**: a "Git" block (`missions/git-view.ts`): the remotes, and
  the plugin's `abilities` sorted into can / asks first / cannot from the
  policy; a warning when a raw-token tool (`tokenHandouts`) is held.
- **Catalog**: `git_remote` per resource ([execution-door](execution-door.md)).
- **Request page**: `call.provider_pages` (`requests/provider-pages.ts`), the
  plugin's `compareUrl` of each pushed ref while the request is open.
- **Reference page** of the provider: a "Git" section; `/agent-bootstrap.md`
  §8.

## Tests

- `packages/plugin-sdk/tests/unit/git-wire.test.ts` — framing, the command
  list (every command, zero ids, malformed lines), chunking invariance,
  truncation, oversize lengths, a seeded fuzz of 4000 mutated lists, report
  and advertisement round trips.
- `apps/gateway/tests/integration/git/` — the real `git` client against the
  real composition root, GitHub played by `FakeGithubHost` (`git
http-backend` over bare repositories, a REST API for tokens, refs and
  compare): clone v0/v1/v2, fetch, push, main refused, `refs/vaubaan/`,
  force-push approval and replay, workflow approval, tags and deletions,
  compare limits, the pack cap, budget and claim URL, keys rotated, revoked,
  expired missions, the token's permissions, the sweeper,
  the catalog, the shared admission (`git-remote*.test.ts`); multi-ref pushes,
  lying old ids, ref-name tricks, unsupported capabilities, truncated streams,
  a client gone mid-pack (`git-remote-security.test.ts`); one regression test
  per finding of the adversarial review — limits refused before the upload,
  temporary refs kept until GitHub confirms them gone, superseded and capped,
  capabilities on any line, `report-status` required, listings without
  temporary refs, no push advertisement without `pushRisk`, an intermediate
  workflow commit, a v2 head with two commands — and an SSH-signed commit
  crossing byte for byte (`git-remote-review.test.ts`).
- `packages/plugin-sdk/tests/unit/git-wire.test.ts` also: a feature list on
  any line, `prependChunk`, the v2 head (with a property test over 3000
  generated heads), the listing filters.
- `apps/gateway/tests/integration/git/git-remote-workflows.test.ts` — the
  defect of 2026-10-16 and its fix: a mission without
  `workflow-write-via-file` modifying, adding, deleting or reverting a
  workflow, a garbled pack, GitHub's git database down — refused by the
  permission's name with no receive-pack at GitHub; a change outside the
  directory and a mission holding the permission pass.
- `packages/plugin-sdk/tests/unit/git-pack.test.ts` — the pack reader over
  packs of the real `git pack-objects`: offset and ref deltas, a thin pack,
  garbled, truncated and foreign bytes, every limit, a zip bomb; tree, commit
  and tag bodies; `applyDelta` bounds.
- `plugins/github/tests/unit/git-inspect.test.ts` — `inspectPack` against a
  real bare repository behind a fake git database (below in
  [providers/github](providers/github.md)).
- `apps/gateway/tests/unit/server/git/command-list.test.ts` — a property test
  of `readPushCommands` over 3000 generated command lists and 2000 mutated
  byte strings; the in-flight bound.
- `plugins/github/tests/unit/git-moves.test.ts` — the compare-and-swap of a
  force-push and a delete, per-ref provider failures, the per-commit review,
  against `mockFetch`.
- `apps/gateway/tests/e2e/v5/git-remote.spec.ts` — the built server, the
  mission page's Git block, clone → push → refused push → force-push asking
  first → approval in the browser → replay; writes
  `test-results/v5/git-session.txt`.

## How to debug

- `git` with `GIT_TRACE_CURL=1 GIT_TRACE_PACKET=1` shows what the door
  answered; the key appears there as a Basic header — never paste such a
  trace.
- The instance logs `git push` / `git fetch` (mission, token prefix, outcome,
  refusal code, arguments hash — never the arguments), `temporary refs of a
push not deleted`, `temporary refs not deleted at the provider`.
- Leftover `refs/vaubaan/*` at GitHub: `git_pending_refs` holds their rows
  and deadlines; `root.git.sweeper.runOnce()` sweeps now.
