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

status: proposed
requires: archive
creates: plugin
spec: ../spec/vaubaan-gateway.md#42-human-surface
acceptance:

- Administration › Plugins accepts an archive and lists it as pending, inert, with its trust level and digest
- A modified archive, an unknown signer or an unsigned id absent from `plugins.allow_unsigned` is refused at upload, the reason named
- An unsigned or privately signed archive using a catalog or socle id is refused at upload
- The upload is in the audit with the digest, the trust level and who made it

### Hand over a plugin from an agent

status: proposed
requires: mission, archive
creates: plugin
spec: ../spec/vaubaan-gateway.md#41-bis-management-surface-the-vaubaan-plugin
acceptance:

- `vaubaan__upload_plugin` on a mission whose creator is an administrator leaves the version pending and answers the activation page's URL
- The same call on a mission whose creator is not an administrator is refused
- No `vaubaan__*` tool activates, rolls back or removes a plugin, or changes the trusted signers

### Install a catalog plugin in one click

status: implemented
requires: plugin
anchors: apps/gateway/src/server/plugins/catalog.ts, apps/gateway/src/app/admin/(guarded)/plugins/install-catalog/route.ts, apps/gateway/tests/integration/plugins/install-from-catalog.test.ts
spec: ../spec/vaubaan-gateway.md#42-human-surface

## Run a version I chose

### Activate a pending plugin version

status: proposed
requires: plugin, administrator
spec: ../spec/vaubaan-gateway.md#42-human-surface
acceptance:

- The activation page lists the permissions added and deprecated against the active version and the missions using the service
- Activation needs the plugin's id typed, and takes effect at the next start
- After the restart the version is active and a mission holding its permissions can call its tools
- A version that fails to load or to classify its own examples is replaced by the previous one; the instance answers and the page shows the failure

### Roll back a plugin to a kept version

status: proposed
requires: plugin, mission
spec: ../spec/vaubaan-gateway.md#42-human-surface
acceptance:

- The page lists the kept versions; one built for another SDK range is greyed with the reason
- Before confirming, the page names the permissions the older version does not know and the accounts it cannot run
- After the rollback a mission holding a permission unknown to the active version can still be edited and saved

### Trust a signer

status: proposed
requires: signer
spec: ../spec/vaubaan-gateway.md#42-human-surface
acceptance:

- Adding a signer needs its name typed, notifies every administrator and is in the audit
- An archive signed by that signer then uploads with the signer's name as its trust level, never "Vaubaan"

### Start without what was installed here

status: proposed
requires: plugin
spec: ../spec/vaubaan-gateway.md#43-instance-configuration
acceptance:

- With `plugins.safe_mode` the instance starts with the image's versions only and says so in its log and in Administration › Plugins
