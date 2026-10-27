---
title: No experimental plugins — every registered plugin is offered and lists its tools
status: accepted
date: 2026-10-27
author: Renaud Pelissier (product owner), drafted with Claude
amends:
  - plugin-contract-and-credential-spec
---

# No experimental plugins — every registered plugin is offered and lists its tools

> Decided by the product owner on 2026-10-27: Gmail is no longer
> experimental, and the "experimental" distinction goes away. Handbooks:
> [plugin-sdk](../handbook/plugin-sdk.md),
> [execution-door](../handbook/execution-door.md),
> [management-door](../handbook/management-door.md),
> [providers/gmail](../handbook/providers/gmail.md).

## Context

ADR [[plugin-contract-and-credential-spec]] (amendment P1.2-align) gave
`ProviderPlugin` an optional `experimental?: boolean`: a plugin the host
registers and classifies, but keeps out of the default connect and issuance
flows and whose tools it never lists. Gmail was its only user, from the time
it was a classifier without executable tools.

Since ADR [[gmail-over-imap-with-an-app-password]] Gmail executes twelve
tools. The flag then produced a user-visible bug: the execution door skipped
experimental plugins in `tools/list` and in the catalog, so a mission that
accepted Gmail risks listed no Gmail tool to the agent's MCP client. The
flag also spread through the code base: a toggle and a tag on the mission
form, a callout on the connect page and the reference, a badge, an
`include_experimental` input and a `hidden_experimental` count on the
management door's `list_my_connections`, and a `status` on the public site.

## Decision

- `ProviderPlugin.experimental` and `ProviderLabel.experimental` are removed
  from the plugin SDK. A registered plugin is offered in the connect and
  issuance flows and lists its tools to agents, like any other.
- The execution door lists, and lets a mission call, the tools of every
  plugin the mission holds an account of and accepts a risk of.
- `list_my_connections` lists every connection the user may delegate; the
  `hidden_experimental` output is gone. Its input schema is strict, so the
  retired `include_experimental` stays accepted, and ignored, so that a
  client written against an earlier build is not refused.
- The web interface drops the "Show experimental services" toggle, the
  "experimental" tag, callouts and badge; the reference lists the plugins in
  registration order.
- The public site drops the plugin `status` (pages and `/plugins.json`):
  with one state left it would always read `stable` and say nothing.
- Gmail moves to version `1.0.0`; a young plugin says so with a version
  below `1.0.0`, as the plugin guide's semver table already treats it.

## Consequences

- Gmail connections appear in `list_my_connections`, on the mission form
  and in the reference like the others; a reader holding a single other
  account plus a Gmail one no longer finds the other account included up
  front, since there are now two.
- A third-party plugin that still sets `experimental` fails to type-check
  against `definePlugin`; removing the line is the whole migration.
- `/plugins.json` loses `status`. No consumer in the repository read it.
- There is no way left to ship a plugin that is registered but hidden. A
  plugin that is not ready is not added to `SHIPPED_PLUGINS`.

## Rejected alternatives

- **Keep the flag for future plugins, only drop it from Gmail.** Gmail was
  its only user; a state where a mission accepts risks whose tools are never
  listed confuses mission holders (it caused the bug above); and a version
  below `1.0.0` already says "young" without hiding anything.
- **Keep the flag but list the tools of an experimental plugin.** It would
  leave a badge with no behaviour behind it, and every surface would still
  carry the field.
- **Keep `status` in `/plugins.json`, always `stable`.** A field with one
  value informs no reader; nothing consumes it.
