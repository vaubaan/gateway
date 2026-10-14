---
title: Git remote — /git/<owner>/<repo>.git, the second door of the execution surface
status: current
date: 2026-10-14
last_synced: 2026-10-14
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
  - plugins/github/src/git-call.ts
  - plugins/github/src/permission-check.ts
  - apps/gateway/tests/integration/git/
  - apps/gateway/tests/e2e/v5/git-remote.spec.ts
  - packages/plugin-sdk/tests/unit/git-wire.test.ts
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
held; the provider's credential is minted or decrypted in memory for the
request, never returned; the mission key is never logged and never sent
upstream.

## Layout

```
apps/gateway/src/app/git/[...path]/route.ts   GET | POST | PUT | DELETE /git/** → root.git.handle (nodejs runtime)
apps/gateway/src/proxy.ts                     `config.matcher` excludes /git/: the Next proxy would buffer and cut the pack
apps/gateway/src/server/git/                  host-agnostic, never imports `next`
  index.ts       createGitModule(deps) → root.git { door, pipeline, sweeper, handle }
  door.ts        GitDoor.handle(): path, Basic key, admission, fetch relay, push advertisement, probe; bearerOf()
  push.ts        Push: one receive-pack request, steps 1–7 below; commandListIssue(), deleteTemporaryRefs()
  upstream.ts    executeContextFor(), callUpstream(), relayedResponse(), observed(); RelayJobs; the git pipeline's upstream stage
  sweeper.ts     startPendingRefSweeper(): deletes temporary refs past their deadline
  paths.ts       parseGitPath(), gitRemoteBase(public_url)
  wire.ts        gitText(), unauthorized(), errPacket(), lfsUnsupported(), pushReport()
  words.ts       refusalLine(), refusalText(), prefixed() ("Vaubaan: " lines), resultText()
apps/gateway/src/server/store/repositories/pending-refs.ts   PendingRefsRepo (migration 0015 git_pending_refs)
packages/plugin-sdk/src/git/
  pkt-line.ts      pktLine(), parsePktLines(), PktLineReader (one pkt-line at a time, rest() streams the remainder), side-band
  receive-pack.ts  readCommandList(), encodeCommandList(), emptyPack(), parse/encodeReportStatus, sendRefUpdates()
  advertisement.ts parse/encodeAdvertisement() (v0/v1)
  remote.ts        GitRemoteCapability, GitRefUpdate, GitReviewedUpdate, GIT_TEMPORARY_REF_PREFIX = 'refs/vaubaan/'
plugins/github/src/
  git-remote.ts    githubGitRemote: repositoryOf, upstream (gitGrant), review, compareUrl, insteadOf, abilities; executeGit()
  git-call.ts      GIT_FETCH_TOOL, GIT_PUSH_TOOL, readGitCall(), pushedRef() — shared by classify and execute
  permission-check.ts  gitFetchNeeds(), gitPushNeeds(), missingPermissionSentence()
```

## Routes

| Request                                               | What the door does                                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `GET …/info/refs?service=git-upload-pack`             | precheck of `github__git_fetch { step: 'refs' }`, then relay the provider's advertisement           |
| `POST …/git-upload-pack` (v2 `command=ls-refs`)       | same precheck, relay                                                                                |
| `POST …/git-upload-pack` (v0 negotiation, v2 `fetch`) | the audited, counted call `github__git_fetch { step: 'pack' }`; bytes relayed by its upstream stage |
| `GET …/info/refs?service=git-receive-pack`            | precheck (read), then the provider's refs minus `refs/vaubaan/*`, with the door's capabilities      |
| `POST …/git-receive-pack`                             | a push (`push.ts`)                                                                                  |
| `…/info/lfs/*`                                        | `501`, Git LFS's JSON error: not supported (use `github__mint_install_token`)                       |
| `info/refs` without `service` (dumb protocol), other  | `403` / `404` text: smart HTTP only                                                                 |
| wrong method                                          | `405` with `Allow`                                                                                  |

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

Nothing of a fetch is parsed but, under protocol v2, the first pkt-line of an
upload-pack POST (`peekFirstLine`) to tell `ls-refs` from `fetch`; the
`Git-Protocol` header, `Content-Encoding`, `Content-Type`, `Accept` and
`User-Agent` are forwarded, so git and GitHub speak v2 when git asks (v0 and v1
otherwise; tests clone with `protocol.version` 0, 1 and 2). Requests that only
list refs are **prechecked** (`CallPipeline.precheck`: mission, resource, risk
stages; a refusal is audited, a pass writes nothing). The request that
transfers objects is the call: the door attaches a `RelayJob` to the
`CallRequest` (`RelayJobs`, a `WeakMap` keyed by the call — **single-process
only**: a job lives for one request in one process; a multi-replica host needs
nothing more, the job never leaves the request) and runs
`pipeline.execute`. After the decision and the budget decrement, the git
pipeline's upstream stage mints the read credential, calls the provider and
hands the response to git through `observed()`; the audit entry is written
when the stream ends, so its latency covers the transfer, and a broken stream
or a client that went away is an upstream error. A plain clone is one entry;
an incremental fetch negotiating in several rounds is one entry per round.

