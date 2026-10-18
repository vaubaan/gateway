---
title: A mission reaches the whole connection when its creator asks for it
status: accepted
date: 2026-10-18
extends:
  - connect-driver-and-resource-curation
  - self-resources-never-reachable-by-a-mission
---

# A mission reaches the whole connection when its creator asks for it

## Context

A mission names, per connection, the resources it may touch (spec §3.1
"Resource selection"). Until now every selection was stored at issuance as an
explicit list of resource ids, `{ scope: 'all' }` included: "all" meant "every
resource known now", and a resource discovered later was not covered until a
new mission was issued.

That is the right default for a task on a known repository or project, and the
wrong one for provisioning and day-to-day operations. Verified on a real
instance: a mission issued on a Fly organisation that had no app yet reached no
app, ever — including the apps that mission created itself (`fly__create_app`,
then `fly__list_apps` answers `[]` and every call on the new app is refused with
`resource-not-in-mission`). Each new resource required a new mission, hence new
keys handed to every holder. Running a live account through the gateway was not
possible.

## Decision

1. **A third resource scope, chosen explicitly at issuance:**
   `{ scope: 'connection' }` — "the whole connection: every resource known now
   and every resource discovered later, except the hidden ones and the
   instance's own". It sits beside `{ scope: 'all' }` ("every resource known
   now", still stored as the explicit list it resolves to) and
   `{ scope: 'selected' }`. The interface words them "Every resource known
   now", "The whole account, including resources found later" and "Only the
   ones I pick". Nothing defaults to the new scope.
2. **Stored as such.** `mission_connections.resource_scope = 'connection'`,
   with no `mission_resources` row. The store refuses ids under that scope, as
   it refuses an empty `selected`. Migration `0018` widens the column's CHECK
   (a rebuild of `mission_connections` and `mission_resources`; no row
   changes).
3. **Resolved at read time, by one function.** What a mission reaches on a
   connection is `reachedResources` (`store/mission-reach.ts`): for scope
   `connection`, the connection's resources that discovery currently returns,
   neither hidden, nor stale, nor the instance's own; for the explicit list,
   the stored ids that are neither stale nor the instance's own (unchanged).
   The three readers — the execution door (`loadMissionContext`), the mission
   page (`MissionService.get`) and the bootstrap kit — call it, so the agent
   is never told it may touch what the door refuses, and a plugin's "list"
   tool that filters on the mission's resources (`fly__list_apps`) sees the
   same live list.
4. **Issuance checks against what is known now.** An env-qualified risk still
   needs a resource known at issuance that carries its label; a scope
   `connection` on a connection whose catalog has env-scoped risks (and whose
   plugin does not derive the environment from the call, and with no default
   environment on the connection — ADR connection-default-environment-label,
   whose default labels later resources) records a notice
   `later-resources-need-env-label`: a resource discovered later reaches
   env-scoped permissions only once it is labelled.
5. **Nothing existing is widened.** Missions issued before keep their stored
   list; `all` keeps its meaning. A duplicated mission keeps its source's
   scope.

## Consequences

- A creator can hand an agent a live account in one mission, with one set of
  keys. The width of such a mission is visible where it is read: the mission
  page and the kit say "the whole account, including resources found later",
  `list_my_missions` names the scope, the `mission-issued` audit entry records
  `resource_scope` per connection.
- "Discovered" means what the connection's resource list holds: a resource the
  mission creates is reached once discovery returns it (the owner's "refresh
  resources" today). Discovery after a creating call is a separate change.
- A hidden resource is not reached under scope `connection` (hiding is the
  owner's way to keep a resource out of "everything"); it stays reachable when
  selected on purpose under `selected`.
- The least-privilege default is unchanged: the form still opens on "every
  resource known now", and the management door's instructions still ask an
  agent to select what the task needs.

## Rejected alternatives

- **Make `all` mean later resources too.** Silently widens every mission
  already issued with `all` — a mission its creator read as "these five
  repositories" would start reaching the sixth. Contrary to "nothing is
  widened silently".
- **A resource created by a mission joins that mission.** A special case at
  the door (who created what, through which call, what if discovery reports it
  under another ref), hard to explain on the mission page, and it still leaves
  out the resources someone else creates on the account the mission operates.
- **Re-issue the mission when a resource appears.** What happens today: it
  forces a key replacement for every holder each time the account grows, which
  is exactly the friction this decision removes.
