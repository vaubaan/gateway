---
title: Authority — owners, shares, local groups, orphaned missions, unowned connections
status: current
date: 2026-10-13
last_synced: 2026-10-13
tracks:
  - apps/gateway/src/server/authority/
  - apps/gateway/src/server/shares/
  - apps/gateway/src/server/groups/
  - apps/gateway/src/server/users/service.ts
  - apps/gateway/src/server/missions/mission-service.ts
  - apps/gateway/src/server/missions/team-service.ts
  - apps/gateway/src/server/store/membership.ts
  - apps/gateway/src/server/connections/service.ts
  - apps/gateway/src/server/connections/notice-redirect.ts
  - apps/gateway/src/server/execution/door.ts
  - apps/gateway/src/server/auth/login.ts
  - apps/gateway/src/server/store/repositories/shares.ts
  - apps/gateway/src/server/store/repositories/groups.ts
  - apps/gateway/src/server/store/repositories/connections.ts
  - apps/gateway/src/app/(app)/connections/[id]/share/
  - apps/gateway/src/app/(app)/connections/[id]/shares/
  - apps/gateway/src/app/(app)/connections/[id]/transfer/
  - apps/gateway/src/app/(app)/shares/
  - apps/gateway/src/app/admin/(guarded)/groups/
  - apps/gateway/src/app/admin/(guarded)/connections/
  - apps/gateway/tests/integration/authority/
  - apps/gateway/tests/integration/store/ownership-and-orphans.test.ts
  - apps/gateway/tests/integration/store/audit-guarded-append.test.ts
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
(structural: never a snapshot), §11.2 (v1 assumptions). Decisions:
[orphaned-missions-and-ownerless-connections](../decisions/orphaned-missions-and-ownerless-connections.md),
[share-to-a-current-owner-refused](../decisions/share-to-a-current-owner-refused.md),
[operator-deactivates-a-user](../decisions/operator-deactivates-a-user.md),
[one-membership-rule-checked-in-the-token-insert](../decisions/one-membership-rule-checked-in-the-token-insert.md)
(who is on a mission; what a reactivation closes first).
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

| State                | Meaning                                                               | Stored? | Begins                                                                                | Ends                                                                                        |
| -------------------- | --------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| mission `orphaned`   | its creator does not cover its accepted risks, now                    | no      | the instant the authority is missing, for every reader                                | the instant it is back (never, on a revoked connection); or the creator revokes the mission |
| connection `unowned` | its owner group has no member left, or its owner user was deactivated | yes     | `ConnectionsRepo.markOwnerlessUnowned` (after a membership removal or a deactivation) | the operator's `reassign`                                                                   |

```
apps/gateway/src/server/authority/
  catalog-authority.ts   fullCatalogRiskIds(), explicitRiskIdsOf(), uncoveredRisks()   (pure, browser-safe)
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
  errors.ts              GroupError, GROUP_ERROR_MESSAGES, GROUP_NAME_MAX_LENGTH
  handlers.ts            POST /admin/groups/create, …/<id>/members, …/<id>/members/<userId>/remove
  index.ts               createGroupsModule(deps) → root.groups
apps/gateway/src/server/connections/service.ts
                         transferTargets / transfer / listOwnerless / reassign (next to connect, revoke…)
```

The composition root builds `root.authority` first (it reads the store only)
and hands it to the modules that check, derive or watch: `missions`
(`authority.service`, and `authority.grounds` to derive), `requests` and
`execution` (`authority.grounds`, to derive), `connections` and `shares`
(`authority.grounds`, to watch; `shares` also `authority.service`, to ask who
owns a connection now), `groups`, `users` and `auth` (`authority.membership`),
`oauth` (its mission listing wrapped by `derivedMissionReads`). The management
door receives no part of it: it is handed `missions.service` as a port
(`compose/management.ts`) and reads every mission through it.

