---
title: Who is on a mission — one rule, checked again inside the token insert; gates of an expired mission stay editable
status: accepted
date: 2026-10-13
extends:
  - mission-members-and-per-holder-tokens
---

# Who is on a mission — one rule, checked again inside the token insert; gates of an expired mission stay editable

> Decided in the final cycle-end pass, after reading the token path of the
> mission-members feature line by line. Handbooks:
> [missions](../handbook/missions.md), [store](../handbook/store.md),
> [authentication](../handbook/authentication.md).

## Context

The mission-members feature gave each holder a token of their own. Reading its
token path found four things.

**The membership rule was written three times.** `MissionService.access`,
`standingOf` and `list` each decided "is this user the creator or a member" with
their own query and their own conditions. They agreed on the day of the read.

**A token could be issued to somebody who had just been removed.** Generating a
member's token checked the membership, then inserted the token, in two steps. A
removal landing between them left a fresh active token for a person no longer
on the mission. The same window existed between a revocation of the mission and
a rotation.

**A member added again kept a stale token row.** Removing a member revokes their
token; adding them again did not look at the rows already there.

**A reactivated user could come back to leftovers.** Deactivating a user closes
their sessions, delegations and group memberships in several steps. If one step
failed, a later reactivation restored the status over whatever was still open.

A fifth point was a mistake of this pass, corrected in it: gates were first made
read-only on an expired mission, on the argument that an expired mission never
serves again. It can — a granted claim with `extend-expiry` revives it.

## Decision

### D1. One function says who is on a mission

`store/membership.ts` exports `membershipOf(mission, userId, members)`,
`isOnMission` and the `MEMBERSHIPS` list. `MissionService.access`, `standingOf`
and `list` call it, and so does the repository.

### D2. The token insert checks the mission and the holder itself

`MissionsRepo.issueToken` runs in one transaction: it reads the mission's state
and the holder's membership, and inserts only if the mission is active and the
holder is on it. Otherwise it throws `TokenNotIssuableError` with one of
`mission-not-active`, `holder-not-a-member`, `name-taken`. The team service maps
each to the HTTP answer it already gave for the check done earlier.

The earlier check in the service stays: it produces the precise message. The
check in the insert is the one that cannot be raced.

### D3. Adding a member revokes a token they still hold

`addMember` returns `{ member, tokenRevoked }` and revokes an active token of
that user on that mission, if one exists, in the same transaction. A member who
comes back generates a new token; nothing from the earlier membership works.

### D4. A reactivation first closes what a deactivation left open

`UserService.reactivate` calls `closeHeldBy` — delegations, mission tokens held as a
member, group memberships — before it
restores the status, and does not restore it if that fails.

### D5. Gates of an expired mission stay editable; an edit closes the opening

`gateEditBlockedBy` refuses a gate edit on a `revoked` or `orphaned` mission
only. On an expired mission the gate can be changed; `setGate` computes the
opening from the period as it stands (`periodNow`, `openGatesIn`) whatever the
state, so a gate set back to "approval" on an expired mission closes an approval
that was open, and the mission cannot be revived with it.

## Consequences

- A fourth place that needs "is this user on this mission" has one function to
  call, and a unit test (`membership.test.ts`) that pins the rule.
- The window between a removal and a token generation is closed in the store,
  not narrowed in the service. An interleaving test
  (`team-interleaving.test.ts`) drives both orders.
- `revoke` still sets the status and revokes the tokens in two statements. With
  D2 a token cannot be issued in between; a token already issued is refused by
  the mission state on the next call.
- `setGate` reads the period from in-process state marked `// single-process
only`; a hosted, multi-process deployment needs the store to answer it.

## Rejected alternatives

- **A database trigger on the token table.** Not portable across the engines
  the store interface keeps open, and invisible to whoever reads the service.
- **Serialising team operations per mission in the service.** In-process locks
  do not survive a second process.
- **Blocking gate edits on an expired mission.** It was implemented and
  reverted: an owner must be able to tighten a gate before granting the claim
  that revives the mission.
- **Restoring the previous token when a member is added again.** A token is
  bound to a period of membership; the person who was removed may not be the
  one who holds the secret now.
