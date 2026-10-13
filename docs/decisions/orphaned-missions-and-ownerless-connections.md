---
title: Orphaned missions and ownerless connections — a final stored state derived on every check; one share per target; the admin rule ignores local groups
status: accepted
date: 2026-10-13
extends:
  - pivot-v4-to-v5-on-prem-mission-tokens
  - oidc-relying-party-and-web-session
---

# Orphaned missions and ownerless connections — a final stored state derived on every check; one share per target; the admin rule ignores local groups

> Decisions taken while building groups, shares, ownership transfer and the
> `orphaned` / `unowned` states (feature P2.2 of the v5 plan). The v1
> assumptions of spec §11.2 are followed as written (operator-only local
> groups; transfer only to a group one belongs to; no transitive sharing; no
> quantity, gate or resource in a share): nothing here deviates from them.
> These are the points the spec leaves open or states in two ways. Handbook:
> [authority](../handbook/authority.md).
>
> **Amended on 2026-10-13 by P2.2b** — Decision 1 is reversed: `orphaned` is
> derived from the creator's current authority on every read, never stored,
> and ends when the authority comes back. See "Amendment 2026-10-13 —
> `orphaned` is derived and reversible" below (D1′, D2′, D7′). The title, the
> first decision, the third consequence and the first rejected alternative
> are kept as written, for the record of what was decided first.

## Context

1. **Is `orphaned` a status or a computation?** Spec §2.3 lists `orphaned`
   among the mission states and says a revoked share "turns" missions
   orphaned; spec §10 says authority is "recomputed from current membership,
   never from a snapshot". After Phase 1 the status existed in the schema and
   nothing ever set it; the execution door trusted the stored status.
2. **A revoked connection.** Spec §2.3 says, under Connection, that a revoked
   connection makes calls fail "with a structured refusal naming the
   connection" (`connection-unavailable`), and, under Mission, that a revoked
   connection makes its missions `orphaned` (`mission-inactive`); §7.8 repeats
   the second. Phase 1 implemented the first.
3. **An `unowned` connection whose credential dies.** Spec §2.3 names
   `active → expired` only. Phase 1 left such a connection `unowned`, serving
   nothing while saying it served.
4. **Who learns that a membership changed.** IdP memberships are replaced at
   each sign-in, in the authentication module; local memberships are edited by
   the operator. `unowned` and `orphaned` are stored states that depend on
   membership.
5. **Editing a share.** The spec defines a share as `(connection, target,
restriction)` with states `active → revoked`, and says nothing of changing
   a restriction.
6. **Local groups and the admin rule.** The admin rule may name a group. With
   an interface to create local groups and fill them, a group of that name
   would make its members operators, and `admin.group` was documented as "the
   stronger rule, since group membership is granted by the IdP".

## Decision

1. **`orphaned` is a stored, final status whose derivation is never stored.**
   `MissionGrounds.check(mission)` computes, from the store, whether the
   creator still covers the mission's accepted risks on each connection. The
   execution door runs it on every request (`settle`); the services run it
   right after each act that can remove an authority (`sweepConnection`,
   `sweepCreator`). An ungrounded `active` mission is updated to `orphaned`
   by a conditional write. It never returns to `active`: when the authority
   comes back, the creator issues a new mission. **Reversed by the amendment
   of 2026-10-13 below (D1′).**
2. **A revoked connection orphans the missions that carry it**, the owner's
   own included, and every connection of a multi-connection mission with it.
   `connection-unavailable` remains the refusal of an `expired` connection.
3. **A serving connection whose refresh is rejected becomes `expired`, owned
   or not.** An `unowned` connection that expires stays in the operator's
   list (`listOwnerless`: `unowned`, or not revoked with an empty owner
   group); after reassignment it is `expired` under its new owner, who
   reconnects it.