`catalog-authority.ts` holds the two rules every other file reuses instead of
restating them. **The enumeration** (`explicitRiskIdsOf` / `fullCatalogRiskIds`,
spec §3.1): the catalog view of the pages (`missions/catalog-view.ts`,
`enumerateCatalog`) is a projection of it, and a share restriction is validated
against it, so the ids a page shows, the ids a share may carry and the ids an
authority returns are one list by construction. **Monotonicity**
(`uncoveredRisks(authority, requested)`, "asked minus held"): issuance sorts a
draft's lines with it (`missions/preview.ts`, `classifyLines`) and `gapsOf`
names what a share no longer covers with it.

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

- **Only an owner shares.** `contextFor`, `share` and `revoke` go through
  `ConnectionService.get(actor, id)` (`owned`; `revoke` after loading the
  share), which answers `not-found` to anyone who does not own the connection
  now. A beneficiary therefore cannot share further, list or revoke (no
  transitive sharing, spec §11.2); `received` is the only read open to them.
- **The restriction is risks only**: no quantity, no gate, no resource.
  `restrictionOf` refuses a connection whose provider has no registered plugin
  (`provider-unknown`), an empty list (`restriction-empty`) and any id that
  is not an explicit id of the provider's catalog (`risk-unknown`, naming
  them) — a wildcard, a base id of an env-scoped entry, a preset name, a risk
  of another provider. The catalog it checks against is `fullCatalogRiskIds`,
  the function `authorityOf` filters a share by. The store checks again (`assertKnownRiskIds`, and the
  `CHECK` of `share_restrictions`).
- **One active share per `(connection, target)`.** `share()` calls
  `SharesRepo.replaceForTarget`: the previous active share of that target is
  revoked and the new one created in one transaction. This is how a
  restriction is edited. Two entries are written when a share is replaced:
  `share-revoked` (with `after.replaced_by`) then `share-created` (with
  `before` = the previous restriction).
- **Targets**: a user by email (`findActiveUserByEmail`: exactly one active
  user, or `target-unknown` / `target-ambiguous`) or a group by id (any group
  of the instance). The owning principal itself is refused (`target-is-owner`),
  and so is a **user who owns the connection now**: the owner user, or a
  current member of the owner group. The question is put to the authority
  service — `authorityOf(target, connection)` answering `basis: 'owner'` —,
  the definition every check uses. Such a share would grant
  nothing today and only outlive the membership (ADR
  [share-to-a-current-owner-refused](../decisions/share-to-a-current-owner-refused.md)).
  Nothing is stored or audited for the refusal. A share to a **group** is not
  concerned, whether or not the sharer belongs to it; a share an owner makes
  to a former member after they left is an ordinary share; a share that
  existed before its target joined the owner group stays, and applies again
  when they leave.
- Refused on a `revoked` connection (`connection-revoked`) and on an
  `unowned` one (`connection-unowned`). Nobody passes the owner check on an
  `unowned` connection, except a member who joined the emptied owner group
  again: the connection stays `unowned` until the operator reassigns it, and
  that member is the one who reads `connection-unowned`.
- `revoke(actor, shareId, onConnectionId?)` is terminal for the share and
  idempotent: a share already revoked is returned as it is, with no entry, and
  so is one that another revocation won between this one's read and its
  conditional `UPDATE` (the entry belongs to the act that revoked). The route
  passes the connection of its URL as `onConnectionId`: a share of another
  connection answers `not-found`, even to an owner of both. `share()` and
  `revoke()` both watch the missions of the connection across the act
  (`grounds.watchConnection`): the outcome carries `orphaned` (missions the
  change left ungrounded) and, for `share()`, `restored` (orphaned missions
  the new share covers again — they serve calls from then on). The notice
  says both counts. The settlement runs in a `finally`: once the share or the
  revocation is stored, the missions it orphaned or restored are settled even
  when the act's own entry (`share-created`, `share-revoked`) cannot be
  written; that failure still reaches the caller.
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
  (`name-invalid`); refused when it is the group of the admin rule
  (`name-reserved`) and when a group of any source holds the name
  (`name-taken`, `GroupsRepo.createLocal` returns `null`). Writes
  `group-created`.
- `addMember(actorId, groupId, email)`: local groups only (`not-local`), a
  known active user (`user-unknown`, `user-ambiguous`); idempotent. Writes
  `group-member-added` only when the membership was added
  (`GroupsRepo.addMember` returns whether it was): adding a member who is one
  already writes nothing. Returns `restored`: the orphaned missions of that
  user the membership grounds again.
