---
title: Authority — owners, shares, local groups, orphaned missions, unowned connections
status: current
date: 2026-10-13
last_synced: 2026-10-13
tracks:
  - apps/gateway/src/server/authority/
  - apps/gateway/src/server/shares/
  - apps/gateway/src/server/groups/
  - apps/gateway/src/server/connections/service.ts
  - apps/gateway/src/server/connections/notice-redirect.ts
  - apps/gateway/src/server/execution/door.ts
  - apps/gateway/src/server/auth/login.ts
  - apps/gateway/src/server/store/repositories/shares.ts
  - apps/gateway/src/server/store/repositories/groups.ts
  - apps/gateway/src/app/(app)/connections/[id]/share/
  - apps/gateway/src/app/(app)/connections/[id]/shares/
  - apps/gateway/src/app/(app)/connections/[id]/transfer/
  - apps/gateway/src/app/(app)/shares/
  - apps/gateway/src/app/admin/(guarded)/groups/
  - apps/gateway/src/app/admin/(guarded)/connections/
  - apps/gateway/tests/integration/authority/
  - apps/gateway/tests/integration/store/ownership-and-orphans.test.ts
  - apps/gateway/tests/unit/structural/authority-not-snapshotted.test.ts
  - apps/gateway/tests/e2e/v5/share-and-orphan.spec.ts
---

# Authority — owners, shares, local groups, orphaned missions, unowned connections

How the gateway answers "what may this user accept on this connection, right
now?", and what follows from the answer when it changes: a mission that reads
`orphaned` for as long as its creator's authority is missing (derived, never
stored), and a connection left `unowned` (stored). Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §0 (Group,
Principal, Connection, Share, Restriction), §2.3 (states), §3.1 (the chain),
§4.2 (Connections, Shares received, Administration), §7.2, §7.3, §7.8, §10
(structural: never a snapshot), §11.2 (v1 assumptions). Decision:
[orphaned-missions-and-ownerless-connections](../decisions/orphaned-missions-and-ownerless-connections.md).
Neighbours: [connections](connections.md) (the connection, its statuses, the
credential broker), [missions](missions.md) (issuance checks the authority),
[execution-door](execution-door.md) (the door re-checks it),
[authentication](authentication.md) (groups from claims, the admin rule),
[audit](audit.md), [store](store.md).

## Overview

Authority is never stored. Every answer is computed from three things read in
the store at that moment: the user's status, their group memberships, and the
active shares. Two states depend on that answer; one is derived like it, the
other is stored:

| State                | Meaning                                            | Stored? | Begins                                                   | Ends                                                                                        |
| -------------------- | -------------------------------------------------- | ------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| mission `orphaned`   | its creator does not cover its accepted risks, now | no      | the instant the authority is missing, for every reader   | the instant it is back (never, on a revoked connection); or the creator revokes the mission |
| connection `unowned` | its owner group has no member left                 | yes     | `ConnectionsRepo.markOwnerlessUnowned` (after a removal) | the operator's `reassign`                                                                   |

```
apps/gateway/src/server/authority/
  catalog-authority.ts   fullCatalogRiskIds(), explicitRiskIdsOf()            (pure)
  authority-service.ts   AuthorityService, ConnectionAuthorityService: authorityOf / connectionsOf / gapsOf
  mission-grounds.ts     MissionGrounds: check / inspect / derive / watchConnection / watchCreator; partitionOf()
  derived-missions.ts    derivedMissionReads(missions, grounds): a listing with the derived status
  membership.ts          MembershipSettler.watch() → settle()
  testing.ts             alwaysGrounded (test double for fixtures with no connection or share)
  principals.ts          findActiveUserByEmail(), principalLabel()
  index.ts               createAuthorityModule(deps) → root.authority { service, grounds, membership }
apps/gateway/src/server/shares/
  restriction.ts         groupBySeverity(), selectAllIds(), summarizeRestriction(), envNotes()   (pure, browser-safe)
  service.ts             ShareService: contextFor / share / revoke / received; labellingOf()
  errors.ts              ShareError, SHARE_ERROR_MESSAGES, isShareError()
  handlers.ts            POST /connections/<id>/shares, …/shares/<shareId>/revoke
  index.ts               createSharesModule(deps) → root.shares
apps/gateway/src/server/groups/
  service.ts             GroupService: list / create / addMember / removeMember
  errors.ts              GroupError, GROUP_ERROR_MESSAGES
  handlers.ts            POST /admin/groups/create, …/<id>/members, …/<id>/members/<userId>/remove
  index.ts               createGroupsModule(deps) → root.groups
apps/gateway/src/server/connections/service.ts
                         transferTargets / transfer / listOwnerless / reassign (next to connect, revoke…)
```

