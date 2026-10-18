---
title: The built-in preset "Everything I hold on this account" expands into the explicit list at preview and issuance
status: accepted
date: 2026-10-18
extends:
  - pivot-to-risk-based-model
  - provider-reference-and-policy-modes
  - mission-pages-confirm-the-explicit-list-and-ask-before-a-key-stops
  - fallback-risk-only-when-uncategorized
  - connection-default-environment-label
---

# The built-in preset "Everything I hold on this account" expands into the explicit list at preview and issuance

> Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §0 "Preset", §3.1
> "Enumeration", §3.2 "Presets, per plugin", §4.1 bis, §4.2 "New mission".
> Handbooks: [missions](../handbook/missions.md) "Presets",
> [management-door](../handbook/management-door.md). Code:
> `apps/gateway/src/server/missions/everything-i-hold.ts`.

## Context

A mission policy is an explicit enumeration `RiskId → (quota, rate limit,
gate)`; a preset is a plugin's named policy fragment that pre-fills it. Every
shipped preset is a curated subset (`read-only`, `developer`, `operator`…).
None means "everything the creator's authority covers".

Some creators want exactly that: a solo developer running their own agents on
their own accounts, an operator preparing a break-glass mission. Today they
enumerate every RiskId with a quota and a rate limit by hand. On a real
instance that was 87 lines over five connections, and a rate above a catalog
ceiling is refused one risk at a time (`invalid-budget`), so the list is
corrected in several rounds.

The product invariant stays: **no wildcard, no sentinel, no "everything"**
anywhere in a share, a mission, a token or the audit (spec §3.1
"Enumeration", pivot ADR D3). Whatever makes the wide mission easy must
produce the same explicit list a patient person would have typed.

## Decision

1. **A built-in preset, id `everything-i-hold`, label "Everything I hold on
   this account"**, is offered on every connection next to the plugin's
   presets: in the creation form (a chip before "Custom") and on the
   management door (`connections[].preset` of `preview_policy` /
   `issue_mission`). It is defined by the gateway, not by a catalog, and no
   plugin may ship a preset with that id (structural test).

2. **It is expanded at preview and at issuance into explicit lines**, by
   `everythingIHold(connection, selected)`: every id of the connection's
   catalog that
   - the creator's authority covers now (`authority`, exactly the list
     `list_my_connections` returns as `authority.risk_ids`),
   - is not deprecated (as "select all" and the plugin presets, which leave
     deprecated ids out), and
   - the selected resources can reach (`isResolvable`): an
     environment-qualified id only when a selected resource carries that
     label — its own or the connection's default environment — or the plugin
     derives the environment from the call.

   The expansion is an ordinary `Preset` value handed to the same
   `previewConnection` path as any plugin preset, so the checks of an
   issuance (authority, resolvability, budget, ceiling) apply unchanged and
   `issue()` recomputes it server-side. The stored policy is the explicit
   list; the mission keeps no preset reference; `list_my_missions`, the
   mission page and the bootstrap kit list the lines. A later change of
   authority or catalog does not widen the mission (same rule as every
   mission).

3. **The fallback id is included**, because the choice is precisely
   "everything I hold"; it is named in the preview notice and in the form.
   This is the one preset allowed to carry it: catalog presets still may not
   (ADR fallback-risk-only-when-uncategorized D3).

4. **Budgets come from one documented rule**, per line, gate always `auto`:
   - **rate limit**: the catalog ceiling (`infra_limits.calls_per_minute_max`)
     per 60 s when the entry sets one; else the largest rate any preset of the
     plugin gives that id or its base id (compared per minute); else by
     severity level — low 120, medium 60, high 20, critical 5 per minute;
   - **quota**: the largest quota any preset of the plugin gives that id or
     its base id; else by severity level — low 5000, medium 1000, high 200,
     critical 50 per period.

   The values are sized for a period of one day, the form's default; the
   door's `period` stays mandatory and its descriptions recommend
   `{ kind: 'recurring', length_seconds: 86400 }`.

5. **No gate is added silently, and nothing critical is hidden.** The preview
   carries a notice `everything-i-hold-expanded` per connection: how many
   explicit lines, the most severe, the critical ones (catalog severity,
   which run freely), and the fallback by id. Its `risk_ids` are the critical
   ids plus the fallback. The form's panel says the same in the interface's
   words, and creating still confirms the explicit list (ADR
   mission-pages-confirm-the-explicit-list-and-ask-before-a-key-stops): a
   person confirms a list, never a word.

6. **Discovery on the door.** `list_my_connections` lists it in `presets`
   with `built_in: true`, `within_authority: true` (by construction) and
   `risks`, its count on that connection with every resource known now;
   `get_catalog` with a `connection_id` lists it with its explicit entries.
   Without a connection there is nothing to expand, and `get_catalog` leaves
   it out.

## Consequences

- A wide mission is one choice per connection instead of dozens of lines,
  and its policy is accepted at the first preview: every rate is within its
  ceiling by construction.
- The gateway now ships budget values of its own (the severity tables
  above). They apply only where no preset of the plugin speaks for the id —
  typically the fallback and ids no curated preset includes.
- A mission issued with it is indistinguishable, once stored, from one typed
  by hand. The audit's `mission-issued` entry carries the explicit policy, not
  the preset id.
- The wording on the page and the notice are the only places the word
  "everything" appears, and both are followed by the list.
- A creator whose authority is narrowed later sees the mission orphaned like
  any other; a creator whose authority grows does not see the mission grow.

## Rejected alternatives

- **A wildcard or `*` risk** (`fly.*`, `accepted_risks: ['*']`). Rejected by
  principle: the enumeration invariant exists so that every stage of the chain
  can be read and compared as a list, and a risk added to a catalog never
  enters a mission nobody re-read.
- **A mission flag "all current authority", resolved at call time.** The
  mission would widen silently whenever the creator's authority or the
  catalog grows, which is exactly what the monotonic, enumerated chain
  forbids; nobody would ever have confirmed what the agent can do.
- **Per-provider "owner" presets maintained by hand in each catalog.** Every
  catalog change would need the matching preset edit, the fallback would
  have to be allowed in catalog presets again, and a preset written for an
  owner says nothing about a creator who holds a share: it would drift from
  both the catalog and the authority it claims to mirror.