## Push

`Push.handle()`:

1. **Read** the command list off the stream (`PktLineReader`,
   `readCommandList`): at most `MAX_COMMAND_LIST_BYTES` (1 MiB). A
   compressed body, a truncated or malformed list, a push certificate →
   `ERR` pkt-line, one audit entry (`reject`).
2. **Fail closed** (`commandListIssue`): every capability the client asks
   must be one the door advertised (`report-status`, `side-band-64k`,
   `quiet`, `ofs-delta`, `delete-refs`, `agent=…`, `object-format=sha1`) —
   `atomic`, `push-options`, `report-status-v2`, anything new is refused, not
   ignored; at most `MAX_PUSH_COMMANDS` (50) refs; ref names at most 1024
   bytes, none with a byte `git check-ref-format` never allows; the same ref
   twice; a `shallow` line that is not an object id.
3. **Precheck** with the updates as git sent them (fast-forward assumed, no
   files): a push the mission can never make — main without
   `merge-protected`, a tag without `tag-write`, a ref outside
   `refs/heads/` and `refs/tags/`, `refs/vaubaan/*` — is refused and audited
   before any byte leaves. **Every ref** is classified: one `github__git_push`
   call carries all of them.
4. **Store** the pack at GitHub under temporary refs
   `refs/vaubaan/<mission>/<nonce>/<n>`: each is recorded in
   `git_pending_refs` **before** the upload, with the deadline
   `now + git.request_timeout + 5 min`; the pack is streamed untouched through
   `capped()`, which errors once `git.max_pack_mb` is passed.
5. **Review** (`gitRemote.review`): for each ref, its value at GitHub is read
   (`GET git/ref/<ref>`) and must equal the client's `old` — a client that
   claims a later `old` to keep commits out of the review is refused as
   _stale info_ —; the compare API gives fast-forward or not (a
   non-fast-forward is compared both ways), commits, changed paths (renames:
   both names), workflow files (anything under `.github/workflows/`). Beyond
   300 files or 250 commits, an unrelated history, an empty repository: the
   push cannot be reviewed and is refused. Then the App's permissions: the
   push token must hold `contents: write`, and `workflows: write` when a
   workflow file changes, or the push is refused by the permission's name.
6. **Decide**: one `github__git_push { repository, updates[] }`, the reviewed
   updates as arguments: one decision, one request when gated, one audit
   entry; every ref refused when one is.
7. **Move**, allowed (`executeGit`), per ref, in order, reported per ref like
   git without `--atomic`: create `POST git/refs`; fast-forward
   `PATCH git/refs/<ref> force:false` (GitHub refuses a non-fast-forward);
   force (only an accepted `force-push`) and delete: the ref is read again and
   must still be the reviewed `old`, then `PATCH force:true` / `DELETE`.
8. **Clean up** on every path — success, refusal, provider failure, a client
   gone mid-pack: `deleteTemporaryRefs` (receive-pack, compare-and-swap on the
   object id) with a deadline of its own (60 s), never the request's signal;
   the rows go once deleted. Refused `approval-required`: the refs stay, their
   deadline becomes the request's expiry (`PendingRefsRepo.extend`), so the
   person reads the comparison at GitHub; an allowed replay of the same
   commits removes what the earlier push left.

The sweeper (`startPendingRefSweeper`, every 5 min, 100 rows a pass, timer
`unref`'d) deletes at the provider every row past its deadline, grouped by
connection and repository; a connection that is gone drops its rows; a
provider that does not answer keeps them, for at most 24 h after the deadline.
Several replicas may sweep: a second delete of a deleted ref changes nothing.

### What the door advertises

`report-status`, `delete-refs`, `side-band-64k`, `quiet`, then `ofs-delta` and
`object-format=sha1` when GitHub advertises them, `agent=vaubaan-gateway`.
Never `atomic`, `push-options`, `push-cert`, `report-status-v2`: git itself
then refuses `--atomic`, `-o` and `--signed` with its own sentence. A
repository in another object format is refused at the advertisement.

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

| Key                   | Default | Where                                                            |
| --------------------- | ------- | ---------------------------------------------------------------- |
| `git.max_pack_mb`     | `200`   | `git/push.ts` (`capped`): a larger push is cut, refused, audited |
| `git.request_timeout` | `10m`   | `git/door.ts`: the request's `AbortSignal`                       |

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
  expired missions, a token connection, the App's permissions, the sweeper,
  the catalog, the shared admission (`git-remote*.test.ts`); multi-ref pushes,
  lying old ids, ref-name tricks, unsupported capabilities, truncated streams,
  a client gone mid-pack (`git-remote-security.test.ts`).
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
