---
title: The operator deactivates a user — offboarding without the identity provider
status: accepted
date: 2026-10-13
extends:
  - oidc-relying-party-and-web-session
  - orphaned-missions-and-ownerless-connections
  - management-door-authorization-server
---

# The operator deactivates a user — offboarding without the identity provider

> Closes "nothing ever sets `users.status = 'removed'`" (P3.4). Handbooks:
> [authentication](../handbook/authentication.md) ("Deactivating a user"),
> [authority](../handbook/authority.md), [store](../handbook/store.md).

## Context

The instance keeps no directory. A user exists once they have signed in, and
the IdP decides who may sign in. `users.status = 'removed'` was honoured by
every reader — the authority service ("holds nothing"), the authenticator, the
token endpoint, the delegated-token verifier, the mission grounds
(`creator-removed`) — and set by nothing but a test helper.

So a person removed at the IdP kept: their web session for up to eight hours,
each delegation for as long as a client renewed it (no absolute lifetime),
and every mission they had issued, for ever. A person the company wants out
**now**, or whom the IdP cannot remove quickly (a contractor on a shared
tenant, an IdP outage, a compromised account), could not be stopped on the
instance at all. Worse, `upsertFromIdp` reset the status to `active` at every
sign-in, so the flag could not have held against an IdP that still vouched.

## Decision

**An operator deactivates a user from Administration → Users, and
reactivates them.** `UserAdminService` (`server/users`), behind
`guardMutation(…, 'operator')`; routes `POST /admin/users/<id>/deactivate`
and `/reactivate`.

Deactivation, in this order:

1. `users.status = 'removed'`, `removed_at` and `sessions_ended_at` = now
   (migration `0009`). From this write on every authority check answers
   "holds nothing".
2. The user is removed from **every group**, local and IdP-sourced.
3. Every active delegation of the user is revoked with its tokens, reason
   `user-deactivated`, each with its own `delegation-revoked` entry in the
   operator's name.
4. One `user-deactivated` entry (object type `user`): the groups left, the
   number of delegations revoked.
5. The settlement every membership change gets (`MembershipSettler`):
   connections nobody owns any more become `unowned`; each mission of the user
   that read `active` gets a `mission-orphaned` entry (`creator-removed`).

What deactivation means for each thing the user held:

| Held                      | After deactivation                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| sign-in                   | refused, `account-deactivated`, before anything is written — although the IdP vouches                       |
| web sessions              | nobody at the next request; a session created at or before `sessions_ended_at` stays refused for ever       |
| delegations               | revoked, terminal                                                                                           |
| missions                  | **nothing is written on them**: they read `orphaned` by the derived rule; every call is `mission-inactive`  |
| group memberships         | removed                                                                                                     |
| connections owned alone   | `unowned` (a group they were the last member of, or a connection in their own name): the operator reassigns |
| shares made to them       | kept; they grant nothing to an inactive user                                                                |
| open requests of missions | nobody can decide them; they expire on the normal delay                                                     |

Reactivation sets the status back to `active` and clears `removed_at`. It
restores **nothing else**: missions whose authority still stands (a share to
the user, a connection still theirs) serve again by the same derived rule,
each with a `mission-restored` entry; IdP groups return at the next sign-in;
local groups, delegations, sessions and reassigned connections do not.

Supporting rules:

- **A sign-in never changes the status.** `upsertFromIdp` refreshes email,
  name and last sign-in only; `completeLogin` refuses a removed subject first.
- **A connection whose owner user is not active is ownerless**, as one whose
  owner group is empty: the store's ownerless predicate and the service's
  pre-check cover both, so `markOwnerlessUnowned`, the Administration list and
  the reassignment all see it.
- **An operator cannot deactivate themselves** (`cannot-deactivate-self`). The
  bootstrap operator can deactivate anyone.

## Consequences

- Offboarding takes effect at the next request of every credential the user
  held, without the IdP. The threat-model handbook cites this as the control
  for "a person removed at the IdP keeps a session, delegations and
  missions".
- Deactivation is deliberately heavy and only partly reversible: memberships
  of local groups and delegations are gone. The page says so before and
  after.
- `removed` now has one meaning — "deactivated by an operator" — where the
  code comments said "vanished from the IdP". Nothing syncs with the IdP's
  directory: that remains a later question (SCIM or periodic sync).
- New audit acts `user-deactivated`, `user-reactivated`; new audit object
  type `user` (operators only: no user scope reads it); new delegation revoke
  reason `user-deactivated`; new sign-in error `account-deactivated`; new
  column `users.sessions_ended_at`.
- A session opened in the very millisecond of a deactivation is refused
  (`<=`): the comparison fails closed.
- Two operators can deactivate each other. Accepted: both acts are audited,
  and the bootstrap token is not a way back in (it is revoked for good). An
  instance whose every operator is deactivated needs another user matching
  the admin rule to sign in.

## Rejected alternatives

- **Rely on the IdP alone and document it.** It is the situation described
  above; the spec's `orphaned` cause "creator removed from the IdP" had no
  way to become true.
- **Revoke the user's missions.** A stored verdict where the product derives
  one: a reactivated user's missions would be lost, and the rule "authority is
  never snapshotted" would have its first exception. Derived, the missions
  stop at the same instant.
- **Keep the memberships and count only active members.** Every reader of
  "has this group a member" (the ownerless predicate, the reassignment
  targets, the transfer rule, the Groups page) would need the status join,
  and a deactivated user would silently regain owner rights on reactivation.
  Removing the rows makes the state visible and the reactivation explicit.
- **Delete the user's session rows.** The session store is a key-value port
  keyed by a digest of the bearer; it cannot list by user, and a hosted
  deployment injects another implementation. A watermark on the user row
  works for every implementation and also covers reactivation.
- **A new status `deactivated` next to `removed`.** Two values every reader
  would treat alike, and a table rebuild to widen the CHECK.
- **Let the IdP reactivate at sign-in** (the previous behaviour). It makes
  deactivation a no-op against the one case it exists for.
