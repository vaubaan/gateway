---
title: A mission's limits are changed after issuance by its creator, judged by issuance's own check, read by the budget inside its decision
status: superseded
date: 2026-10-14
superseded-by: mission-editable-after-issuance
superseded-date: 2026-10-24
---

# A mission's limits are changed after issuance by its creator, judged by issuance's own check, read by the budget inside its decision

> **Superseded on 2026-10-24** by
> [mission-editable-after-issuance](mission-editable-after-issuance.md): the owner
> decided that a mission is edited after issuance without limit by its creator
> (name, expiry, accounts, resources, permissions, limits, gates — not the period).
> What this record settled still holds inside the wider edit: issuance's own check
> judges what moves and only what moves, the change applies at once in the current
> period, the budget reads the limits inside its decision. Point 1 ("nothing else
> moves") no longer holds; `setLimits` remains as a narrower entry point.

> Product owner's decision of 2026-10-14 (item 1 of
> [owner-decisions-second-round](owner-decisions-second-round.md)), from the
> independent review of the redesign ("Editing limits after creation"). Spec:
> [vaubaan-gateway](../spec/vaubaan-gateway.md) §3.2, §4.2, §7 (patch handed to the
> planning step). Handbooks: [missions](../handbook/missions.md),
> [budget-and-sessions](../handbook/budget-and-sessions.md),
> [web-app](../handbook/web-app.md). Builds on
> [atomic-budget-accounting](atomic-budget-accounting.md).

## Context

Until now a mission's quota and rate were fixed at issuance: a claim gives back
calls for one period, and "a larger quota is a change of the mission" meant
creating another one. The limit-reached page sent the creator to "duplicate the
mission", which gives the agent a new key, a new session and counters at zero —
heavy for "this read limit of 200 a day should be 500". The redesign's mockup
had an "Edit permissions" button; the reviewer asked the owner to decide.

Three things had to be settled: what may move, what caps a change, and how a
change and a call arriving at the same moment are ordered.

## Decision

1. **What moves.** Per permission already in the mission, its quota per period
   and the number of calls of its rate window, up or down. Nothing else: no
   permission added or removed (that stays "create / duplicate"), not the period,
   not the rate window, not the gate (which has its own edit, `setGate`), not the
   resources. The API (`POST /api/missions/:id/limits`) refuses a body that names
   a window, a gate or a period.
2. **Who.** The creator only, like every mutation of a mission. A teammate, an
   administrator as such and an owner of an account are answered "not found". The
   management door is not handed the method (`ManagementMissions` is a `Pick`
   without it; `hard-deny.test.ts` asserts so): a connected app never changes a
   live mission's authority, which spec §4.1 bis already forbids ("extending a
   budget").
3. **What caps a change: issuance's own check, not a second one.** The lines that
   move are judged by `checkPolicyLines` (`missions/preview.ts`), which runs the
   very `classifyLines` and `issuesOf` a draft's explicit lines go through: in the
   catalog, inside the creator's authority on the connection now, resolvable on the
   mission's resources, a budget `budgetProblem` accepts (whole numbers of at least
   one, the catalog's rate ceiling). A refusal carries the same issue, word for
   word, as a creation asking for the same value. A line whose values do not move
   is not judged again. A revoked or orphaned mission is not changed (as its
   gates); an expired one is, since its expiry may be extended.
4. **When it applies.** At once, in the current period. What was used stays used;
   a quota lowered under it leaves the permission exhausted until the reset (or a
   claim). Nothing is credited or reset by a change.
5. **The race.** The budget no longer decides with the limits of the mission its
   caller loaded: `SessionsRepo.decideAndDecrement` reads the policy rows of the
   touched risks inside its `BEGIN IMMEDIATE` transaction
   (`DecideContext.limits`), and `SessionService` decides with them
   (`livePolicy`). `MissionsRepo.setLimits` writes in a transaction of its own.
   SQLite has one writer, so a decision sees either the old limits or the new
   ones; no call decided after the change commits passes above the new limit,
   however old the mission object it carries. A Postgres port reads those rows
   `FOR SHARE`. Only the limits are read live; the accepted risks and the gates
   remain the caller's (unchanged by this edit).
6. **Trace.** One `limits-changed` administrative entry per change, its `before`
   and `after` listing each risk that moved with its quota and rate limit; one
   `limits-changed` session event per risk that moved (when the session exists),
   so the mission's activity shows it. Values equal to the stored ones write
   nothing.
7. **Interface.** "Change limits" on the mission page (the permissions section,
   and the "···" menu) opens the same permission table in edit mode for the
   limits only (`?edit=limits`), then a confirmation that lists each change,
   before and after, and says when a new limit is already used up. The
   limit-reached page says "change the limit" and links there.

## Consequences

- A creator raises or lowers a limit without giving the agent a new key; the
  session, the counters and the activity of the mission carry on.
- "A larger quota is a change of the mission" (spec §3.4) now has a place to
  happen that is not a new mission; the spec patch says so.
- One read more per decision (the policy rows of the touched risks, by primary
  key, inside the transaction that already reads the counters).
- The authority is checked before the write, outside its transaction — the same
  window an issuance has. If the authority disappears in between, the mission
  reads `orphaned` and serves nothing; the change is stored and applies if the
  authority comes back.

## Rejected alternatives

- **Re-run the whole `previewDraft` on a draft rebuilt from the mission.** It
  would refuse a lowered limit because a resource went stale or a connection
  needs reconnecting — facts unrelated to the limit. The line check is the part of
  issuance that caps a value.
- **A second validation written for edits.** Two rules would drift; the owner
  asked for one.
- **Let the change wait for the next period.** The person changing a limit means
  now; and a lowered limit that waits a day is not a limit.
- **Reset or credit the counters with the change.** Mixing a change of the
  mission with a claim's answer; claims stay the way to give calls back.
- **Optimistic check in the service ("only if the limit is still N").** The
  decision reading the stored row is simpler and closes the race for every
  caller, the execution door included.
- **Let a connected app change limits of the missions it issued.** It may issue
  a wider mission, visibly; changing a live one in place would be an enlargement
  nobody sees issued.
