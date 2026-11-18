---
title: Install a plugin on my gateway
status: proposed
actors: [administrator, agent]
spec: ../spec/vaubaan-gateway.md
last_reviewed: 2026-11-18
---

# Install a plugin on my gateway

As an administrator, I want to add, update and roll back a plugin from the gateway itself, so
that a new service or a fix reaches my instance without a new image and never without my choice.

## Get a plugin version onto the instance

### Upload a plugin archive

status: implemented
requires: archive
creates: plugin
anchors: apps/gateway/src/server/plugins/install-service.ts, apps/gateway/src/app/admin/(guarded)/plugins/upload/route.ts, apps/gateway/tests/integration/plugins/install-over-http.test.ts, apps/gateway/tests/integration/plugins/signatures.test.ts
spec: ../spec/vaubaan-gateway.md#42-human-surface

### Hand over a plugin from an agent

status: implemented
requires: mission, archive
creates: plugin
anchors: apps/gateway/src/server/vaubaan/plugin-acts.ts, apps/gateway/tests/integration/plugins/deploy-from-cli.test.ts
spec: ../spec/vaubaan-gateway.md#41-bis-management-surface-the-vaubaan-plugin

### Install a plugin when I first connect its service

status: implemented
requires: plugin
anchors: apps/gateway/src/app/(app)/accounts/new/[service]/install/route.ts, apps/gateway/src/app/(app)/accounts/new/[service]/install-first.tsx, apps/gateway/tests/integration/plugins/install-when-first-connected.test.ts
spec: ../spec/vaubaan-gateway.md#42-human-surface

### Install a catalog plugin in one click

status: implemented
requires: plugin
anchors: apps/gateway/src/server/plugins/catalog.ts, apps/gateway/src/app/admin/(guarded)/plugins/install-catalog/route.ts, apps/gateway/tests/integration/plugins/install-from-catalog.test.ts
spec: ../spec/vaubaan-gateway.md#42-human-surface

## Run a version I chose

### Activate a pending plugin version

status: implemented
requires: plugin, administrator
anchors: apps/gateway/src/server/plugins/install-service.ts, apps/gateway/src/app/admin/(guarded)/plugins/install-view.tsx, apps/gateway/tests/integration/plugins/install-on-trial.test.ts, apps/gateway/tests/unit/app/admin-plugins-install.test.tsx
spec: ../spec/vaubaan-gateway.md#42-human-surface

### Roll back a plugin to a kept version

status: proposed
requires: plugin, mission
spec: ../spec/vaubaan-gateway.md#42-human-surface
acceptance:

- The page lists the kept versions; one built for another SDK range is greyed with the reason
- Before confirming, the page names the permissions the older version does not know and the accounts it cannot run
- After the rollback a mission holding a permission unknown to the active version can still be edited and saved

### Trust a signer

status: implemented
requires: signer
anchors: apps/gateway/src/app/admin/(guarded)/plugins/signers/add/route.ts, apps/gateway/tests/integration/plugins/signatures.test.ts
spec: ../spec/vaubaan-gateway.md#42-human-surface

### Start without what was installed here

status: implemented
requires: plugin
anchors: apps/gateway/src/server/compose/installed-plugins.ts, apps/gateway/tests/integration/plugins/install-on-trial.test.ts, apps/gateway/tests/unit/app/admin-plugins-install.test.tsx
spec: ../spec/vaubaan-gateway.md#43-instance-configuration
