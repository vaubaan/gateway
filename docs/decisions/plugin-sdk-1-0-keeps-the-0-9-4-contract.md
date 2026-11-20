---
title: The plugin SDK 1.0 is the 0.9.4 contract made stable; builds and hosts of either side load each other
status: accepted
date: 2026-11-20
---

# The plugin SDK 1.0 is the 0.9.4 contract made stable; builds and hosts of either side load each other

## Context

A host refuses a plugin whose build range (`peerDependencies["@vaubaan/plugin-sdk"]`, `^<SDK>` so
far) does not hold its own SDK version. Every catalog plugin is built `^0.9.x`, at least 0.9.4, and
instances run gateways of either side of any SDK release: a plain `1.0.0` would turn away every
published plugin on an upgraded gateway, and every rebuilt one on a gateway not yet upgraded. What
a plugin and its host exchange at run time has not changed since 0.9.4; 1.0 removes only the
deprecated names (compile time) and the host's adapter for pre-0.9.4 pins.

## Decision

`1.0.0` freezes the 0.9.4 run-time contract. A 1.x host also loads a build whose range lies within
`>=0.9.4` and its own version (`SDK_CONTRACT_SINCE`), and a build made with a 1.x SDK declares
`^0.9.4 || ^<its SDK>`, `^0.9.4 || ^1.0.0` at 1.0.0 (`sdkBuildRange`). A pin built against an SDK before 0.9.4 is refused with
"rebuild", no longer translated. From 1.0 the handbook's semver table applies by major.

## Consequences

- A change a host relies on to read what a plugin returns or throws is a 2.0 and ends the
  `^0.9.4` half of the range; until then no such change lands in 1.x.
- The range a build declares comes from the SDK (`sdkBuildRange`), never written by hand in the
  CLI, the bundle script or a plugin.
- Removing `^0.9.4` from builds is a later decision, once no supported gateway runs 0.9.4.

## Rejected alternatives

### A plain `^1.0.0`, gateway and catalog moved together

One flag day: every instance's installed plugins refused until both its gateway and the catalog
have moved, and an instance cannot choose its gateway's upgrade date.

### Keeping the pre-0.9.4 adapter in 1.0

It carries the former `provider` words into a stable contract for pins no catalog version needs:
every catalog version is built at 0.9.4 or later.
