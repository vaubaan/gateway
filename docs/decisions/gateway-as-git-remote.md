---
title: The gateway is the agent's git remote — fetch relayed, a push decided from its own objects before any byte leaves, the provider credential never handed out
status: accepted
date: 2026-10-13
---

# The gateway is the agent's git remote — fetch relayed, a push decided from its own objects before any byte leaves, the provider credential never handed out

## Context

A mission token must be all an agent needs to clone, commit and push within its permissions. The
API tools are enforced but give no working tree; a raw minted token is enforced by nothing for its
lifetime and lands in `.git/config`. A push that was stored at GitHub first and reviewed after
reached the provider before the mission was asked (a workflow change slipped past a mission
without `workflow-write-via-file`).

## Decision

The instance speaks git smart HTTP at `/git/<owner>/<repo>.git` with the mission key as the Basic
password, admitted by the execution door's own code. A push is read whole, its objects
authenticated by their hash, and the CI workflows of each pushed tip compared with the current
ones before anything is sent; it is then one call `github__git_push`: one decision, one approval,
one audit entry, every ref refused when one is. The provider credential is used by the instance
only.

## Consequences

- `github__git_fetch` and `github__git_push` are classified, counted and audited like any tool but
  are not MCP tools: a tool on the wrong door (`CallRequest.channel`) is an audited rejection.
- Every command of a push is decided; anything unreadable or past a bound counts as a workflow
  change or a refusal, never fewer refusals. A push is buffered in memory (2 per mission at most).
- False positives are accepted by design (a branch from a commit whose workflows differ from every
  head it builds on). Protocol, bounds, capabilities: handbook [git-remote](../handbook/git-remote.md).
- The wire code (pkt-lines, command lists, advertisement) is ours, in `packages/plugin-sdk/src/git/`.

## Rejected alternatives

### Store the pack at GitHub first, decide after the review

The defect itself: the change reaches the provider before the mission decides.

### A persistent mirror, or a clone per push

A stateful instance holding every repository, or a disk and a clone per push (the way out if
GitHub's compare limits bite).

### FINOS GitProxy, or GitHub rulesets alone

A second application duplicating missions and audit (which checked only the first ref of a
multi-ref push); rulesets know nothing of budgets or approvals.

### A credential helper trading the key for minted tokens

The token still leaves and nothing is enforced at push time.

### Force and delete through REST after a re-read

The API has no compare-and-swap; receive-pack checks `old` under the ref's lock.
