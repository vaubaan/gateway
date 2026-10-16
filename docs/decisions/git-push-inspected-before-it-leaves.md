---
title: A git push is inspected before it leaves — CI workflow changes decided from the push's own objects
status: accepted
date: 2026-10-16
extends:
  - gateway-as-git-remote
  - decision-stages-fail-closed-and-audited
---

# A git push is inspected before it leaves — CI workflow changes decided from the push's own objects

> Security fix of 2026-10-16. Handbooks: [git-remote](../handbook/git-remote.md),
> [providers/github](../handbook/providers/github.md),
> [threat-model](../handbook/threat-model.md). Spec:
> [vaubaan-gateway §4.1 ter "Git remote"](../spec/vaubaan-gateway.md) (unchanged: the
> spec already requires a workflow change to be decided as `workflow-write-via-file`).

## Context

Observed live on the dogfood instance, 2026-10-16: a mission holding
`github.git-push` and `github.feature-branch-write` but **not**
`github.workflow-write-via-file` pushed, through the git remote, a commit that
changed `.github/workflows/ci.yml` and `release.yml` on a feature branch. The
gateway sent it to GitHub; only GitHub refused it ("refusing to allow a GitHub
App to create or update workflow … without `workflows` permission").

Root cause — the order of the push (ADR gateway-as-git-remote D4):

1. the **precheck** saw the updates as git sent them — a feature branch, no
   files — so it had nothing to refuse;
2. the pack was then **stored at GitHub** under a temporary ref, so that
   GitHub could say what it brings;
3. only then did the **review** (GitHub's compare API) find the workflow files
   and the decision ask for `workflow-write-via-file`.

Step 2 sent the agent's workflow change to the provider before the mission was
asked whether it may make one. With an App holding `workflows: write`, the
objects reach the repository (under `refs/vaubaan/*`, then dangling after the
refusal) — the gateway relied on the review after the fact, and on GitHub's own
permission check, not on its own decision. The REST/MCP path
(`create_or_update_file`, `push_files`) never had this gap: the arguments name
the paths, so the classifier decides before any call.

Two more weaknesses of a review that reads the provider's comparison only: it
reasons in commits ("what the push brings"), not in what the pushed tip will
run; and its bases are chosen among commits whose order rests on dates an agent
can forge. Both are bounded by the per-commit review, but neither is the
property that matters: **the workflows GitHub will run from the pushed tip,
against those that run there now**.

## Decision

**D1 — The pack is read whole, inspected, and decided on before any byte
leaves.** The door reads the pack into memory (at most `git.max_pack_mb`;
beyond, refused as before, nothing sent), reads its objects
(`readPackObjects`, plugin SDK), asks the plugin what each update changes in
the CI workflows (`GitRemoteCapability.inspectPack`), and — when a change is
found — runs the precheck again with those paths in the updates. A mission
without `github.workflow-write-via-file` is refused there with the usual typed
refusal (`risk-not-accepted`), audited, and **nothing** reaches GitHub — not
even the temporary ref. The rest of the push is unchanged: store, review,
decision, move. The decision covers the union of what the inspection and the
review found (`withInspection`), so neither can make a push look smaller.

**D2 — Objects are authenticated by their hash.** The SDK's pack reader keeps
commits, trees and tags under the SHA-1 it computes from their content; blobs
are hashed and dropped. A garbled, truncated, forged or thin pack can only make
objects **missing**, never wrong. A missing object is read from GitHub's git
database (`GET git/commits|trees|tags/{sha}`), which answers for an existing
object; one GitHub does not hold either is unknown.

**D3 — What is compared: the guarded state of the tip.** For a commit: every
root entry named `.github` (any case, as the REST path matches), and in it
every entry named `workflows` (any case), each as name, mode and object id.
Same state, same workflows run. Modify, add, delete, rename into or out of the
directory, mode change, symlink in place of the directory: each changes an id.
A subtree the pack does not carry exists at GitHub — possibly an **old** tree
(a revert): its id is compared like any other, so the revert is seen.

**D4 — Against what: the ref's current tip, or a current branch head the push
builds on.** For an update, the client's `old` (the review still refuses a
stale claim before anything moves); for a create, the default branch's head
(an empty repository: no workflows). The tip also passes when its state equals
that of a **current branch head** among the commits the push builds on directly
(parents of its own commits that the pack does not carry, at most 5): what a
branch already runs is not a change — the rule of ADR gateway-as-git-remote
D4 ter (a merge of a moved branch is not asked again). Only current heads
(GitHub's upload-pack advertisement, `refs/heads/*`): an older commit, an
object left by a refused push, or one of a fork network is never a base.

**D5 — Only the tip of each update.** GitHub runs the workflows of the pushed
tip, never those of an intermediate commit; every ref of the push is inspected.
The provider review keeps counting intermediate commits (a workflow added then
removed inside one push), as before.

**D6 — Fail closed.** A state that cannot be read — an object neither in the
pack nor at GitHub, a GitHub error, a truncated tree, a tag chain deeper than
4, a pack over the reader's limits — counts as a change of
`.github/workflows/`. A plugin that throws, or leaves an update out, refuses
the push. Never a plain push.

**D7 — Thin packs are not asked for.** The door advertises `no-thin`: git then
sends a self-contained pack (no delta against an object it leaves out), so
every object the push carries is readable. A thin pack anyway is read; what
it cannot resolve is unknown (D6).

**D8 — Bounds.** The pack: `git.max_pack_mb` (200 MB default) per push, at
most 2 pushes of a mission in flight. The reader: 128 MiB per object (GitHub
refuses files over 100 MB), 2 GiB inflated per pack, 64 MiB of commits, trees,
tags and pending deltas kept, 10⁶ objects; an object that inflates beyond its
declared size stops the read (no zip bomb). It yields to the event loop every
8 MiB inflated. The walk for bases: 10 000 commits, 5 heads. Any bound reached
leaves objects unknown or bases out — more refusals, never fewer.

## Consequences

- The defect is closed on the git path: the decision on CI is the same as on
  the REST path, and it is made before anything is sent.
- A push is buffered in memory before it is sent (up to `git.max_pack_mb` per
  push, 2 per mission); it reaches GitHub after the inspection rather than
  while git uploads. A push without workflow change costs about three more
  GitHub reads (the `.github` tree, the old commit and its root tree); one
  that changes them, or a create, a few more (the default branch, the heads).
- **False positives, by design** (each asks for `workflow-write-via-file` or
  is refused): a branch created from a commit whose workflows differ from the
  default branch and from every head it builds on directly (e.g. built on an
  older commit of a branch that moved since — fetch and rebase); a tag on an
  older commit whose workflows differ from today's default branch; a push
  while GitHub's git database is unavailable.
- Accepted: content already on a current branch head is not a change when it
  reaches another ref — the same rule the review applied since D4 ter; the
  owner gates merges into protected branches with `merge-protected`.
- The SDK gains a generic, hashed pack reader and an optional capability; a
  plugin without `inspectPack` behaves as before.

## Rejected alternatives

- **Keep storing first, decide after the review** — the defect itself: the
  provider receives the change before the mission is asked.
- **Refuse every push that carries a `.github/workflows` object** — misses a
  revert to an old tree (not in the pack) and refuses a merge of a moved
  branch whose workflows changed upstream.
- **Compare only against the default branch for a create, and only against
  `old` for an update** — sound, but refuses the merge of a moved branch and
  every branch built on a non-default branch (the dogfood works on such
  branches); D4's current heads cover them without opening the revert.
- **Accept any commit GitHub holds as a base** — GitHub's git database
  answers for dangling objects and for the fork network: an object a refused
  push left there, or a fork's commit, would become a base.
- **Resolve thin-pack deltas through the API** — GitHub returns parsed trees,
  not the raw bytes a delta applies to; `no-thin` makes it unnecessary.
- **Inspect intermediate commits too** — GitHub runs the tip; the provider
  review already reads every commit of the range.
- **Fetch the pushed objects back from GitHub** — needs them stored first.
