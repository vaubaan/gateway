---
title: What a mission creates through the gateway it reaches at once, read from the creating call's answer by the plugin, recorded by the host
status: accepted
date: 2026-10-24
---

# What a mission creates through the gateway it reaches at once, read from the creating call's answer by the plugin, recorded by the host

## Context

A mission's resources are a list stored at issuance (scope `connection` excepted), and discovery ran
only at connect time or on the owner's "Refresh": an agent that created a Fly app or a Miro board
was refused on it until a human acted, and a provider may list a new object minutes late. The
gateway sees the creating call go through its door, and the call's answer names what was created.

## Decision

A plugin declares its `resourceCreatingTools` and the pure hook `createdResources(tool, args,
result)`, which reads the created refs through its discovery grammar; the host never guesses
creating calls from names or slices. For an allowed, non-error call of such a tool, the host
upserts the created resources into the connection and adds them to the mission's selection
(`source = 'created'`, audited `mission-resources-added`) before the answer leaves, then schedules
a discovery of the connection off the request path.

## Consequences

- A mission widens itself only by what it was allowed to create and the plugin read from the
  answer; it never reaches what someone else created (that needs an edit or scope `connection`).
- A plugin that adds a creating tool must declare it; `definePlugin` refuses the list without the
  hook, and a structural test pins the table.
- A failure to record or discover is logged and never changes the call's outcome; an unreadable
  answer (`[]`) falls back to discovery.
- Discovery does not stale a row first seen less than 15 minutes ago. Discoveries are coalesced per
  connection, in one process (`// single-process only`).

## Rejected alternatives

### Refresh on every call, on a schedule, or on the request path

Doubles provider traffic, keeps the latency, or slows the call by a whole discovery that still
fails when the provider lists late.

### Let the plugin write the row itself

Gives plugins a write path into the store; the host keeps the one merge.

### Infer the created ref from names or arguments

Many `create_*` tools create objects inside a resource, and providers name the object themselves.

### Reach every resource created on the account

That is scope `connection`, chosen explicitly at issuance.
