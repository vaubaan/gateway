---
title: A delegation has an absolute lifetime of 90 days, derived from the consent date and never stored
status: accepted
date: 2026-10-13
amends:
  - management-door-authorization-server
---

# A delegation has an absolute lifetime of 90 days, derived from the consent date and never stored

> Product owner's decision of 2026-10-13 (question 4 of the final pass; accepted
> risk A5 of the threat model). Spec:
> [vaubaan-gateway §0 "Delegation", §6](../spec/vaubaan-gateway.md). Handbook:
> [management-door, "Absolute lifetime of a delegation"](../handbook/management-door.md#absolute-lifetime-of-a-delegation-delegation-lifetimets).

## Context

A user authorizes an MCP client once, on the consent screen. The client gets an
access token of fifteen minutes and a refresh token of thirty days, rotated at
every use, each rotation starting the thirty days again. A client that renewed
in time kept its authorization for ever: nothing ever asked the user again.
The threat model listed it as accepted risk A5, "a product decision not taken".

## Decision

### D1. Ninety days from the consent, then the user consents again

A delegation ends `oauth.delegation_max_lifetime` after `delegations.created_at`
(`VAUBAAN_OAUTH_DELEGATION_MAX_LIFETIME`, a duration, default `90d`, longer
than the access token's lifetime). Past it the refresh grant answers
`invalid_grant` with a sentence that tells the client to start the
authorization flow again, the code grant answers the same, the reuse window of
a rotated refresh token gives nothing, and the verifier resolves no access
token of the delegation.

### D2. The deadline is derived, never stored

No column, no migration, no timer, no sweep. The deadline is the consent date
plus the configured lifetime, computed wherever a token is issued, accepted or
shown (`delegation-lifetime.ts`, the only place that knows the rule). The
stored status stays `active`; the Delegations page reads `expired`.

No `delegation-revoked` entry is written: nobody revoked. The audit holds the
`delegation-granted` entry with its date, and the lifetime is configuration.

### D3. No token outlives the deadline

A token minted before the deadline expires at its own lifetime or at the
deadline, whichever comes first, and `expires_in` says so. Without this a
refresh token obtained on day 89 would be a row valid until day 119, held back
only by the check of D1.

### D4. Shown to the user

The Delegations page shows, on each delegation that is not over, the date the
consent ends, and says in its introduction how long a delegation lasts at most.
An expired delegation shows the date it expired and that the application must
ask again.

## Consequences

- Delegations granted more than ninety days before the upgrade stop at their
  next renewal. The client restarts the standard flow; a client such as Claude
  Code does it by itself and the user sees the consent screen.
- The missions a delegation issued are not concerned: they are the user's.
- An operator who shortens the key shortens every delegation at once, tokens
  already issued included. One who lengthens it revives nothing: the tokens of
  a delegation that reached the old deadline expired there.
- Accepted risk A5 becomes its residue: for ninety days a delegation is
  renewed without the user being asked.
- Expired delegations stay in the user's list, like revoked ones.

## Rejected alternatives

- **Store `expires_at` on the delegation.** A migration, and a second source
  for a value the configuration already determines; a shortened key would not
  reach existing rows.
- **Revoke the delegation when the deadline is met**, with an audit entry.
  It needs either a background task or a write in the middle of a refusal, in
  whose name? An expiry is not an act. Missions expire the same way: derived.
- **Slide the lifetime on activity.** That is what the refresh token already
  does; the point is that something does not slide.
- **Ask for the consent at every renewal, or every week.** Unusable for an
  agent at work. The value is a key for the operator who wants it shorter.
