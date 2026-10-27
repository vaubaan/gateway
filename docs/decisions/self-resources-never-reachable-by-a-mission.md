---
title: The instance's own hosting is a set of self resources that no mission can reach
status: accepted
date: 2026-10-13
---

# The instance's own hosting is a set of self resources that no mission can reach

## Context

A Railway or Fly connection may list the project or app that hosts the gateway. A mission on it
could read `VAUBAAN_MASTER_KEY`, rewrite the admin rule or redeploy the instance. Only the host
knows where it runs; a plugin has no access to its environment. Handbook
[configuration](../handbook/configuration.md) ("Self resources").

## Decision

`InstanceConfig.selfResources` always holds `railway:$RAILWAY_PROJECT_ID` and `fly:$FLY_APP_NAME`
when the platform sets them, plus every entry of `self_resources`; no plugin, connection, preset
or policy changes it. One predicate (`isSelfResource`) enforces it at issuance, at execution
whatever the stored selection says, and in every listing of what a mission can select.

## Consequences

- Any new path by which a resource becomes reachable calls the same predicate.
- A self resource stays visible on the account page, tagged, so the owner sees why it cannot be
  selected.
- Only resource binding is covered: account-level calls (creating an app) are not, so the hosting
  organization is never connected to its own gateway (deploy guides).

## Rejected alternatives

### The plugin excludes the project at discovery

A plugin cannot see the environment, and hiding the row hides the fact from the owner.

### Refuse only at issuance

An older mission or a hand-edited row would still reach it; the execution door must hold.