4. **`unowned` is set after every membership removal the gateway performs**,
   by one statement over all connections (`markOwnerlessUnowned`), called by
   the local-groups service and by the sign-in through a hook
   (`LoginDeps.membershipsSynced`). The same settlement re-checks the missions
   of the user who lost a membership. A member joining the group again does
   not restore the connection: only the operator's reassignment does. A
   settlement that fails at sign-in is logged and does not fail the sign-in.
5. **One active share per `(connection, target)`; sharing again replaces.**
   The previous share is revoked and the new one created in one transaction;
   both acts are audited; missions that exceed the new restriction are
   orphaned. An empty restriction is refused rather than stored.
6. **The admin rule counts IdP-claimed groups only**, and a local group
   cannot take the name of the admin rule's group.
7. **Detection by the door writes no administrative entry.** An
   administrative entry names a human (spec §8). When a sweep orphans a
   mission, the entry (`mission-orphaned`) names the person whose act removed
   the authority; when the door finds it, the transition is logged and the
   refused call is audited.

## Consequences

- A revocation takes effect at the latest on the next call of the mission,
  whatever path made the change, including a write the services never saw.
- The door does one to three more indexed reads per request (about 20–45 µs
  measured in process, handbook authority "The door").
- A transient loss of authority is permanent for the missions it grounded:
  an IdP that omits a group at one sign-in orphans that user's missions on the
  connections that group owned or received. The user signs in again with the
  right claims and issues new missions; the orphaned ones stay closed.
  **Closed by the amendment of 2026-10-13 below.**
- `connection-unavailable` with `status: 'revoked'` is now only reachable in
  the instant between a revocation and the sweep; an agent reads
  `mission-inactive` (orphaned) instead, and the reason is generic. The
  precise cause is in the `mission-orphaned` entry, which the creator can read
  in the Audit.
- A multi-connection mission stops entirely when one of its connections is
  revoked or one of its shares withdrawn.
- IdP memberships are only as current as the user's last sign-in: a user
  removed from a group at the IdP keeps what that group grounded until they
  sign in again or a deprovisioning feed exists.
- An operator who names, in the admin rule, a group that already exists as a
  local group locks the rule: the IdP claim is skipped (name collision) and
  local membership does not count. The email list still applies.
- New administrative acts: `connection-reassigned`, `mission-orphaned`,
  `group-created`, `group-member-added`, `group-member-removed`; new object
  type `group`.

## Rejected alternatives

- **`orphaned` purely derived, never written** (the mission lives again when
  the authority returns). Closer to "never from a snapshot", but the status
  column, the request service (`mission-closed`) and the listings would then
  each need the derivation, and a share revoked on purpose would be undone by
  any later share to the same person. A new mission is one click and is
  checked against the authority of that day. **Adopted by the amendment of
  2026-10-13 below, which answers both objections.**
- **Sweeps only, no check at the door.** Cheaper per call, but any path that
  changes a membership or a share without calling the sweep (a future import,
  a repair in the database, a bug) would leave missions running on an
  authority that no longer exists. The door check is the guarantee; the
  sweeps make the state visible at once and attribute it.
- **Door check only, no sweep.** The mission page would show `active` until
  the next call, and no entry would name who removed the authority.
- **Keep `connection-unavailable` for a revoked connection.** It names the
  connection, which is more useful to the agent, but revocation is terminal:
  the mission can never work again, which is what `orphaned` says, and §7.8
  asks for it.
- **Maintain `unowned` inside the membership transactions of the store.**
  Atomic, but it hides a domain rule in the repository and leaves the mission
  sweep to be triggered separately.
- **Automatic return from `unowned` when a member joins.** The spec gives
  that decision to the operator.
- **Several active shares per target, or an in-place update of the
  restriction.** The first makes "what does this person hold" a union the
  owner must compute; the second loses the history of what was shared when.
- **Let a local group satisfy the admin rule.** It would let any operator
  create operators outside the IdP, and make the rule depend on a table
  edited in the interface it protects.