The composition root builds `root.authority` first (it reads the store only)
and hands it to the modules that check, derive or watch: `missions`
(`authority.service`, and `authority.grounds` to derive), `requests` and
`execution` (`authority.grounds`, to derive), `connections` and `shares`
(`authority.grounds`, to watch), `groups` and `auth` (`authority.membership`),
`oauth` (its mission listing wrapped by `derivedMissionReads`).

## How it works

### What a user holds on a connection (`ConnectionAuthorityService`)

`authorityOf(user, connection)` → `{ connectionId, provider, basis, riskIds }`:

1. no registered plugin for the provider, or the user is unknown or
   `removed` → `basis: 'none'`, nothing;
2. the user owns the connection — `owner` is that user, or a group the user
   belongs to **now** → `basis: 'owner'`, the provider's full catalog as
   explicit ids (`fullCatalogRiskIds`);
3. otherwise the **union** of the restrictions of the active shares of that
   connection whose target is the user or one of their current groups
   (`SharesRepo.listActiveForTargets(principals, connectionId)`), kept to the
   ids the catalog still lists, in catalog order → `basis: 'share'`;
4. no such share → `basis: 'none'`.

`connectionsOf(user)` is the candidate list of an issuance: owned connections
plus the connections of the shares the user receives, once each.

`gapsOf(user, questions)` is the re-check of an authority already granted
("do these ids of this connection still fall within what the user holds?").
It is the cheap path the door runs on every request:

- one read of the user's status;
- a connection owned in the user's own name costs nothing more;
- the groups are read once per call, and only when some connection is not
  owned in the user's name;
- the shares are read only when the user is not an owner of that connection;
- no catalog is enumerated: the question is whether the authority vanished,
  not whether the catalog still lists the id.

The service has no field but its `deps`, no cache, and never reads the web
session (`login.groups` there is the claim list of the last sign-in, for
display). `tests/unit/structural/authority-not-snapshotted.test.ts` holds that
shape and replays the same question around membership changes.

### Shares (`ShareService`)

A share is `(connection, target, restriction)`; rows `shares` +
`share_restrictions` (one row per `RiskId`, [store](store.md)).

- **Only an owner shares.** Every method starts from
  `ConnectionService.get(actor, id)`, which answers `not-found` to anyone who
  does not own the connection now. A beneficiary therefore cannot share
  further, list or revoke (no transitive sharing, spec §11.2).
- **The restriction is risks only**: no quantity, no gate, no resource.
  `restrictionOf` refuses an empty list (`restriction-empty`) and any id that
  is not an explicit id of the provider's catalog (`risk-unknown`, naming
  them) — a wildcard, a base id of an env-scoped entry, a preset name, a risk
  of another provider. The store checks again (`assertKnownRiskIds`, and the
  `CHECK` of `share_restrictions`).
- **One active share per `(connection, target)`.** `share()` calls
  `SharesRepo.replaceForTarget`: the previous active share of that target is
  revoked and the new one created in one transaction. This is how a
  restriction is edited. Two entries are written when a share is replaced:
  `share-revoked` (with `after.replaced_by`) then `share-created` (with
  `before` = the previous restriction).
