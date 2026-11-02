---
title: Authority — owners, shares, groups, orphaned missions, unowned connections
tracks:
  - apps/gateway/src/server/authority/
  - apps/gateway/src/server/shares/
  - apps/gateway/src/lib/shares/
  - apps/gateway/src/lib/authority/
  - apps/gateway/src/server/groups/
  - apps/gateway/src/server/connections/service.ts
  - apps/gateway/src/server/execution/admission.ts
  - apps/gateway/src/server/auth/login.ts
  - apps/gateway/tests/unit/structural/authority-not-snapshotted.test.ts
last_reviewed: 2026-10-27
---

# Authority — handbook

How the gateway answers "what may this user accept on this connection, now?", and what follows
when the answer changes. Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §2.3, §3.1, §7.3,
§11.2. ADRs:
[orphaned-missions-and-ownerless-connections](../decisions/orphaned-missions-and-ownerless-connections.md),
[operator-deactivates-a-user](../decisions/operator-deactivates-a-user.md),
[mission-members-and-per-holder-tokens](../decisions/mission-members-and-per-holder-tokens.md).

## Start here

- [`authority-service.ts`](../../apps/gateway/src/server/authority/authority-service.ts) —
  `authorityOf` (issuance), `gapsOf` (the cheap re-check on every door request).
- [`mission-grounds.ts`](../../apps/gateway/src/server/authority/mission-grounds.ts) — derives
  `orphaned` and lost parts; the watches that audit a change.
- [`catalog-authority.ts`](../../apps/gateway/src/lib/authority/catalog-authority.ts) — the
  enumeration and monotonicity rules everything reuses (browser-safe).
- [`shares/service.ts`](../../apps/gateway/src/server/shares/service.ts),
  [`connections/service.ts`](../../apps/gateway/src/server/connections/service.ts) — shares,
  transfer, ownerless, reassign.

## Invariants

- **Authority is never stored or cached**: computed from the user's status, current group
  memberships and active shares at each call; never read from the web session.
  `authority-not-snapshotted.test.ts` holds it.
- `orphaned` is derived on every read, never stored; a record from `store.missions` carries the
  stored status. A new reader goes through `grounds.inspect` / `derive` and is classified in
  `MISSION_READERS`, or the structural test fails.
- A new basis of authority goes into both `authorityOf` and `gapsOf`.
- The ids a page shows, a share may carry and an authority returns are one list
  (`explicitRiskIdsOf`); "Select all" is resolved in the browser, the server never receives "all".
- The verdict is about the creator alone: a member's own shares or groups never orphan or
  restore a mission.
- `ownerActRefusal` is the one statement of "a revoked or unowned connection takes no owner act".
- `unowned` is stored; only the operator's `reassign` clears it (a member rejoining does not).

## Traps

- With nothing stored, "this act orphaned that mission" is a difference of two verdicts: an act
  that can remove or return authority takes `watchConnection` / `MembershipSettler.watch` before
  and settles in a `finally` after its write. A forgotten watch loses an audit entry, never the
  state. Classify the act in `tests/integration/audit/admin-mutations.test.ts`.
- Two settlers may see the same change: `settle` writes through `appendUnlessLatest`, so the
  first one is named and the other writes nothing. Only the settler whose entry was written
  tells the creator's devices that the mission is orphaned ([notifications](notifications.md)).
- Known gap (`// single-process only` above `watch()`): an act undone by another before it settles
  leaves a `mission-restored` with no `mission-orphaned` before it. A change no service watched (a
  database repair) has no entry.
- A share that would restore missions is confirmed in the HTTP handler (`share-confirm:` in the
  `SessionStore`, forecast again at post); `ShareService.share()` called from code restores
  without asking.
- `reactivate` reruns the deactivation's closings before restoring the status, so a user never
  returns holding what a half-failed deactivation left open.
- The admin rule counts IdP-claimed groups only; an IdP claim whose name a local group holds is
  skipped (log `IdP group claim collides with a local group`).

## Debug

- **`mission-inactive` / `orphaned`** → `/missions/<id>` shows cause, connection and uncovered
  risks; the `missions` row says `active`, do not look there. `mission-orphaned` names the act.
- **Should be back and is not** → a share must cover every accepted risk on that connection; a
  group reaches the creator only once `groupsOf` lists it (IdP groups change at sign-in).
  `connection-revoked` never ends.
- **A connection vanished from its owners' list** → it is `unowned` (log
  `connection has no owner left`); see `/accounts#without-owner`.
- **A sign-in orphaned missions** → the claims dropped a group; the next sign-in with it restores
  them.
