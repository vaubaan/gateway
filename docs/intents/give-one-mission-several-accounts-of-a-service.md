---
title: Give one mission several accounts of a service
status: proposed
actors: [user, agent]
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

## Let a tool that names no resource answer every account

status: proposed
requires: mission, account, resource
spec: ../spec/vaubaan-gateway.md#41-execution-surface
acceptance:

- A tool that names no resource, in a mission with two accounts of its service, runs on each account and answers one merged result
- Each account's run is judged and charged in that account's set and audited apart; one account waiting for an approval leaves the result marked partial