- **Targets**: a user by email (`findActiveUserByEmail`: exactly one active
  user, or `target-unknown` / `target-ambiguous`) or a group by id (any group
  of the instance). The owning principal itself is refused (`target-is-owner`).
- Refused on a `revoked` connection (`connection-revoked`) and on an
  `unowned` one (`connection-unowned`; in practice nobody passes the owner
  check there).
- `revoke()` is terminal for the share and idempotent. `share()` and
  `revoke()` both watch the missions of the connection across the act
  (`grounds.watchConnection`): the outcome carries `orphaned` (missions the
  change left ungrounded) and, for `share()`, `restored` (orphaned missions
  the new share covers again — they serve calls from then on). The notice
  says both counts.
- `received(actor)`: the active shares targeting the user or one of their
  current groups, each with `via` (`you` or `group <name>`) and the exact
  restriction; a risk the catalog dropped since is listed with `known: false`.

"Select all" is resolved in the browser: `selectAllIds(risks)` ticks every
explicit id except deprecated entries and the uncategorized-write fallback,
and the form posts one `risk` field per ticked box (`SHARE_FIELDS`). The
server never receives "all"; a risk added to the catalog later is not shared.

`envNotes(risks, selected, labelling)` produces the dialog's warning when
env-qualified risks are ticked on a connection whose plugin does not derive
the environment: which environments no reachable resource carries, and how
many reachable resources have no label (env-qualified risks are refused on
them). `labellingOf(resources, derivesEnv)` builds its input, stale resources
left out.

### Local groups (`GroupService`)

Groups live in `groups` / `group_members`, told apart by `groups.source`:

| `source` | Created by                            | Members changed by                             |
| -------- | ------------------------------------- | ---------------------------------------------- |
| `idp`    | the first sign-in that claims it      | each sign-in (`GroupsRepo.syncIdpMemberships`) |
| `local`  | the operator, Administration → Groups | the operator only; a sign-in never touches it  |

The **merge** is the membership read itself: `GroupsRepo.groupsOf(userId)`
returns both kinds, and that list is what every authority check uses. A claim
whose name is held by a local group is skipped with a warning
([authentication](authentication.md)).

`GroupService` does not authorize: its callers do
(`guardMutation(…, 'operator')` in `groups/handlers.ts`), and pass the audit
actor (`auditActorId(principal)`, so the bootstrap operator is `bootstrap`).

- `create(actorId, name)`: 1–80 characters, no control character
  (`name-invalid`); refused when a group of any source holds the name
  (`name-taken`, `GroupsRepo.createLocal` returns `null`) and when it is the
  group of the admin rule (`name-reserved`).
- `addMember(actorId, groupId, email)`: local groups only (`not-local`), a
  known active user (`user-unknown`, `user-ambiguous`); idempotent. Returns
  `restored`: the orphaned missions of that user the membership grounds again.
- `removeMember(actorId, groupId, userId)`: writes `group-member-removed`.
  Returns `unowned` and `orphaned`.
- Both wrap the edit in `MembershipSettler.watch(userId)` … `settle(actorId)`.

There is no group deletion: a group that owns a connection or receives a
share is referenced by those rows. An emptied group is inert.

The admin rule counts **IdP-claimed** groups only (`currentAuthority` in
`auth/login.ts`): membership of a local group never makes anyone an operator.

### Ownership: transfer, `unowned`, reassignment (`ConnectionService`)

- `transfer(actor, connectionId, groupId)`: the actor owns the connection and
  belongs to the group now (`transfer-not-member` otherwise); refused on a
  `revoked` or `unowned` connection. `ConnectionsRepo.transferOwner`, entry
  `connection-transferred` (`before.owner`, `after.owner`), inside a watch of
  the connection's missions (members of a previous owner group who are not in
  the new one lose their authority; members of the new one gain it). Shares
  are kept.
  `transferTargets(actor, connection)` lists the groups offered.
