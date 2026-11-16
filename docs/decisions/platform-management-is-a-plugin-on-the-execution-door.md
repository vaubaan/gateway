---
title: The gateway's own management tools are a plugin on the execution door; the OAuth authorization server and delegations are retired
status: accepted
date: 2026-11-14
author: Renaud Pelissier
---

# The gateway's own management tools are a plugin on the execution door; the OAuth authorization server and delegations are retired

## Context

Agents prepared missions through a second MCP door, `/mcp/manage`, with its own credential (an
OAuth delegation issued by the instance), its own consent page, a Settings page ("Connected apps")
and no risk catalog: what an agent could do there was written nowhere a person could compare with
the other services. Everything else an agent does follows one circuit: an account, a mission with
explicit permissions and limits, the execution door, the audit and the Reference.

## Decision

The gateway's own management surface is a provider plugin, `vaubaan`, with a risk catalog,
macro-actions, a data model and a Reference page like every service. A person connects "Vaubaan" in
one click (a host-held account with no secret, owned by that person, never shareable), issues a
mission on it, and an agent calls the `vaubaan__*` tools on `/mcp` with a mission token. The
plugin's `execute` is composed by the host from the same mission-service ports the former door
held, never through the SDK. `/mcp/manage`, the authorization server, client registrations and
delegations are removed. A mission never acts on itself: one holding a `vaubaan` account can neither
edit, rotate nor revoke itself, and a mission it issues never carries a `vaubaan` account.

## Consequences

- Spec §6 keeps two credentials: the mission token opens `/mcp` and git, the human session the
  interface. "An executor cannot modify its mission" survives as the self rule above, checked in the
  host ports at every call whatever the stored selection says, like `isSelfResource`.
- The host's tools share the prefix `vaubaan__`: `request_permission` stays host-owned, routed by
  exact name before the registry, and the registry refuses a plugin tool whose name a host tool holds.
- The SDK gains one credential kind, `host`: no fields, no paste, no verify; only the host creates
  such an account, and a plugin declaring it loads only when the host composes it (bundled, never pinned).
- A mission prepared by an agent names the issuing mission where the delegated client was named:
  its audit entries and the Missions list.
- Missions issued by delegations keep working; the delegation and OAuth tables are dropped by
  migration, their configuration keys are ignored with a warning, and the Connected apps page goes.

## Rejected alternatives

### Keep the management door beside the plugin

Two circuits for one authority: two docs, two revocation paths, and still no risk page on one of them.

### The plugin loops back to `/mcp/manage` over HTTP with a token the host mints per call

Keeps the whole delegation machinery alive only to call the same process.

### A management plugin through the public SDK, handed a mission service

Breaks the plugin contract (a plugin knows neither the mission nor the budget) and `hard-deny.test.ts`; any third-party plugin could then ask for the same port.

### Rename to "Platform MCP" and document its risks by hand

The one Reference page whose source would not be a catalog.

## Amendment 2026-11-16: missions are renamed and edited from a mission

### Context

The plugin copied the seven tools of the retired door, which predated mission edit after issuance
([mission-editable-after-issuance](mission-editable-after-issuance.md), 2026-10-26). The absence of
an edit was inherited, not decided: an agent could issue, rotate and revoke a mission, but had to
revoke and reissue it (a new key handed over by a person) to change a name or a permission.

### Decision

Two tools join: `vaubaan__rename_mission` (risk `vaubaan.mission-rename`, row 1) and
`vaubaan__edit_mission` (risk `vaubaan.mission-edit`, row 2), both in **Prepare missions**: at
Careful a rename runs freely and an edit asks first, like issuing. Both go through the creator's own
"Edit mission" (`MissionService.edit`): same key, one version in the History authored by the calling
mission, one `mission-changed` entry with `via_mission_id`, bounded by the creator's authority now
and refused whole (`uncovered`) beyond it. `vaubaan__preview_policy` takes an optional `mission_id`
to preview the edit. The self rule is unchanged and covers both: the calling mission neither renames
nor edits itself, and an edit never adds a Vaubaan account. The host ports gain `editView`,
`previewEdit` and `edit`; `setGate`, `setLimits`, `changePermissions`, `restore`, `duplicate` and
`verifyToken` stay out.

### Consequences

- A gate or a limit moves from a mission only inside a whole edit, judged as at issuance; nothing
  answers a request or opens a gate alone.
- Catalog version 2; plugin 0.4.0. A platform mission issued before keeps its explicit list: it gains
  the new risks only when its creator edits it.
