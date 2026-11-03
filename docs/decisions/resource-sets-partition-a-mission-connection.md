---
title: A mission connection is partitioned into resource sets, each with its own policy and budget
status: accepted
date: 2026-11-01
author: Renaud Pelissier
---

# A mission connection is partitioned into resource sets, each with its own policy and budget

## Context

A mission holds one policy per connection, so an agent trusted on staging is trusted the same way
on production unless the catalog qualifies the risk by environment, and environment labels are the
owner's, not the creator's. Creators want to give one agent, on one account, different trust levels
on different resources (staging Autonomous, prod Careful) without issuing two missions.

## Decision

Each connection of a mission holds one or more **resource sets**; a resource belongs to exactly one
set of that connection, and each set carries its own explicit policy, trust levels and budget
counters. A call is judged against the sets of the resources its slices name (the same rule as
environment resolution, risk model §6); a call naming none, or resources of several sets, is judged
against every candidate set: each touched risk must be accepted in every one, the most restrictive
gate applies, and each set's budget is charged.

## Consequences

- The policy, the session counters, approvals and audit rows are keyed by resource set, not by
  mission alone; a mission with one set per connection behaves exactly as before.
- What cannot be placed in one set never gets the wider set's rights: the strictest candidate wins.
- Environment resolution still reads the resources of the whole connection; the set only picks the
  policy.
- A set is a partition of the mission's selection: one environment, an explicit list, and
  optionally the resources that appear there later
  ([resource-set-is-one-environment-with-optional-future-resources](resource-set-is-one-environment-with-optional-future-resources.md)).

## Rejected alternatives

### Two missions, one per resource group

Two tokens to hand to one agent, two budgets to read, and the agent must pick the right token per
call.

### Refuse a call that cannot be placed in one set

Simpler to explain, but blocks every account-level tool (listing projects, the account's own
settings) as soon as a mission has two sets.

### A resource in several sets

Overlapping sets make each call's policy depend on the strictness rule even when the call names one
resource; one set per resource keeps the common case unambiguous.