- A connection becomes `unowned` when `ConnectionsRepo.markOwnerlessUnowned()`
  finds it `active` with an owner group that has no member. That method is
  called by the settlement of `MembershipSettler.watch`, i.e. after every membership
  removal the gateway performs: the operator removing a member of a local
  group, and each sign-in (which may have dropped IdP-sourced memberships).
- An `unowned` connection **keeps serving** ([connections](connections.md),
  "Status and credential"). Missions still grounded — those of share
  beneficiaries — keep running; missions that were grounded on membership of
  the emptied group are orphaned from that instant, and audited by the same
  settlement. Nobody passes the
  owner check, so nobody shares, reconnects, transfers or revokes.
- A member joining the group again does not bring the connection back: it
  stays `unowned` until the operator decides.
- `listOwnerless()` / `reassign(operatorId, connectionId, newOwner)` are the
  operator's only act on the domain. Ownerless means `unowned`, or not
  revoked with an empty owner group (an `unowned` connection whose credential
  died is `expired`, and still ownerless). `reassign` refuses a connection
  that has an owner (`not-ownerless`), an unknown user (`owner-unknown`) and a
  group without member (`owner-group-empty`); `ConnectionsRepo.assignOwner`
  sets the owner and turns `unowned` back to `active` (an `expired` one stays
  `expired` for its new owner to reconnect); entry `connection-reassigned`.
  The missions the emptied group had left orphaned serve again when their
  creator is the new owner or a member of the new owner group
  (`mission-restored`, actor: the operator).

### Orphaned missions (`MissionGrounds`)

`orphaned` is **derived from the creator's current authority on every read
and never stored** (spec §2.3; ADR amendment of 2026-10-13). The `missions`
row of an orphaned mission says `active`; migration `0007` makes the table
refuse the value ([store](store.md)). When the authority comes back the same
mission serves calls again, with the same token, session and counters. A
revoked connection never comes back, so its missions stay orphaned.

`check(mission)` returns `{ grounded: true }` or the first cause it meets:

| Cause                | When                                                                                | Can it end?                                           |
| -------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `connection-missing` | a connection of the mission no longer exists                                        | no                                                    |
| `connection-revoked` | a connection of the mission is `revoked`                                            | no: revocation is terminal                            |
| `creator-removed`    | the creator is unknown or `removed`                                                 | when the account is active again                      |
| `authority-lost`     | `gapsOf` finds accepted risks the creator no longer covers (`uncovered` lists them) | when a share or a membership covers every one of them |

Each connection is asked about its own partition of the policy:
`partitionOf(mission, provider)` keeps the accepted ids whose provider is the
connection's. An `expired` or `unowned` connection removes no authority and
does not orphan.

**Readers.** `inspect(mission)` → `{ mission, orphan }` is the mission as a
reader must see it: `status: 'orphaned'` in place of `active` when the verdict
is ungrounded, with the reason (`cause`, `connectionId`, `uncovered`);
`derive(mission)` is the same without the reason. A mission the store holds as
`revoked` or `expired` is returned as it is, without a read. Nothing is
written, and no administrative entry: no human is behind a read.

| Reader                                                             | Call                                                                            |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| the execution door, every request                                  | `grounds.inspect` (`execution/door.ts`)                                         |
| `MissionService`: list, detail, session page, gate, rotate, revoke | `grounds.inspect` (`ownInspected`, `list`)                                      |
| `RequestService`: view, claim and approval decisions               | `grounds.derive` (`own`)                                                        |
| the Delegations listing                                            | `derivedMissionReads(store.missions, grounds)`, wrapped by the composition root |

A record loaded from `store.missions` carries the **stored** status. A new
reader that shows or decides on the status must go through `inspect` /
`derive`; `tests/unit/structural/authority-not-snapshotted.test.ts` lists the
production files that load a mission record and fails on a new one until it is
classified.

While orphaned: every call is refused `mission-inactive` (`status: orphaned`),
no gate is edited and no token rotated (`inactive`), no claim or approval is
granted (`mission-closed`; a refusal can still be recorded), and the creator
can still revoke — stored, terminal. `/missions/<id>` shows the reason and
whether it can come back ([missions](missions.md)).

