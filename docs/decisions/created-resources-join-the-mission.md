---
title: What a mission creates, it reaches
status: accepted
date: 2026-10-24
extends:
  - mission-reaches-the-whole-connection-on-request
  - discovery-runs-after-a-creating-call
  - connection-default-environment-label
---

# What a mission creates, it reaches

## Context

A mission names, per connection, the resources it may touch (spec §3.1
"Resource selection"). Under the scopes `all` and `selected` that is a list of
resource ids stored at issuance; only scope `connection` follows the resources
discovery finds later (ADR
[mission-reaches-the-whole-connection-on-request](mission-reaches-the-whole-connection-on-request.md)).
Since ADR
[discovery-runs-after-a-creating-call](discovery-runs-after-a-creating-call.md),
a call of a tool a plugin lists in `resourceCreatingTools` (`fly__create_app`,
`miro__board_create`) makes the host run the connection's discovery again, off
the request path, so the new resource joins the connection's list.

Two gaps remained, both verified on a real instance on 2026-10-24:

1. **A mission with an explicit list never reaches what it created.** A Miro
   mission holding the right to create boards (`miro.board-create`) created a
   board; every call on it was refused. The first ADR rejected "a resource
   created by a mission joins that mission" as a special case hard to
   explain; in practice the opposite is what is hard to explain: the mission
   was _allowed_ to create the board and cannot write on it.
2. **Discovery may not list a resource created a moment ago.** The Miro
   refusal came from the plugin itself (`board: board 'X' is not a board of
this mission.`): the board was not even known to the connection. Miro's
   board search did not return it at 2 s nor at 10 s (the retries of the
   discovery after call), and two minutes later the mission's
   `miro__list_boards` still did not list it. Worse, once discovery runs and
   does not return a row, the row is marked stale — and a stale row is reached
   by no mission.

The call's own answer says what was created: Miro answered
`{"miro_url":"https://miro.com/app/board/uXjVEVgYKSE=/","name":"…"}`; Fly, Resend
and Upstash answer the new object with its id.

## Decision

The owner reversed the rejected alternative: **a mission that holds the right
to create a resource reaches the resource it created, right away, whatever its
resource scope.**

1. **The plugin reads its own answer.** A new optional hook
   `ProviderPlugin.createdResources?(tool, args, result): readonly Resource[]`
   — pure, no IO — returns the resource(s) a successful call of one of its
   `resourceCreatingTools` created, described exactly as `discoverResources`
   would describe them (ref, display name, metadata), and `[]` when it cannot
   read the answer. The answer is untrusted: a ref is read through the same
   grammar discovery uses (Miro: the board-id grammar of `boardIdOfUrl` /
   `boardRefOf`). `definePlugin` refuses a plugin that declares
   `resourceCreatingTools` without the hook; every shipped creating tool
   implements it.
2. **The host records it on the request path, before the answer leaves.** For
   an `allowed` call whose result is not `isError`, of a tool in the plugin's
   `resourceCreatingTools`, the execution door's after-call step (`afterCall`,
   now awaited):
   1. calls `createdResources` and keeps the resources of that provider with a
      usable ref, never one of the instance's own (`isSelfResource`);
   2. **upserts** them into the connection's resources
      (`ConnectionsRepo.upsertDiscoveredResources`): a new ref is inserted —
      unlabelled, so it inherits the connection's default environment on read
      (ADR connection-default-environment-label) — a known ref has its stale
      flag cleared and its provider facts merged in, owner edits kept; no
      other row is touched;
   3. **adds the rows to the mission's selection**
      (`MissionsRepo.addResources(missionId, connectionId, ids, 'created')`)
      when the mission's scope on that connection is an explicit list; an
      `all` that stored nothing becomes `selected`; a no-op under scope
      `connection`, which already reaches the row through `reachedResources`;
   4. writes one admin audit entry `mission-resources-added`, cause
      `created-by-the-mission`, with the mission, the connection, the tool and
      the refs (never the arguments); actor: the human behind the call's key,
      as for the discovery after a call;
   5. then schedules the discovery after the call as before, told which refs
      were created: it looks again (2 s, 10 s) while discovery does not return
      them, then gives up — nothing more.

   A failure in 1–4 is logged (connection id, tool, mission; never the
   arguments) and never changes the call's outcome. The agent's answer waits
   for local SQLite writes only (the resource row, the mission row, the audit
   entry).