- `removeMember(actorId, groupId, userId)`: writes `group-member-removed`.
  Returns `unowned` and `orphaned`.
- Both settle in a `finally`: once the membership is stored, what it held is
  settled (`markOwnerlessUnowned`, the grounds entries) even when the act's
  own entry cannot be written. `unowned` is a stored state and does not depend
  on another write succeeding; the failure of the entry still reaches the
  caller.
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
  finds it `active` with an owner group that has no member, or with an owner
  user who is not `active`. That method is
  called by the settlement of `MembershipSettler.watch`, i.e. after every membership
  removal the gateway performs: the operator removing a member of a local
  group, each sign-in (which may have dropped IdP-sourced memberships), and
  the operator deactivating a user (`UserAdminService.deactivate`, which
  removes the user from every group, revokes their delegations and the member
  tokens they hold on missions of other creators — handbook
  [authentication](authentication.md), "Deactivating a user"). The watch is on
  the missions that user **created** (`watchCreator`): a mission they are only
  a member of is not orphaned by their deactivation, their token on it stops.
  `UserAdminService.reactivate` runs the same three closings once more
  (`closeHeldBy`) **before** it takes its watch and restores the status: each
  is a no-op after a complete deactivation, and one that fails stops the
  reactivation, so a user never comes back holding a group membership, a
  delegation or a member token that a half-failed deactivation left open (ADR
  [one-membership-rule-checked-in-the-token-insert](../decisions/one-membership-rule-checked-in-the-token-insert.md),
  D4).
- An `unowned` connection **keeps serving** ([connections](connections.md),
  "Connection states"). Missions still grounded — those of share
  beneficiaries — keep running; missions that were grounded on membership of
  the emptied group are orphaned from that instant, and audited by the same
  settlement. Nobody passes the
  owner check, so nobody shares, reconnects, transfers or revokes.
- A member joining the group again does not bring the connection back: it
  stays `unowned` until the operator decides. Neither does the reactivation
  of a deactivated owner user: `authorityOf` answers `basis: 'owner'` for
  them again (the owner check reads the owner, not the status), so their
  missions on it are grounded, but the connection reads `unowned` and takes
  no owner act until the operator reassigns it — to them or to somebody else.
- `listOwnerless()` / `reassign(operatorId, connectionId, newOwner)` are the
  operator's only act on the domain. Ownerless means `unowned`, or not
  revoked with an empty owner group or an owner user who is not `active` (an
  `unowned` connection whose credential
  died is `expired`, and still ownerless). The store's predicate
  (`listOwnerless`, `markOwnerlessUnowned`, `assignOwnerlessTo`) and the
  service's pre-check (`looksOwnerless`) cover both cases. `reassign` refuses a connection
  that has an owner (`not-ownerless`), an unknown user (`owner-unknown`) and a
  group without member (`owner-group-empty`); `ConnectionsRepo.assignOwnerlessTo`
  checks both conditions again inside its write transaction, sets the owner
  and turns `unowned` back to `active` (an `expired` one stays `expired` for
  its new owner to reconnect); entry `connection-reassigned`.
  `ConnectionService.reassignTargets()` lists the groups `reassign` accepts —
  the ones that have a member — for the form of Administration → Connections.
- `ownerActRefusal(connection)` (`connections/service.ts`) is the one
  statement of "a revoked or unowned connection takes no owner act":
  `connection-revoked`, `connection-unowned` or `null`. The connection
  service's own refusals, `ShareService.share` and the pages
  (`transferTargets`, `ShareContext.unshareable`) all read it.
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
| `creator-removed`    | the creator is unknown or `removed` (an operator deactivated them)                  | when an operator reactivates the account              |
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

