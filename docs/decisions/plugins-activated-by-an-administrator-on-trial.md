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