**Audit: a watch around each human act.** With nothing stored, "this act
orphaned that mission" is a difference between two verdicts. The services take
the verdicts before the act and compare after it:

```ts
const watch = await grounds.watchConnection(connectionId); // or watchCreator(userId)
// …the act: a share revoked, a member added, a connection reassigned…
const { orphaned, restored } = await watch.settle(actorId);
```

`settle` lists the missions again (one revoked meanwhile is left out; one
issued meanwhile was not watched) and writes, naming `actorId`:

- `mission-orphaned` for a mission grounded before and not after —
  `before: { status: 'active' }`, `after: { status: 'orphaned', cause,
connection_id, uncovered }`;
- `mission-restored` for a mission orphaned before and grounded after —
  `before: { status: 'orphaned', cause, connection_id, uncovered }`,
  `after: { status: 'active' }`.

| Act                                                | Watch                              | Orphans | Restores | Actor                  |
| -------------------------------------------------- | ---------------------------------- | ------- | -------- | ---------------------- |
| `ShareService.share` (new, or replacing)           | `watchConnection`                  | yes     | yes      | the owner              |
| `ShareService.revoke`                              | `watchConnection`                  | yes     | —        | the owner              |
| `ConnectionService.revoke`                         | `watchConnection`                  | yes     | —        | the owner              |
| `ConnectionService.transfer`                       | `watchConnection`                  | yes     | yes      | the owner              |
| `ConnectionService.reassign`                       | `watchConnection`                  | yes     | yes      | the operator           |
| `GroupService.addMember` / `removeMember`          | `MembershipSettler.watch` (member) | yes     | yes      | the operator           |
| a sign-in (`completeLogin`, around the group sync) | `MembershipSettler.watch` (user)   | yes     | yes      | the user who signed in |

The watch holds verdicts for the length of one act, for the audit only: no
reader sees them. The watch and the act are not one transaction, so two
concurrent acts on one mission may both record the same change; the state
itself is never wrong, only an attribution can be doubled. A change made by a
path no service watched (a repair in the database, a future import) is seen
by every reader at once and has no administrative entry: the two acts of a
mission need not come in pairs.

`MembershipSettler.watch(userId)` → `settle(actorId)` also runs
`ConnectionsRepo.markOwnerlessUnowned()` (the one stored state here) and
returns `{ unowned, orphaned, restored }`.

### The door

`ExecutionDoor.credentialResolver` (`execution/door.ts`) calls
`grounds.inspect(verified.mission)` between the token verification and
`loadMissionContext`, on every request (`tools/list`, `tools/call`, the
catalog endpoint). The pipeline's `checkMissionActive` then refuses an
orphaned mission with `mission-inactive`, `status: 'orphaned'`; the refusal's
hint tells the agent that the same token works again once the authority is
back. The door logs `mission orphaned at the execution door` (info: `cause`,
`connection_id`, `uncovered`) and writes no administrative entry, in either
direction. `grounds` is a required dependency of the door and of
`createExecutionModule`.

Measured cost of `inspect` (`tests/integration/authority/door-latency.bench.test.ts`,
`:memory:` store, mean over 20 000 calls on a shared development machine;
`VAUBAAN_BENCH=1 npx vitest run <that file>`):

| Mission grounded on     | P2.2 (`settle`, stored) | P2.2b (`inspect`, derived) | Share of an in-process `tools/call` |
| ----------------------- | ----------------------- | -------------------------- | ----------------------------------- |
| owner, user-owned       | 19.2 µs                 | 16.8–18.1 µs               | ~2 %                                |
| owner through a group   | 21.1 µs                 | 19.3–20.6 µs               | ~3 %                                |
| a share made to a group | 43.9 µs                 | 42.5–45.3 µs               | ~5 %                                |

