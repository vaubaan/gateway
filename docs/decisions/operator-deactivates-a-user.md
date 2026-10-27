---
title: The operator deactivates a user — offboarding without the identity provider
status: accepted
date: 2026-10-13
---

# The operator deactivates a user — offboarding without the identity provider

## Context

The instance keeps no directory: the IdP decides who may sign in. A person removed at the IdP kept
a web session up to eight hours, every delegation a client renewed, and every mission they issued;
a person the IdP cannot remove quickly (shared tenant, outage, compromised account) could not be
stopped on the instance at all.

## Decision

An operator deactivates a user on the instance: the user row is marked `removed` with a
`sessions_ended_at` watermark, their group memberships and delegations end, and from that write
every authority check answers "holds nothing". A sign-in never changes the status; reactivation
restores the status only.

## Consequences

- Offboarding takes effect at the next request of every credential the user held, without the IdP.
- The user's missions are not written: they read `orphaned` by the derived rule and serve again if
  a reactivated creator's authority still stands.
- A connection whose owner user is not active is ownerless and goes to the operator to reassign.
- Deactivation is partly irreversible (delegations, local groups, reassigned connections do not
  return); an operator cannot deactivate themselves.

## Rejected alternatives

### Rely on the IdP alone

Leaves sessions, delegations and missions running after offboarding.

### Revoke the user's missions

A stored verdict where the product derives one; a reactivated user's missions would be lost.

### Delete the user's session rows

The session store cannot list by user; a watermark on the user row works for every implementation.

### Let the IdP reactivate at sign-in

Makes deactivation a no-op in the one case it exists for.
