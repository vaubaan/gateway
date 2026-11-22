---
title: Install a plugin on my gateway
status: proposed
actors: [administrator, agent]
spec: ../spec/vaubaan-gateway.md
last_reviewed: 2026-11-22
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

### See every catalog service in the connect picker

status: proposed
requires: plugin
spec: ../spec/vaubaan-gateway.md#42-human-surface
acceptance:

- A plugin the catalog published after this release is offered by its service's name, never its id
- The versions feed names each catalog plugin with its service's name, and an older gateway still reads the feed

### Browse the catalog apart from what runs

status: implemented
requires: plugin
anchors: apps/gateway/src/app/admin/(guarded)/plugins/catalog/page.tsx, apps/gateway/src/app/admin/(guarded)/plugins/catalog/catalog-view.tsx, apps/gateway/tests/unit/app/admin-plugins.test.tsx, apps/gateway/tests/e2e/admin-plugins.spec.ts
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

### Update a plugin without restarting the gateway

status: implemented
requires: plugin, administrator
anchors: apps/gateway/src/server/plugins/install-service.ts, apps/gateway/src/server/plugins/call-gate.ts, apps/gateway/src/server/compose/root.ts, apps/gateway/tests/integration/plugins/install-on-trial.test.ts, apps/gateway/tests/integration/plugins/swap-during-call.test.ts, apps/gateway/tests/integration/plugins/install-over-http.test.ts
spec: ../spec/vaubaan-gateway.md#42-human-surface

### Update my installed plugins in a few clicks

status: implemented
requires: plugin, administrator
anchors: apps/gateway/src/app/admin/(guarded)/plugins/plugins-view.tsx, apps/gateway/src/app/admin/(guarded)/plugins/update/route.ts, apps/gateway/src/server/plugins/install-service.ts, apps/gateway/tests/integration/plugins/install-from-catalog.test.ts, apps/gateway/tests/integration/plugins/install-over-http.test.ts, apps/gateway/tests/unit/app/admin-plugins.test.tsx, apps/gateway/tests/unit/app/admin-plugins-install.test.tsx
spec: ../spec/vaubaan-gateway.md#42-human-surface

### Roll back a plugin to a kept version

status: implemented
requires: plugin, mission
anchors: apps/gateway/src/app/admin/(guarded)/plugins/plugins-view.tsx, apps/gateway/src/server/plugins/install-service.ts, apps/gateway/src/server/compose/registry.ts, apps/gateway/tests/unit/app/admin-plugins.test.tsx, apps/gateway/tests/integration/plugins/install-on-trial.test.ts, apps/gateway/tests/unit/server/compose/kept-catalog-index.test.ts
spec: ../spec/vaubaan-gateway.md#42-human-surface

### Receive security patches automatically

status: proposed
requires: plugin, administrator
spec: ../spec/vaubaan-gateway.md#42-human-surface
acceptance:

- An administrator opts a plugin into automatic security patches; nothing updates by itself otherwise
- A Vaubaan-signed patch version that fixes an advisory of the active version is installed and started on trial without anyone acting
- Every administrator is notified of the patch applied, or of the trial that failed and the version kept

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
