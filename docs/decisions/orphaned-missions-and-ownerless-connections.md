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
   comes back, the creator issues a new mission.
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
  checked against the authority of that day.
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
