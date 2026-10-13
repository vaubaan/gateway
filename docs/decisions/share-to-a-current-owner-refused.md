---
title: A share to somebody who owns the connection now is refused
status: accepted
date: 2026-10-13
extends:
  - orphaned-missions-and-ownerless-connections
---

# A share to somebody who owns the connection now is refused

> Closes the "self-share as persistence" note of the Phase 2 security review
> (P3.4). Handbook: [authority](../handbook/authority.md).

## Context

A connection owned by a group makes every current member a full owner
(spec §3.1 "The owner needs no share"). Only owners share, and the only
target `ShareService` refused was the owner principal itself: the group, for a
group-owned connection.

So a member of the owner group could share the connection **to their own
user**. The share granted nothing while they were a member. The day the
operator removed them from the group, it became their authority: their
missions kept serving and they could issue new ones, on a restriction they
had chosen themselves. The removal, which the operator and the co-owners read
as "this person no longer holds this connection", was silently undone in
advance. Two members could do the same for each other.

Nothing was hidden — the share is listed in the Share dialog and audited —
but nobody looks for a share to a co-owner, and the spec's promise is that
authority follows current membership (§2.3, §10).

The brief gave two ways out: forbid the share, or drop such shares when the
membership ends.

## Decision

**`ShareService.share` refuses a user target who owns the connection now**,
with the existing code `target-is-owner`. "Owns now" is asked to the authority
service (`authorityOf(target, connection).basis === 'owner'`), the one
definition every check uses: the owner user, or a current member of the owner
group. Nothing is stored, nothing is audited.

A share to a **group** is not concerned, whether or not the sharer belongs to
it: its other members are the point of it. A share made to a former member
**after** they left is an ordinary share: an owner decided it with the
removal in front of them.

## Consequences

- Leaving an owner group ends the authority it gave, with no residue the
  member could have prepared: their missions on that connection read
  `orphaned`, and issuance is refused.
- The refusal sentence now says both cases ("as its owner, or as a member of
  the group that owns it").
- A share that existed **before** the target joined the owner group stays, and
  applies again when they leave. It was made by an owner to somebody who was
  not one: an ordinary grant, visible as such.
- Rows created before this rule are not migrated: a self-share made on an
  earlier build still stands. It is visible in the Share dialog of the
  connection; an owner revokes it there. The threat-model handbook lists it.
- Still possible, and accepted: a member shares to a group they also belong
  to, or two colluding owners arrange a share right after one leaves. Both
  are acts of a current owner, who may share to anyone.

## Rejected alternatives

- **Drop the shares to a member when their membership ends.** The membership
  changes in three places (operator edit, IdP sync at sign-in, deactivation)
  and each would have to revoke shares it did not make, on connections it
  does not otherwise touch, and audit them in the name of somebody who did not
  decide them. It also revokes the legitimate case above (a share older than
  the membership).
- **Forbid only the share to oneself.** Two members sharing to each other
  reach the same result.
- **Refuse at authority time instead of at share time** (ignore a share whose
  creator was the target). Authority would then depend on who made a row, a
  rule no reader of the Share dialog could guess.
