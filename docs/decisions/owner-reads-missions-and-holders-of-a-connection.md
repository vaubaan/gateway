---
title: An owner of a connection reads the missions that carry it and who holds it, by name
status: accepted
date: 2026-10-14
---

# An owner of a connection reads the missions that carry it and who holds it, by name

> Decided while rebuilding the page of an account (interface redesign, step R2c). Spec:
> [vaubaan-gateway](../spec/vaubaan-gateway.md) §2.3, §4.2, §8. Handbooks:
> [connections](../handbook/connections.md), [authority](../handbook/authority.md).

## Context

The redesigned page of an account (a connection) answers three questions an owner asks
before acting on it: who has access and up to what, what the account reaches, and which
missions use it — because removing an access, or disconnecting, stops missions, and the
confirmation of each act says how many.

Before this, the page listed the shares of the connection by the server's label of
their target (`bob@example.com`, `group finance`) and, of the missions, only the
orphaned ones (`MissionService.orphanedOn`). Nothing answered "which missions run on
this account" for an owner who did not create them, and nothing said who is behind a
team.

What an owner could already learn elsewhere: the audit entries of their connection
(spec §8: "an entry is read by […] the owners of its connection"), each of which names
its mission, the creator of that mission and the holder of the token used.

## Decision

Two read-only queries, each for someone who **owns the connection now** and for nobody
else:

- **`MissionService.onConnection(user, connectionId)`** returns every mission that
  carries the connection, whoever created it: its name, its creator (id and email), its
  state derived at this instant (`active`, `expired`, `revoked`, `orphaned` with the
  cause), how many of its accepted risks are spent, the resources **of this connection**
  it was issued on, how many accepted risks belong to this connection's provider and how
  many of them wait for an approval, and whether the reader may open the mission's own
  page (its creator, a current member). To anyone who does not own the connection — a
  person who only holds a share, an operator as such — it answers an empty list, like
  `orphanedOn`.
- **`ShareService.holders(actor, connectionId)`** returns the owner and every active
  share, each with the people behind it: a person (display name, email, last sign-in,
  deactivated or not), or a group with its current members; and, for a share, who made
  it. To anyone who does not own the connection it throws `not-found`, like every read
  of the share service.

Neither decides anything. Authority stays `AuthorityService.authorityOf`; the state of a
mission stays `MissionGrounds` and the budget's `stateOf`. Nothing of another connection
of a mission is returned: not its resources there, not its risks there.

The page prints the members of the **owner** group by name (the reader is one of them
and co-owns the credential with them) and, for a group that only holds a share, how
many people it has.

## Consequences

- An owner sees, in one list, what they could only reconstruct from the audit: the
  names of the missions other people run on their account, and who created them. This is
  the same disclosure as the audit, not a wider one; it is now one query away instead of
  a search away.
- An owner who cannot open a mission (they neither created it nor are a member) still
  reads its name here; the name is a link only when `readable` is true.
- The confirmations of "Remove access" and "Disconnect" state a number of missions that
  is read at the time the page is rendered; the act itself is settled by
  `MissionGrounds`, and its notice gives the number that actually stopped.
- A mission whose creator's row is gone is listed with "unknown user", as in
  `orphanedOn`.
- Both queries are listed as reads in the structural test of administrative mutations
  (`tests/integration/audit/admin-mutations.test.ts`): they write no audit entry.
- The list costs one grounds inspection and one state read per mission of the
  connection, at every rendering of the page. Acceptable for the tens of missions a
  connection carries; a connection with thousands would want a page of its own.

## Rejected alternatives

### List only the owner's own missions

No disclosure at all — and no answer to "what stops if I disconnect": the missions that
matter for that question are precisely the ones other people created on an access the
owner gave.

### Counts only, without names

"5 missions use this account" hides which ones, so the owner goes to the audit to find
out — where the names already are. A count that sends the reader elsewhere for
information they are entitled to is a detour, not a protection.

### Make the mission pages readable by the owners of their connections

It would turn a list into a second reader of the whole mission (its other connections,
its policy elsewhere, its session). The spec gives a mission two kinds of readers, its
creator and its members; an owner of one of its connections is neither.

### Name the members of every group, including one that only holds a share

A group that receives a share is named by the owner who shares to it, and its size says
how far the access reaches. Its members are the identity provider's to list; the page
of Administration shows them to operators. The owner group is different: the reader
belongs to it.

## References

- Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §2.3 (orphaned missions, who may
  close them), §4.2 (Connections), §8 (who reads an audit entry).
- ADRs: [audit-visibility-members-and-operators](audit-visibility-members-and-operators.md),
  [orphaned-missions-and-ownerless-connections](orphaned-missions-and-ownerless-connections.md),
  [interface-redesign-vocabulary-and-design-system](interface-redesign-vocabulary-and-design-system.md).
- Tests: `apps/gateway/tests/integration/authority/missions-on-connection.test.ts`.
