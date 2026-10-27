---
title: A mission is edited after issuance by its creator, judged by issuance's own check on what moves, on the same token, session and counters
status: accepted
date: 2026-10-24
---

# A mission is edited after issuance by its creator

## Context

A missing permission or a resource created after issuance meant a new mission: a new key for every
holder, a new session and counters at zero. Edits must not become a second validation that drifts
from issuance, nor a way to reset what was already spent.

## Decision

The creator, and only the creator, edits everything a mission draft holds except its period, at
once and on the same tokens, session and counters. The edited draft goes through issuance's preview
under the creator's current authority, and `judgeEdit` keeps only the issues about what the edit
moves.

## Consequences

- `MissionDraft` is the one shape for creation, preview, duplication and edit; `judgeEdit` is the
  one place saying which creation issues bind an edit.
- "Edit mission" is the one hand edit of a live mission, permissions included: no separate
  permissions page; `changePermissions` only answers an agent's permission request.
- Used stays used: a lowered quota under the counters exhausts the permission; a permission removed
  and re-added in the same period finds its counter.
- An edit carries the `revision` it started from and applies in one transaction; open claims and
  approvals on removed permissions are closed with it.
- No agent credential edits a mission: neither the execution door nor the management door is
  handed the method.

## Rejected alternatives

### Reissue the mission

Forces a key replacement on every holder for a forgotten permission or resource.

### Re-run the whole preview and refuse on any issue

Refuses a lowered limit because a resource went stale or an account needs reconnecting.

### Allow the period to change

The period keys the counters and gate openings: a silent reset or a broken counters/audit
invariant.

### Let a connected app edit the missions it issued

An enlargement of a live mission that nobody sees issued; an agent would authorize its own
escalation.
