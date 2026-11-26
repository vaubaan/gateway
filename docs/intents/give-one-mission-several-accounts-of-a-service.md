---
title: Give one mission several accounts of a service
status: proposed
actors: [developer, consultant]
spec: ../spec/vaubaan-gateway.md
last_reviewed: 2026-11-22
---

# Give one mission several accounts of a service

As a person who creates a mission, I want it to carry several accounts of one service (two
GitHub repositories, each with its own token) so that one agent works across them in one mission
while each key still reaches one resource.

## Put two accounts of one service in a mission

status: implemented
requires: mission, account, service
anchors: apps/gateway/src/lib/missions/preview.ts, apps/gateway/src/app/(app)/missions/cards/account-picker.tsx, apps/gateway/tests/integration/execution/several-accounts.test.ts
spec: ../spec/vaubaan-gateway.md#31-the-chain

## Let my agent call the right account by the resource it names

status: implemented
requires: mission, account, resource
anchors: apps/gateway/src/server/execution/resource-stage.ts, apps/gateway/src/server/execution/tools.ts, apps/gateway/src/server/git/scope.ts, apps/gateway/tests/integration/execution/several-accounts.test.ts
spec: ../spec/vaubaan-gateway.md#41-execution-surface

## Name the account of a call that names no resource

status: implemented
requires: mission, account
anchors: packages/gateway-core/src/pipeline.ts, apps/gateway/src/server/execution/door.ts, apps/gateway/src/server/execution/resource-stage.ts, apps/gateway/src/server/execution/tools.ts, apps/gateway/tests/integration/execution/several-accounts.test.ts
spec: ../spec/vaubaan-gateway.md#41-execution-surface

## Rename an account to tell it apart

status: implemented
requires: account
anchors: apps/gateway/src/server/accounts/service.ts, apps/gateway/src/app/(app)/accounts/[id]/account-view.tsx, apps/gateway/src/app/(app)/accounts/[id]/rename/route.ts, apps/gateway/src/server/accounts/service.test.ts
acceptance:

- An owner renames an account from its page; the new name reads in the lists, the mission cards and the activity
- A blank name, another person's account or a disconnected one is refused; the rename is recorded with the name before and after

## Let a tool that names no resource answer every account

status: proposed
requires: mission, account, resource
spec: ../spec/vaubaan-gateway.md#41-execution-surface
acceptance:

- A tool that names no resource, in a mission with two accounts of its service, runs on each account and answers one merged result
- Each account's run is judged and charged in that account's set and audited apart; one account waiting for an approval leaves the result marked partial
