---
title: An instance installs its own plugins; an administrator activates each version, which starts on trial
status: accepted
date: 2026-11-17
---

# An instance installs its own plugins; an administrator activates each version, which starts on trial

The first installation of a catalog plugin signed by Vaubaan, by any person connecting its service,
loads at once ([plugins-installed-when-first-needed](./plugins-installed-when-first-needed.md));
every other version follows this record.

## Context

With plugins out of the image, an instance must take a new plugin, a newer or an older version
without a new image, and an agent should be able to hand over the plugin it just built. A plugin
runs with every credential of the instance, and a version that fails to load stops the boot,
leaving nobody able to reach the interface to undo it.

## Decision

A plugin version reaches an instance by upload (Administration › Plugins, or `vaubaan__upload_plugin`
from a mission whose creator is an administrator) or by a one-click install of a catalog archive;
it stays inert until an administrator activates it in the browser, shown its signature level and
catalog diff. Activation takes effect at the next start, on trial: the version becomes active once
it loaded and classified its own examples, otherwise the previous version is restored and the
failure shown. The operator's plugins directory stays.

## Consequences

- The gateway writes code it will load (`/data/plugins/<sha256>`), so every archive is checked
  against its signature and digest at upload and at every start.
- An agent uploads and reads status; it never activates, rolls back nor removes a plugin.
- Going back to an older version never widens a mission: the store accepts the risk ids of every
  kept version, and those the active one does not know stay inert.
- Nothing updates by itself, unless an administrator opts a plugin into Vaubaan-signed security
  patches, which start on trial too.

## Rejected alternatives

### Only the operator installs, by image or mounted directory

The gateway then never writes code, but every plugin, fix or rollback needs a deployment and no
agent can hand over what it built; it stays available beside uploads.

### Activation without a restart

Node cannot unload a module and the registry is built at boot; swapping it live reworks the core
for a rare act.

### Refusing to start on a version that does not load

Leaves the instance down until someone with deployment access steps in.

## Amendment 2026-11-19: an installed version is activated without a restart

### Context

Since the image compiles no service plugin, every fix to a service is a plugin release. The
"rare act" this record weighed is now the common one, and a restart cuts every session of every
service to update one. Node never needs to unload a module: each version lives in its own folder
(`<data dir>/plugins/<sha256>`) and is imported beside the one it replaces.

### Decision

Activating a version of a plugin that runs from an installed version, or that does not run yet,
runs its trial at once, in the running instance: the version is read from its folder, classifies
its own examples, and passes the boot's checks over the registry it would make. Only then is the
registry's entry replaced, once no call of that service is running; a call of that service
arriving meanwhile waits for the swap, so a call is classified and executed by one version. A
failed trial leaves the previous version serving and records the failure. A plugin served by the
image or by the operator's pins, an instance in `plugins.safe_mode`, and a version activated by a
start keep the trial at the next start.

### Consequences

- The replaced module stays in memory until the next start: a few megabytes per swap.
- Work a plugin started outside a call (a discovery under way) finishes on the version it began
  with.
- MCP clients see the new tools at their next `tools/list`; no `listChanged` is sent.
- The restart button stays for what still applies at a start.

### Rejected alternatives

#### Swap without waiting for the calls of the service

A call already classified by the old version would run on the new one, whose classifier never
saw it.

## Amendment 2026-11-22: a Vaubaan-signed version is confirmed in a dialog, an update in one act

### Context

Every service is a plugin release, so an instance with ten connected services meets ten updates
at once. Each one took two acts (download, then activate) and typing the plugin's id: twenty
clicks and ten typed ids for versions the catalog built from reviewed source and signed.

### Decision

Updating a plugin from the catalog is one act: a dialog names the plugin, the version it runs
and the version it gets, and on confirmation the gateway downloads it, verifies the catalog's
signature and activates it on trial, as the activation above. Several plugins are updated by one
confirmation. Activating any version signed by Vaubaan (a pending one, or going back to a kept
one) is confirmed in the same dialog, without typing. A version not signed by Vaubaan still asks
for the plugin's id typed. Stopping an installed version is behind the same dialog.

### Consequences

- The permissions a catalog update adds are not shown before it runs; they are in the audit,
  and a mission never gains one it was not granted.
- The trial still guards the update: a version that does not load leaves the previous one
  serving.

### Rejected alternatives

#### Keep the typed id for every version

It guards against a slip of the hand, which the dialog already guards against; the signature
is what makes a Vaubaan version safe to run, not the typing.