3. **Where the selection row came from.** `mission_resources.source` (migration
   `0024`): `issuance` (every row before this decision), `created` (added by
   this step) or `edit` (reserved for the creator's "Edit mission", built in
   parallel). The mission page marks a resource "created by this mission".
4. **A fresh row is not staled at once.** `syncDiscoveredResources` does not
   mark stale a row first seen less than `FRESH_RESOURCE_STALE_GRACE_MS`
   (15 minutes) ago — `connection_resources.first_seen_at`, set at insert and
   again when a stale row comes back. Past the grace, a ref discovery still
   does not return is stale as before.
5. **Agent-facing words.** The `resource-not-in-mission` hint of an explicit
   scope, the bootstrap kit, the issuance form's explanation of "Every
   resource known now", the management door's instructions and Miro's own
   refusal of an unknown board say: a resource the mission creates through
   the gateway is reached right after its creation; one created elsewhere
   needs the mission's creator to add it, or a mission on the whole account
   (after the owner's refresh).

## Consequences

- Creating then using works in one mission with a narrow selection:
  `miro__board_create`, then every call on the new board, from the next call
  on — no new mission, no new keys, no human.
- A mission widens itself only by what it was allowed to create, and only by
  the resources the plugin reads from the call's answer; the audit says when,
  through which tool, and the mission page shows it. A mission still never
  reaches a resource someone else created.
- The created resource is a resource of the connection for every other mission
  and the owner's page, as discovery would have made it; the owner may hide,
  rename or label it as any other.
- A plugin that adds a creating tool must read its answer, or `definePlugin`
  refuses it; an answer the plugin cannot read (`[]`) leaves the behaviour of
  ADR discovery-runs-after-a-creating-call: a whole-connection mission
  reaches the resource once discovery lists it, an explicit list does not.
- Railway's `create-project` is forwarded to Railway's own MCP server, whose
  answer is not documented: the plugin reads a project only from a JSON answer
  that names the project it asked for; a text answer yields `[]`.
- Fly's `POST /apps` answers the app id only: the resource carries the app id
  and the name the call asked for; the organization and the allowed image
  prefixes come with the discovery that follows a moment later (a deploy on
  the new app before it is refused with "refresh the account's resources").
- A row first seen within the last 15 minutes survives a discovery that does
  not return it; a resource deleted at the provider within that window stays
  listed until the next discovery past it. Calls on it fail at the provider.
- The answer of a creating call is delayed by three local writes (resource row,
  selection row, audit entry), each a single SQLite statement or transaction.

## Rejected alternatives

- **Wait for discovery on the request path.** Slows the creating call by a
  whole discovery and still fails when the provider lists the new resource
  late (Miro: more than two minutes).
- **Let the plugin write the row itself.** Gives plugins a write path into the
  store; the host keeps the one merge (`upsertDiscoveredResources` next to
  `syncDiscoveredResources`) and the plugin stays pure.
- **Reach every resource created on the account.** That is scope
  `connection`, chosen explicitly at issuance; a narrow mission must not start
  reaching what another mission or a person created.
- **Infer the created ref from the arguments only.** Wrong for every provider
  that names the object itself (Miro board ids, Resend and Upstash ids); the
  arguments are used only where the provider's name _is_ the ref and its
  answer confirms the creation (Fly's app name, with the id it answered).
- **Keep stale marking immediate.** A resource created seconds ago and not yet
  listed would be marked stale by the very discovery its creation scheduled,
  and dropped from the mission that created it.
