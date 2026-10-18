---
title: Discovery runs again after a call that creates a resource
status: accepted
date: 2026-10-18
extends:
  - mission-reaches-the-whole-connection-on-request
  - connect-driver-and-resource-curation
  - connection-default-environment-label
---

# Discovery runs again after a call that creates a resource

## Context

Since ADR [mission-reaches-the-whole-connection-on-request](mission-reaches-the-whole-connection-on-request.md),
a mission issued on "the whole account" reaches every resource the
connection's discovery returns, resources found later included. But discovery
ran only at connect time and when the owner clicked "Refresh" on the account
page. Verified on a real instance: an agent calls `fly__create_app` through its
mission, the app exists at Fly, and the mission's next `fly__list_apps` still
answers an empty list — every call on the new app is refused — until a human
refreshes. The whole-account mission was meant for exactly this provisioning
work, and the gap made it unusable without a person watching.

The gateway knows when this happens: the call went through its execution door,
was allowed, and the plugin returned a result. What it did not know is _which_
calls create something the connection lists as a resource. Five shipped tools
do, across four plugins:

| Plugin          | A resource is       | Creating tools                                    |
| --------------- | ------------------- | ------------------------------------------------- |
| `fly`           | an app of the org   | `fly__create_app`                                 |
| `railway`       | a project           | `railway__create-project`                         |
| `resend`        | a domain, a segment | `resend__create_domain`, `resend__create_segment` |
| `upstash-redis` | a Redis database    | `upstash_redis__create_database`                  |

Everything else either has no creating tool (Cloudflare DNS has no zone
creation, GitHub no repository creation, Vercel's `deploy_to_vercel` acts on a
project already in the mission, Supabase/Stripe/Miro/Notion create objects
_inside_ a resource) or lists a single fixed resource (Context7, Gmail, SSH).

## Decision

1. **The plugin declares it.** `ProviderPlugin.resourceCreatingTools?:
readonly string[]` — the MCP tools whose success creates something
   `discoverResources` will return as a new ref. Typed, next to the other
   per-tool declarations (`tokenHandouts`, `secretArguments`, `unboundTools`);
   `definePlugin` refuses a name that is not an MCP tool of the plugin, a
   duplicate, or an empty list. A tool that creates something inside a
   resource (a DNS record in a zone, a machine in an app) is not one. The four
   plugins above declare their five tools; a structural test of the
   application pins the table, so adding a creating tool is a reviewed change.
   The host never guesses from tool names, slices or risk ids.
2. **The door hands every allowed call it answered to a hook**
   (`ExecutionDoorDeps.afterCall`), before the answer leaves and without
   waiting. `DiscoveryAfterCall` (connections module) schedules a discovery of
   the call's connection when, and only when, the outcome is `allowed`, the
   plugin's result is not `isError` (a call the plugin declined), and the tool
   is in its plugin's `resourceCreatingTools`. A refused, rejected or failed
   call schedules nothing. A connection that is revoked or expired by the time
   the discovery starts is skipped.
3. **Off the request path.** The discovery starts on a later turn of the event
   loop; the agent's answer never waits for it. A failure is logged with the
   connection id, the tool and the mission — never the arguments — and never
   changes the call's outcome.
4. **One merge.** It goes through `ConnectionService.discoverAfterCall`, which
   shares `rediscover` with the owner's "Refresh": the same broker refresh on a
   rejected credential, the same `syncDiscoveredResources` merge (owner names,
   labels, hidden flags and owner metadata kept; a missing ref marked stale, not
   deleted), the same `metadata.discovery` record. New rows inherit the
   connection's default environment through the repository's read (ADR
   connection-default-environment-label).
5. **Coalesced, bounded.** Per connection, one discovery in flight and at most
   one queued (the latest cause wins): a burst of creations is two discoveries,
   not one per call. A discovery that failed, or that found no new ref (a
   provider that lists a new resource a moment after creating it), is run again
   after 2 s and after 10 s, then given up. Single process, like the broker's
   refresh lock; `root.close()` waits for the discovery in flight and drops the
   queued one.
6. **Visible.** `metadata.discovery.afterCall = { missionId, tool }` on a
   discovery the gateway ran itself; the account page says "· after a call of
   `fly__create_app`" beside "Last checked" and "Found …". The audit reuses
   `resources-discovered` (one entry per scheduled discovery, not per attempt)
   with `after.cause`: `by-owner` for "Refresh", `after-a-call` with
   `mission_id`, `tool`, `added`, `attempts`. Its actor is the human behind the
   call's key: the member for a member key, the mission's creator for a named
   key. Activity shows "refreshed what an account reaches · after a call that
   created one".
7. **Agent-facing.** The bootstrap kit of a whole-account mission and the
   `resource-not-in-mission` hint on such a mission say that a resource created
   through the gateway is reached right after its creation, and one created
   elsewhere once the owner refreshes.

The discovery runs whatever the mission's resource scope: the connection's
resource list is shared, and the owner's page benefits too. Only a
whole-account mission _reaches_ the new resource without being edited; a
mission with an explicit list still needs its creator to add it.

## Consequences

- Provisioning through a whole-account mission works without a human:
  `fly__create_app`, then `fly__list_apps` and every call on the new app, from
  the next call on (a moment after the answer; the agent may retry a call sent
  at the same instant as the creation's answer).
- One provider discovery per creating call at most (fewer under bursts, up to
  three on a provider slow to list). Discovery costs a few list requests
  (Fly: one paged `GET /apps`); the creating tools are rare and gated by their
  own risk, so the cost is bounded by the mission's budget on that risk.
- A resource created _outside_ the gateway (in the provider's console) is still
  found only by the owner's "Refresh"; nothing polls.
- A plugin author who adds a creating tool declares it, or the new resource
  waits for a refresh as before; the structural test makes the omission a
  review question rather than a silent gap.
- Railway's agent tool (`railway__railway-agent`) acts on a free-text request
  and may create a project; its effect is not known in advance, so it is not
  declared, and such a project waits for a refresh.
- A hosted deployment with several processes would run one discovery per
  process and connection (`// single-process only`), as for the credential
  refresh.

## Rejected alternatives

- **Refresh on every call.** Doubles the provider traffic of every mission for
  the rare call that creates something, and runs into provider rate limits
  (Fly, Railway, Notion's search) on busy missions.
- **Refresh on a schedule.** A resource stays unreachable for up to one period
  after its creation (the latency this decision removes), and every connection
  pays the discovery cost whether anything changed or not.
- **Let the plugin insert the resource row from the call's answer.** Bypasses
  the one merge (`syncDiscoveredResources`: owner labels, hidden flags, stale
  handling, default environment), duplicates what discovery already knows how to
  build (metadata, display names, the checks Fly's discovery makes on the
  organization), and gives plugins a write path into the store.
- **Refresh on the request path** (before answering the creating call). Slows
  the agent by a whole discovery — seconds on large accounts — and turns a
  discovery failure into a question about the call's outcome.
- **Infer creating calls from names or slices** (`create_*`, a `.W` slice on
  the resource entity). Wrong both ways: `supabase__create_bucket` and every
  Miro `create_*` create objects _inside_ a resource, `railway__create-project`
  does not follow the pattern of the others, and a slice says what is touched,
  not what appears.