The cheap path is the same (`gapsOf`: one to three indexed reads, no catalog
enumerated); the orphan path lost its write. The share path compiles its
`listActiveForTargets` statement once per SQL shape (`activeStatements` in
`store/repositories/shares.ts`).

### Sign-in

`completeLogin` (`auth/login.ts`) calls `deps.membershipsChanging?.(user)`
**before** `syncIdpGroups` and the function it returns **after** it; the root
wires the pair to `authority.membership.watch(user.id)` and
`watch.settle(user.id)`. A sign-in whose claims omit a group therefore writes
`mission-orphaned` under the user's own name, and the next sign-in that
carries the group again writes `mission-restored`: an IdP that drops a group
for one sign-in (a group overage claim above the IdP's limit, a mapping edited
by mistake) costs refusals until the next sign-in, not the missions. A failure
of either call is logged and does not fail the sign-in: every reader derives
the state anyway.

## How to use it

### Pages and routes

| Path                                                                            | What                                                                                     | Guard    |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------- |
| `/connections/<id>`                                                             | "Shares" card (target, restriction on demand, Edit, Revoke), "Ownership" card (transfer) | owner    |
| `/connections/<id>/share[?share=<id>]`                                          | the Share dialog (`share-form.tsx`, client)                                              | owner    |
| `POST /connections/<id>/shares`                                                 | `shares.handlers.share`                                                                  | user     |
| `POST /connections/<id>/shares/<shareId>/revoke`                                | `shares.handlers.revoke`                                                                 | user     |
| `POST /connections/<id>/transfer`                                               | `connections.handlers.transfer` (`group_id`)                                             | user     |
| `/shares`                                                                       | Shares received                                                                          | user     |
| `/admin/groups`                                                                 | groups, members                                                                          | operator |
| `POST /admin/groups/create`, `…/<id>/members`, `…/<id>/members/<userId>/remove` | `groups.handlers.*`                                                                      | operator |
| `/admin/connections`                                                            | connections without owner                                                                | operator |
| `POST /admin/connections/<id>/reassign`                                         | `connections.handlers.reassign` (`owner_kind`, `owner_email` / `owner_group`)            | operator |