## Amendment 2026-10-13 — `orphaned` is derived and reversible, never stored (P2.2b)

Reverses Decision 1 ("a stored, final status") and the rejected alternative
"`orphaned` purely derived, never written". Decisions 2 to 6 stand; Decision 7
is extended to the way back. The spec says it since (§2.3, Mission): "The
state is derived from the creator's current authority, never stored as a
verdict: if the authority comes back, the mission serves calls again, with its
session and counters intact. A revoked connection never comes back, so its
missions stay orphaned."

### Why

A final verdict turns a transient loss of authority into a permanent outage.
The third consequence above was written as a cost; it is a defect:

- an IdP that omits one group at one sign-in closes, for good, every mission
  of that user on the connections the group owned or received. This is not
  rare: Entra ID stops listing groups in the token above 200 memberships and
  emits an overage claim instead; a claim mapping is edited and breaks for an
  afternoon; a user is removed from a group and put back;
- "a new mission is one click" was wrong about the cost. The click is the
  creator's; the token is in the environment of each code project that uses
  the mission, and every one of them needs the new one. The session and its
  counters start again from zero, so the period's budget is granted twice;
- the argument "a share revoked on purpose would be undone by any later
  share" confuses the mission with the share. The owner who shares again
  grants that authority again, on purpose, to the same person; a mission that
  fits inside it is exactly what the share allows. An owner who wants a
  mission closed has two terminal acts for it, both stored: revoking the
  connection, and (the creator's) revoking the mission.

### D1′ — `orphaned` is computed on every read and stored nowhere

`MissionGrounds.check(mission)` is unchanged. What changes is what is done
with its verdict:

- `MissionGrounds.inspect(mission)` returns the mission as a reader must see
  it — `status: 'orphaned'` in place of `active` when the verdict is
  ungrounded — with the reason (`cause`, `connectionId`, `uncovered`).
  Nothing is written. A mission the store holds as `revoked` or `expired`
  is returned as it is, without a read: those are stored facts no authority
  changes;
- every reader goes through it: the execution door on every request, the
  mission service on every load (list, detail, session page, gate edit,
  rotation, revocation), the request service on every load (view, claim and
  approval decisions), and the Delegations listing through reads the
  composition root wraps (`derivedMissionReads`). A structural test lists
  the files that load a mission record and fails on a new one until it is
  classified;
- the column keeps `active`. `MissionsRepo.markOrphaned` is removed,
  `setStatus` takes a `StoredMissionStatus` (every status but `orphaned`),
  and migration 0007 resets the rows P2.2 had written and adds two triggers
  that refuse the value on insert and on update. The CHECK of migration 0001
  still lists it: applied migrations are immutable and the table is not
  rebuilt for it.

While orphaned nothing else changes: every call is refused
`mission-inactive` (`status: orphaned`), no gate is edited, no token rotated,
no claim or approval granted (`mission-closed`; a refusal can still be
recorded), and the creator can still revoke — which is stored and terminal.
When the authority is back, all of it is back: same token, same session,
same counters, same open requests.

### D2′ — A revoked connection still orphans, and that never ends

Decision 2 stands, and it is where the spec's last sentence comes from:
revocation erases the credential and is terminal, `check` answers
`connection-revoked` before it asks about any share, so no later act
restores the mission. The mission page says so, and tells the creator to
revoke the mission and issue a new one.

### D7′ — Human acts are audited in both directions; the door in neither

With nothing stored, "this act orphaned that mission" is no longer a write
to observe: it is a difference between two verdicts. The services therefore
take the verdicts **before** the act and compare **after** it:

```
const watch = await grounds.watchConnection(connectionId);   // or watchCreator(userId)
…the act…
const { orphaned, restored } = await watch.settle(actorId);
```

One `mission-orphaned` entry per mission that was grounded and is not any
more (as before: `before: { status: 'active' }`, `after` with the cause);
one `mission-restored` entry per mission that was orphaned and is grounded
again (`before` with the cause it was orphaned for, `after: { status:
'active' }`). Both name the human behind the act:

| Act                                                      | May orphan | May restore | Actor                  |
| -------------------------------------------------------- | ---------- | ----------- | ---------------------- |
| `ShareService.share` (new share, or a replacement)       | yes        | yes         | the owner              |
| `ShareService.revoke`                                    | yes        | no          | the owner              |
| `ConnectionService.revoke`                               | yes        | no          | the owner              |
| `ConnectionService.transfer`                             | yes        | yes         | the owner              |
| `ConnectionService.reassign`                             | yes        | yes         | the operator           |
| `GroupService.addMember` / `removeMember`                | yes        | yes         | the operator           |
| a sign-in (`completeLogin`, around `syncIdpMemberships`) | yes        | yes         | the user who signed in |

The sweeps of Decision 1 and the hook of Decision 4 are replaced accordingly:
`sweepConnection` / `sweepCreator` by `watchConnection` / `watchCreator`,
`MembershipSettler.afterRemoval` by `watch(userId)` … `settle(actorId)`, and
`LoginDeps.membershipsSynced` by `membershipsChanging`, called before the
memberships are replaced and returning the function called after.

The door writes no administrative entry in either direction: no human is
behind a read. It logs the refusal with its cause, and the pipeline audits
the refused call. A change made by a path that no service watched is
therefore seen at once by every reader, and has no administrative entry;
the two entries of one mission need not come in pairs.

The watch holds verdicts for the length of one act and for the audit only:
no reader ever sees them, so it is not the snapshot spec §10 forbids.

### Consequences

- A transient loss of authority is a transient refusal. The agent is told
  `mission-inactive` (orphaned) with a hint that says the same token works
  again when the authority is back.
- The door's cost is unchanged (one to three indexed reads; measured again
  with the same bench: 17–19 µs owner in their own name, 19–21 µs owner
  through a group, 43–45 µs share to a group, against 19 / 21 / 44 µs before).
  The orphan path is now cheaper by one write. The mission and request pages
  pay the same reads once per mission shown.
