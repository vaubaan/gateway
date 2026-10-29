---
title: A mission reaches the whole connection when its creator asks for it
status: accepted
date: 2026-10-18
---

# A mission reaches the whole connection when its creator asks for it

## Context

A mission names, per connection, the resources it may touch, stored at issuance as an explicit
list. That suits a task on a known project, not operating a live account: a mission on a Fly
organisation with no app could never reach an app created later, and each new resource meant a new
mission and new keys for every holder.

## Decision

A third resource scope, `{ scope: 'connection' }`, chosen explicitly and never a default, reaches
every resource discovery returns now and later, except hidden ones and the instance's own. It is
stored as the scope, with no resource rows, and resolved at read time by one function,
`reachedResources`.

## Consequences

- The execution door, the mission page and the kit all call `reachedResources`, so an agent is
  never told it may touch what the door refuses.
- `all` keeps its meaning (every resource known now, stored as that list); existing missions are
  never widened.
- Issuance checks against what is known now: an env-qualified risk needs a resource carrying that
  label at issuance.
- The width is visible: mission page, kit, `list_my_missions` and the `mission-issued` audit entry
  name the scope.

## Rejected alternatives

### Make `all` mean later resources too

Silently widens every mission already issued with `all`.

### Re-issue the mission when a resource appears

Forces a key replacement for every holder each time the account grows.
