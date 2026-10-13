---
title: Audit visibility — a member reads the entries of a mission shared with them, an operator reads every entry; neither is shown the argument fingerprint
status: accepted
date: 2026-10-13
amends:
  - mission-members-and-per-holder-tokens
---

# Audit visibility — a member reads the entries of a mission shared with them, an operator reads every entry; neither is shown the argument fingerprint

> Product owner's decisions of 2026-10-13 (questions 7 and 15 of the final pass).
> Spec: [vaubaan-gateway §4.2 "Audit", §8](../spec/vaubaan-gateway.md). Handbook:
> [audit, "Who sees what"](../handbook/audit.md#who-sees-what-scopeof-standingon-auditreposearch).

## Context

The Audit page showed a user the entries of the missions they created and of
the connections they own, and an operator every administrative entry on top.
Two readers were left out:

- a **member** of a mission, who works on it under their own name, read its
  session but not its audit;
- an **operator**, who answers for the instance, read no call but their own.

Both decisions came with the same condition: "without arguments", "never
arguments". The audit never holds arguments. It holds their fingerprint, an
unsalted SHA-256 that can be guessed offline for low-entropy arguments
(threat model, A9) — accepted for the people who answer for a call, and the
only thing in an entry that the condition can be about.

## Decision

### D1. The scope gains two dimensions

- `missionMemberUserId`: the entries of the missions the viewer is a member of
  **right now** — calls, acts on the mission, acts on its requests. A removed
  member reads none of them, past ones included: the right follows the
  membership, like the token.
- `allCalls`: every call entry, for an operator.

The bootstrap operator keeps the administrative entries only: it is a shared
token, and exists before the first user.

### D2. The fingerprint is shown to who answers for the call

`standingOn(viewer, mission, connection)`:

- `responsible` — the creator of the entry's mission, an owner of its
  connection: shown the fingerprint, as before;
- `reader` — anybody else the scope gave the entry to (a member, an operator):
  `arguments_hash` is `null` in the view, and the fingerprint keys of an
  administrative entry (an approval request's) are masked.

Decided entry by entry, from the mission and the connection as they are when
the page is read. An operator who created a mission reads its fingerprints; a
member who owns the connection a call went through reads that call's.

### D3. One predicate, pieces that carry their own values

The store's scope clause is rebuilt as `scopePredicate`: each `IN` subquery is
a piece of SQL with its own placeholder values. The previous statement listed
the values by hand, seven times in order; a new dimension would have had to be
threaded through all of them correctly.

## Consequences

- The Audit page of an operator lists every call of the instance. Filters
  (mission, user, connection, period) are how it is read.
- A9 no longer widens with these two readers: it stays with creators and
  owners.
- A member and the creator do not see the same page for the same mission: the
  creator's has fingerprints. The session page shows none to anybody.
- The mission filter of the page offers the missions shared with the viewer.

## Rejected alternatives

- **Show the fingerprint to everybody who reads the entry.** It is not the
  arguments, but for a boolean flag or a short enum it is as good as them; the
  decisions said "never".
- **Give members the calls only, not the administrative entries.** A member
  already sees the mission's events in its session; the acts are the same
  facts with their author.
- **Keep past entries readable to a removed member.** A person taken off a
  mission should not keep its history.
- **Let the bootstrap token read calls.** No use before the identity provider
  is configured, and a risk after.