- A page shows the state of the instant it was rendered: a mission listed
  `active` may refuse the next call, and the reverse. The door decides.
- The creator reads the reason on the mission page itself (`MissionOverview.orphan`),
  not only in the Audit, and whether it can come back.
- A sign-in settles in two steps (watch, replace the memberships, settle).
  They are not one transaction: two concurrent acts on the same mission can
  each record the same change, or one can record a change the other caused.
  The state itself cannot be wrong, only the attribution of an audit entry.
- An orphaned mission that nobody restores or revokes stays listed as
  orphaned for ever. Its token still authenticates (and is refused): closing
  it is the creator's revocation.
- A share made again restores the missions that fit inside it, including
  ones the owner had forgotten. The share notice counts them ("1 orphaned
  mission is covered again").
- New administrative act: `mission-restored`.

### Rejected alternatives

- **Keep the status stored, and flip it back when a sweep finds the grounds
  again.** Two writers of one column (the door and the sweeps), in two
  directions, with a path that changes authority without a sweep leaving the
  column wrong either way. The derivation needs no reconciliation.
- **Store a "last seen verdict" beside the status, to write the audit
  entries from the door.** It is the stored verdict again under another
  name, and it would make the door attribute an administrative entry to
  nobody.
- **A grace period before a lost authority refuses calls.** It would let a
  mission run on an authority its owner has just withdrawn; the spec asks
  for the refusal at once.
- **Derive inside the repository** (`MissionsRepo.getById` returning
  `orphaned`). It hides a domain rule in the store and makes the hot path of
  the door pay it on every record load, the budget stage's included.
- **Rebuild the `missions` table to drop the value from its CHECK.** A
  table rebuild under foreign keys for a constraint two triggers give.