Every POST is a form post answered by a `303` to a page with `?notice=<id>`
(`createNoticeRedirect`, the connections' `NoticeStore`).

### From code

```ts
const { service, grounds, membership } = root.authority;
const held = await service.authorityOf(user, connection); // { basis, riskIds }
const verdict = await grounds.check(mission); // { grounded } | { cause, … }
const { mission: seen, orphan } = await grounds.inspect(stored); // seen.status may be 'orphaned'
await root.shares.service.share(actor, connectionId, {
  target: { kind: 'user', email: 'colleague@example.com' },
  riskIds: ['github.read-code', 'github.read-meta'], // explicit ids, never "all"
});
```

A page that catches a service error matches it by shape (`isShareError(err,
'not-found')`, `isConnectError(err, 'not-found')`), not by `instanceof`
([web-app](web-app.md), "One root, several module graphs").

### Tests

| File                                                      | Covers                                                                                                                                          |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/authority/authority-service.test.ts`          | owner, union of shares, per-connection subsets, `gapsOf`, cheap path                                                                            |
| `src/server/authority/mission-grounds.test.ts`            | every cause, partition, `inspect` / `derive`, watches, `MembershipSettler`, `derivedMissionReads`                                               |
| `src/server/missions/orphan-reason.test.ts`               | the sentences of the mission page, per cause                                                                                                    |
| `src/server/shares/*.test.ts`                             | restriction helpers, share service, error shape                                                                                                 |
| `src/server/groups/service.test.ts`                       | local groups, admin rule and local groups, `findActiveUserByEmail`                                                                              |
| `tests/integration/authority/share-and-orphan.test.ts`    | share → issue within R1 → exceed → revoke → orphaned → refused; lose → regain: same token, session, counters; revoked connection stays orphaned |
| `tests/integration/authority/ownership.test.ts`           | transfer, unowned, reassignment (restores), a group claim missing at one sign-in then back at the next                                          |
| `tests/integration/authority/handlers.test.ts`            | the form posts and their notices                                                                                                                |
| `tests/integration/store/ownership-and-orphans.test.ts`   | the repository transitions; migration `0007` (reset, triggers)                                                                                  |
| `tests/unit/structural/authority-not-snapshotted.test.ts` | spec §10: no state in the module, every check follows the store; no stored orphan verdict, every reader of a mission record classified          |
| `tests/e2e/v5/share-and-orphan.spec.ts`                   | the dialog, Shares received, revocation, restoration by a new share, the ownership loop (browser)                                               |

## How to debug

- **A mission answers `mission-inactive` / `orphaned`.** Its page
  (`/missions/<id>`) shows the cause as of that page load, the connection and
  the uncovered risks; `grounds.check(mission)` gives the same. Audit → the
  mission: a `mission-orphaned` entry names the act and its author. No entry
  means no service watched the change: the instance log has `mission orphaned
at the execution door` with the same fields. Do not look for `orphaned` in
  the `missions` table: the row is `active`.
- **A mission should be back and is not.** `orphan.uncovered` on its page
  lists what is still not covered: a new share must cover **every** accepted
  risk of the mission on that connection, and a share made to a group reaches
  the creator only while `groupsOf(user)` lists the group — IdP groups change
  at sign-in only. `connection-revoked` never ends.
- **A mission came back that the owner did not expect.** Sharing again to the
  same person restores the missions that fit inside the new share (the notice
  counts them, and each has a `mission-restored` entry). The creator, not the
  owner, revokes a mission; the owner narrows or revokes the share.
- **A beneficiary cannot tick a risk at issuance.** It is outside
  `authorityOf`: compare `/shares` (what they received, each `via`) with the
  owner's "Shares" card. A share made to a group reaches them only while
  `groupsOf(user)` lists the group.
- **"Not shared: … not in this provider's catalog".** The form posted an id
  that is not an explicit id (`ShareError('risk-unknown', detail)` lists
  them): env-scoped entries are shared as `provider[env].name`.
- **A connection vanished from its owners' list.** Its status is `unowned`
  (or its owner group is empty): Administration → Connections lists it.
  Log line `connection has no owner left`.
- **A user in the admin group is not an operator.** A local group holds the
  rule's name, so the IdP claim is skipped (log: `IdP group claim collides
with a local group`), and local membership does not count.
- **A sign-in orphaned missions.** The claims no longer list a group: the
  `mission-orphaned` entries name the user themselves as actor. Nothing is
  lost: once the IdP sends the group again, the user signs in and the same
  missions serve (`mission-restored`).

## Extension

- **A new basis of authority** (for instance a time-boxed grant): add it to
  `authorityOf` and to `gapsOf` together — the first decides issuance, the
  second decides whether issued missions stay grounded — and extend
  `AuthorityBasis`.
- **A new act that can remove or return an authority** takes the matching
  watch before it and settles it after, and is classified in
  `tests/integration/audit/admin-mutations.test.ts`. Forgetting the watch
  loses an audit entry, never the state.
- **A new reader of a mission's status** goes through `grounds.inspect` or
  `grounds.derive`, and is classified in `MISSION_READERS` of the structural
  test.
- **Hosted deployment**: nothing here is process state. `gapsOf` costs one to
  three indexed reads per request; a shared cache in front of it would be the
  snapshot the spec forbids.

## Not built here

- Closing an orphaned mission by an owner of the connection (spec §2.3): the
  creator closes it with the mission's "Revoke"; an orphaned mission already
  refuses everything. An owner who wants it never to serve again revokes the
  connection, or does not share again.
- An audit entry for a change of authority that no service performed (the
  door sees it and refuses or serves; nobody is named).
- Deleting a group.
- `users.status = 'removed'` is honoured (no authority, missions orphaned
  from that instant) but nothing sets it yet: there is no deprovisioning feed
  from the IdP.