| Reader                                                                                                                         | Call                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the execution door, every request                                                                                              | `grounds.inspect` (`execution/door.ts`)                                                                                                                                                                   |
| `MissionService`: list, detail and session page (creator or member); gate, rotate, revoke, `draftFrom` / `duplicate` (creator) | `grounds.inspect` (`access` for the reads, `ownInspected` for the creator's acts, `list`; `stateAfterRefusal` for the state reported when the store refused a token insert)                               |
| `MissionTeamService`: team, members, tokens                                                                                    | none of its own: every method that reads a mission starts from `MissionService.access`, so it holds the mission already derived; after a refused token insert it asks `MissionService.stateAfterRefusal`  |
| `RequestService`: view, claim and approval decisions                                                                           | `grounds.derive` (`own`)                                                                                                                                                                                  |
| the Delegations listing                                                                                                        | `derivedMissionReads(store.missions, grounds)`, wrapped by the composition root                                                                                                                           |
| the management door (`list_my_missions`, `issue_mission`, `rotate_mission_token`, `revoke_mission`)                            | none of its own: it is handed `MissionService` methods as a port (`compose/management.ts`, `managementMissionsOf`), so the state and `MissionOverview.orphan` reach `management/views.ts` already derived |

A record loaded from `store.missions` carries the **stored** status. A new
reader that shows or decides on the status must go through `inspect` /
`derive`; `tests/unit/structural/authority-not-snapshotted.test.ts` lists the
production files that load a mission record and fails on a new one until it is
classified.

While orphaned: every call is refused `mission-inactive` (`status: orphaned`),
no gate is edited and no token rotated (`inactive`), no claim or approval is
granted (`mission-closed`; a refusal can still be recorded), and the creator
can still revoke — stored, terminal. `/missions/<id>` shows the reason and
whether it can come back ([missions](missions.md)). The gate edit is closed on
`revoked` and `orphaned` only (`gateEditBlockedBy`): an **expired** mission
keeps its gates editable, since its creator can extend the expiry
([missions](missions.md), "Editing a gate after issuance").

The verdict is about the **creator** alone, whoever holds the token
([missions](missions.md), "Members and tokens"): a member works under the
creator's authority and needs no share of the mission's connections, so a
member's own shares or groups never orphan or restore a mission. An orphaned
mission is orphaned for every holder at once and comes back for every holder
at once, same tokens. While it lasts no token is generated and no named token
created (`mission-inactive`); a member can still be added or removed and a
token revoked. A holder whose own token stopped (rotated, revoked on its own,
member removed or deactivated) is answered the 401 of that reason, not
`mission-inactive`: the token is judged before the mission. Who counts as a
member is one rule, `membershipOf` (`store/membership.ts`), read by
`MissionService.access`, by the token's standing and by the token insert
([missions](missions.md), "Who is on a mission").

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
| `UserAdminService.deactivate` / `reactivate`       | `MembershipSettler.watch` (user)   | yes     | yes      | the operator           |

The watch holds verdicts for the length of one act, for the audit only: no
reader sees them. The watch and the act are not one transaction, so two acts
under way at once on one mission may both see the same change. **It is
recorded once.** `settle` writes each entry through
`AuditRepo.appendUnlessLatest(entry, { among, since })` ([store](store.md)),
`among` being the two acts `mission-orphaned` and `mission-restored`: in one
store transaction, the entry is held back when the mission's latest entry of
those two acts is the same act **and** was written since this watch was taken
(`since`). The act that settled first is the one the trail names; the other
one writes nothing, and its outcome does not count that mission (`orphaned` /
`restored` of a settlement list only the missions whose entry it wrote, so the
notices of two acts do not both claim the change). An equal entry **older**
than the watch does not hold a new one back: it records an earlier change (the
restoration in between went unrecorded, or retention purged it), and a mission
with no earlier entry is always written. The state itself is never concerned:
every reader derives it.

One case remains, marked `// single-process only` above `watch()` in
`mission-grounds.ts`. When another act undoes the change before this one
settles (A revokes a share, B shares again and settles, then A settles), A's
watch sees the same verdict before and after and writes nothing: the trail
holds a `mission-restored` with no `mission-orphaned` before it. It is not
reachable while every store call is synchronous in one process; with a second
process or an asynchronous driver it needs the watch, the act and the
settlement in one store transaction.

A change made by a path no service watched (a repair in the database, a
future import) is seen by every reader at once and has no administrative
entry: the two acts of a mission need not come in pairs.

`MembershipSettler.watch(userId)` → `settle(actorId)` also runs
`ConnectionsRepo.markOwnerlessUnowned()` (the one stored state here) and
returns `{ unowned, orphaned, restored }`.

### The door

`ExecutionDoor.credentialResolver` (`execution/door.ts`) calls
`grounds.inspect(verified.mission)` between the token verification and
`loadMissionContext`, on every request whose token authenticates
(`tools/list`, `tools/call`, the catalog endpoint). A token that stopped on
its own — rotated, revoked alone, its member removed or deactivated — is
answered 401 before that, and the mission is not inspected
([execution-door](execution-door.md), "Token holders"). The pipeline's `checkMissionActive` then refuses an
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
for one sign-in (a mapping edited by mistake) costs refusals until the next
sign-in, not the missions. A failure
of either call is logged and does not fail the sign-in: every reader derives
the state anyway. A token whose groups the IdP moved out of it (Entra ID
group overage) never reaches the sync: the sign-in is refused with
`groups-overage` and the memberships stay as they were
([authentication](authentication.md), "Sign-in flow").

## How to use it

### Pages and routes

| Path                                                                            | What                                                                                                                                                                              | Guard    |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `/connections/<id>`                                                             | "Shares" card (target, restriction on demand, Edit, Revoke), "Ownership" card (transfer)                                                                                          | owner    |
| `/connections/<id>/share[?share=<id>]`                                          | the Share dialog (`share-form.tsx`, client): the checklist open under its summary, each risk a compact `RiskExplain` row ([missions](missions.md)), the helper text behind "More" | owner    |
| `POST /connections/<id>/shares`                                                 | `shares.handlers.share`                                                                                                                                                           | user     |
| `POST /connections/<id>/shares/<shareId>/revoke`                                | `shares.handlers.revoke`                                                                                                                                                          | user     |
| `POST /connections/<id>/transfer`                                               | `connections.handlers.transfer` (`group_id`)                                                                                                                                      | user     |
| `/shares`                                                                       | Shares received                                                                                                                                                                   | user     |
| `/admin/groups`                                                                 | groups, members                                                                                                                                                                   | operator |
| `POST /admin/groups/create`, `…/<id>/members`, `…/<id>/members/<userId>/remove` | `groups.handlers.*`                                                                                                                                                               | operator |
| `/admin/connections`                                                            | connections without owner                                                                                                                                                         | operator |
| `POST /admin/connections/<id>/reassign`                                         | `connections.handlers.reassign` (`owner_kind`, `owner_email` / `owner_group`)                                                                                                     | operator |

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

| File                                                      | Covers                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/authority/authority-service.test.ts`          | owner, union of shares, per-connection subsets, `gapsOf`, cheap path, `uncoveredRisks`                                                                                                                                                                                                                                                                           |
| `src/server/authority/mission-grounds.test.ts`            | every cause (`connection-missing` included), partition, `inspect` / `derive`, watches, two acts under way at once (one change, one entry; an older equal entry does not hold a new one back; the mirror case), `MembershipSettler`, `derivedMissionReads`                                                                                                        |
| `src/server/missions/orphan-reason.test.ts`               | the sentences of the mission page, per cause                                                                                                                                                                                                                                                                                                                     |
| `src/server/shares/*.test.ts`                             | restriction helpers, share service (`connection-unowned`, `provider-unknown`, the route's connection, a revocation lost to another one, settlement when the entry fails), error shape                                                                                                                                                                            |
| `src/server/groups/service.test.ts`                       | local groups (one entry per change, settlement when the entry fails), admin rule and local groups, `findActiveUserByEmail`                                                                                                                                                                                                                                       |
| `src/server/missions/catalog-view.test.ts`                | the catalog view is the authority enumeration, an entry the authority cannot enumerate included                                                                                                                                                                                                                                                                  |
| `tests/integration/authority/share-and-orphan.test.ts`    | share → issue within R1 → exceed → revoke → orphaned → refused; lose → regain: same token, session, counters; revoked connection stays orphaned; a claim and an approval request on an orphaned mission expire on the normal delay ([requests](requests.md))                                                                                                     |
| `tests/integration/authority/ownership.test.ts`           | transfer, unowned, reassignment (restores), a group claim missing at one sign-in then back at the next; a share to oneself or to a fellow member of the owner group refused (`target-is-owner`, nothing stored), so leaving the group orphans the member's missions; a share to a former member and a share to a group the sharer belongs to accepted            |
| `tests/integration/auth/deactivate-user.test.ts`          | a deactivated user holds nothing: mission `orphaned` with nothing written on it, own connection `unowned` and reassigned by the operator, `mission-restored` on reactivation; what a half-failed deactivation left open is closed before the user is active again, and a reactivation that cannot close it does not happen ([authentication](authentication.md)) |
| `tests/integration/authority/handlers.test.ts`            | the form posts and their notices                                                                                                                                                                                                                                                                                                                                 |
| `tests/integration/authority/rules-read-by-pages.test.ts` | what a page reads is what the act answers: `ownerActRefusal` and `ShareContext.unshareable`, `transferTargets`, `ConnectionService.reassignTargets()`, `gateEditBlockedBy` and `MissionDetail.gates_editable`, on every status                                                                                                                                   |
| `tests/integration/store/ownership-and-orphans.test.ts`   | the repository transitions; migration `0007` (reset, triggers)                                                                                                                                                                                                                                                                                                   |
| `tests/integration/store/audit-guarded-append.test.ts`    | `AuditRepo.appendUnlessLatest`: two writers, one entry; per object, within the guarded acts, not for an older equal entry                                                                                                                                                                                                                                        |
| `tests/unit/structural/authority-not-snapshotted.test.ts` | spec §10: no state in the module, every check follows the store; no stored orphan verdict, every reader of a mission record classified                                                                                                                                                                                                                           |
| `tests/e2e/v5/share-and-orphan.spec.ts`                   | the dialog, Shares received, revocation, restoration by a new share, the ownership loop (browser)                                                                                                                                                                                                                                                                |

## How to debug

- **A mission answers `mission-inactive` / `orphaned`.** Its page
  (`/missions/<id>`) shows the cause as of that page load, the connection and
  the uncovered risks; `grounds.check(mission)` gives the same. Audit → the
  mission: a `mission-orphaned` entry names the act and its author (when two
  acts were under way at once, the one that settled first). No entry
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
  (or its owner group is empty, or its owner user was deactivated):
  Administration → Connections lists it.
  Log line `connection has no owner left`.
- **A user in the admin group is not an operator.** A local group holds the
  rule's name, so the IdP claim is skipped (log: `IdP group claim collides
with a local group`), and local membership does not count.
- **"The target already owns this connection".** `target-is-owner`: the
  email is the owner's, or that of a current member of the owner group. A
  co-owner needs no share; to keep somebody's access after they leave the
  group, an owner shares to them once they have left.
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
  `tests/integration/audit/admin-mutations.test.ts`. It settles in a `finally`
  once its own write is stored. Forgetting the watch loses an audit entry,
  never the state.
- **A new reader of a mission's status** goes through `grounds.inspect` or
  `grounds.derive`, and is classified in `MISSION_READERS` of the structural
  test.
- **Hosted deployment**: nothing here is process state. `gapsOf` costs one to
  three indexed reads per request; a shared cache in front of it would be the
  snapshot the spec forbids. Two things assume one process today, both marked
  in the code: the mirror case of the watch (above), and the order of the
  trail that `appendUnlessLatest` reads (`ts`, then the id, which is insertion
  order for one process). On Postgres its transaction must be `SERIALIZABLE`
  or hold a per-mission advisory lock.

## Not built here

- Closing an orphaned mission by an owner of the connection (spec §2.3): the
  creator closes it with the mission's "Revoke"; an orphaned mission already
  refuses everything. An owner who wants it never to serve again revokes the
  connection, or does not share again.
- An audit entry for a change of authority that no service performed (the
  door sees it and refuses or serves; nobody is named).
- Deleting a group.
- A deprovisioning feed from the IdP: `users.status = 'removed'` is set by an
  operator only (Administration → Users, handbook
  [authentication](authentication.md)); nothing syncs with the IdP's
  directory.
- Migrating shares made to a co-owner before the `target-is-owner` rule
  covered them: such a row still stands, is listed in the connection's Share
  dialog, and an owner revokes it there.
