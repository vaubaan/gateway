---
title: Request expiry on orphaned missions — the sweeper expires them on the normal delay
status: accepted
date: 2026-10-13
extends:
  - orphaned-missions-and-ownerless-connections
  - claim-resolutions-as-counter-credits
  - atomic-budget-accounting
---

# Request expiry on orphaned missions — the sweeper expires them on the normal delay

> Records what happens to the open requests (claims and approval requests)
> of a mission while it is `orphaned`: nothing special. Decided at the
> Phase 2 cycle-end, from the behaviour the requests module already has.
> Handbook: [requests](../handbook/requests.md).

## Context

Since the amendment of [[orphaned-missions-and-ownerless-connections]],
`orphaned` is derived on every read from the creator's current authority and
stored nowhere; it is reversible when the authority comes back, except for a
revoked connection, which never comes back.

A request to the creator carries an expiry stamped when the budget drops it
(`requests.expiry`). The request sweeper flips every open request past that
date to `expired` and erases its sealed arguments in the same statement. A
request of an orphaned mission cannot be granted meanwhile: its options are
shown unavailable (`mission-closed`), it takes a refusal only, and it is
decidable again, if it has not expired, once the authority is back.

That leaves a question the earlier ADRs do not answer: while the creator
cannot grant, should the clock of the request keep running?

## Decision

**The sweeper expires the open requests of an orphaned mission on the normal
delay. Expiry is not paused, and the sweep does not look at the mission.**

- The sweep stays one rule on the request alone: `state = 'open'` and
  `expires_at` passed. It reads neither the mission's stored status nor the
  derived one.
- An expired request of an orphaned mission is erased like any other: state
  `expired`, sealed arguments and their key version set to null, one session
  event.

## Consequences

- The sealed arguments of an approval request live for the lifetime of the
  request and no longer (spec §3.5), whatever happens to the mission. The
  bound on how long the gateway holds an action's arguments is
  `requests.expiry`, with no exception to explain.
- A mission that comes back after its request expired has no request to
  grant. Nothing is lost: the executor's next refused call opens a new one
  ([[atomic-budget-accounting]], "A replayed refusal reuses the open
  request": once a request expired, the next refusal opens a new request).
- A mission that comes back before the expiry finds the same request,
  decidable again — the behaviour the requests handbook describes.
- The inbox of a creator whose authority is gone empties by itself on the
  normal delay.

## Rejected alternatives

- **Pause expiry while the mission is orphaned.** Rejected for three
  reasons. The sealed arguments would be held for as long as the mission
  stays orphaned, which is unbounded, and for ever on a revoked connection,
  whose missions never come back: the opposite of "for the lifetime of the
  request, then erased". A status filter in the sweep would be the one
  reader that bypasses the derived `orphaned` — the stored status no longer
  says it — or would have to derive the grounds of every mission with an
  open request on every pass. And pausing buys nothing, since the next
  refused call opens a new request.
