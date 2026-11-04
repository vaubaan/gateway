---
title: A resource set is one environment, an explicit list, and optionally the resources that appear there later
status: accepted
date: 2026-11-04
author: Renaud Pelissier
---

# A resource set is one environment, an explicit list, and optionally the resources that appear there later

## Context

A resource set could mix environments and had three scopes (a list, `all` frozen at issuance, the
whole connection resolved at call time). Creators could not read what a set reached, a trust level
meant different things on its prod and staging resources, and "the whole connection" also took in
resources they had chosen not to tick. The mission form shows one card per set, and a card must say
in one line what it reaches.

## Decision

Every resource of a set carries the same effective environment (a label, or none). A set is an
explicit list of resources plus one flag, **future**: when on, a resource that later appears on the
connection with the set's environment — discovered, or relabelled into it — is written into the
set's list, unless another set of the mission already holds it. What a mission reaches is always
its stored lists; nothing is resolved from the connection at call time.

## Consequences

- A resource relabelled out of a set's environment leaves that set at once; it joins the set of its
  new environment that has future on, else it leaves the mission. Each join and leave is audited on
  the mission.
- Discovery feeds future sets: it runs at connection, on demand, after a creating call, and every
  hour for connections that a future set depends on.
- Drafts with the flat shape (`resources`, `all`, `connection`) are split by environment into one set
  per environment, each with the policy lines that apply there; `connection` becomes the known
  resources plus future.
- An unlabelled resource can enter a set only on a provider whose catalog has no env-qualified risk.

## Rejected alternatives

### Keep the whole connection as a scope resolved at call time

Reaches resources the creator deliberately left out, and a relabel silently moves a resource
between policies without a trace.

### Resolve "future" at call time from discovery and relabel dates

Same reach without writes, but deselecting a resource that joined later needs extra date marks and
nothing shows the creator what joined.

### Let a set mix environments

One trust level would write lines of different severity per environment, and "free in staging,
careful in prod" could not be read from the card.
