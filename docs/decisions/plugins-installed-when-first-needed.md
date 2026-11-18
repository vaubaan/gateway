---
title: The image ships no service plugin; a catalog plugin is installed and loaded when a person first connects its service
status: accepted
date: 2026-11-18
author: Renaud Pelissier
---

# The image ships no service plugin; a catalog plugin is installed and loaded when a person first connects its service

## Context

Plugins preinstalled in the image, compiled or as signed archives (the former socle), weigh every
image, lag behind the catalog and turn a plugin fix into a gateway release. The catalog already
rebuilds and signs every plugin ([plugin-catalog-rebuilt-from-source](./plugin-catalog-rebuilt-from-source.md)),
so an instance can take a plugin at the moment it needs it.

## Decision

The image carries no service plugin; only `vaubaan` (run by the host) and `ssh` (a native addon)
stay compiled into the server. When a person connects a service the instance has no plugin for,
the gateway downloads the catalog's latest version, keeps it only if the catalog signed it and it
is that id, and loads it at once; any signed-in person may do so for a plugin signed by Vaubaan.
Every other version — a newer version of a loaded plugin, a private or unsigned one — follows
[plugins-activated-by-an-administrator-on-trial](./plugins-activated-by-an-administrator-on-trial.md).

## Consequences

- The registry and every list derived from it (connect picker, catalog index, tool list) accept a
  plugin added while the instance runs; nothing is ever unloaded or replaced live.
- Connecting a service the first time needs the catalog to be reachable; an instance without that network gets its
  plugins from the operator's directory (`plugins.dir`).
- The installation is audited with who made it, and the plugin stays installed for every person
  of the instance.
- Tests and the demo load the plugins from the repository's `plugins/`, never from the server.

## Rejected alternatives

### Default plugins preinstalled in the image (the socle)

Always behind the catalog, heavier images, and a second loading path to keep consistent.

### Plugins compiled into the server

One release train for every plugin: a fix to one waits for a gateway release.

### Only an administrator installs catalog plugins

Blocks a person connecting a service the first time on an administrator for code the catalog already reviewed,
rebuilt and signed.
