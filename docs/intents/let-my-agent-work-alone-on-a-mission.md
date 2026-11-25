---
title: Let my agent work alone on a mission
status: proposed
actors: [developer, consultant]
spec: ../spec/vaubaan-gateway.md
last_reviewed: 2026-11-22
---

# Let my agent work alone on a mission

As a person giving my agent real work, I want to write once what it may do and then leave it alone,
so that it works without me until it reaches what I kept for myself.

## Write what my agent may do

### Create a mission by ticking what my agent may do

status: implemented
requires: account, resource, macro-action
creates: mission, mission-token
anchors: apps/gateway/src/server/missions/mission-service.ts, apps/gateway/tests/integration/missions/mission-lifecycle.test.ts, apps/gateway/tests/integration/missions/permissions.test.ts
relieves: a-token-that-can-do-anything
delivers: never-handing-over-a-credential
spec: ../spec/vaubaan-gateway.md#74-create-a-mission

### See which environment a permission needs while I create the mission

status: proposed
requires: mission, resource
relieves: a-permission-that-silently-needs-a-label
spec: ../spec/vaubaan-gateway.md#74-create-a-mission
acceptance:

- When a ticked permission is bound to an environment no chosen resource carries, the mission page says so next to it and names the resources to label
- Labelling a resource from there brings me back to the mission with the permission granted

### Go back to a version of the mission that worked

status: implemented
requires: mission
anchors: apps/gateway/src/server/missions/history.ts, apps/gateway/tests/integration/missions/versions.test.ts
spec: ../spec/vaubaan-gateway.md#74-ter-restore-a-version

## Let it work while I am away

### Let my agent call within its mission's limits

status: implemented
requires: mission-token
creates: event, mission-log
anchors: apps/gateway/src/server/execution/door.ts, apps/gateway/src/server/budget/decide.ts, apps/gateway/tests/integration/execution/pipeline.test.ts, apps/gateway/tests/integration/budget/mission-log-service.test.ts
relieves: interrupted-all-the-time-or-not-when-it-mattered
delivers: my-agent-works-alone-on-real-things, the-recap-prepared-while-i-do-something-else
spec: ../spec/vaubaan-gateway.md#75-execute

### Read what my agent did

status: implemented
requires: mission-log
anchors: apps/gateway/src/server/audit/mission-log-view.ts, apps/gateway/tests/integration/audit/mission-log.test.ts
delivers: my-agent-works-alone-on-real-things
spec: ../spec/vaubaan-gateway.md#8-audit

## Answer when it reaches what I kept

### Hear on my phone that a yes waits for me

status: implemented
requires: channel
creates: notification
anchors: apps/gateway/src/server/notifications/dispatch.ts, apps/gateway/tests/integration/notifications/notifications.test.ts
relieves: interrupted-all-the-time-or-not-when-it-mattered
spec: ../spec/vaubaan-gateway.md#42-bis-notifications

### Approve or refuse the exact call

status: implemented
requires: request
creates: approval
anchors: apps/gateway/src/server/requests/approval.ts, apps/gateway/tests/integration/requests/approval.test.ts, apps/gateway/tests/integration/execution/approval-door.test.ts
relieves: a-mail-sent-to-a-client-without-me
delivers: stopped-at-the-right-place, the-client-mail-stopped-and-shown-before-it-leaves
spec: ../spec/vaubaan-gateway.md#35-requests-to-the-creator--the-approval

### Reset or extend a limit my agent reached

status: implemented
requires: request
anchors: apps/gateway/src/server/requests/claim.ts, apps/gateway/src/server/requests/claim.test.ts
spec: ../spec/vaubaan-gateway.md#76-exhaust-and-claim
