---
title: A mission is edited after issuance, without limit, by its creator — judged by issuance's own check on what moves, applied at once to the same token, session and counters
status: accepted
date: 2026-10-24
supersedes:
  - mission-limits-editable-after-issuance
extends:
  - mission-permissions-and-explicit-requests
---

# A mission is edited after issuance, without limit, by its creator

> Product owner's decision of 2026-10-24: "a mission can be modified while it
> runs, without limit on what can be changed, under the rights of its creator."
> Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §3.1, §3.2, §3.3 bis, §3.4,
> §4.2, §7.6, §7.8. Handbooks: [missions](../handbook/missions.md),
> [budget-and-sessions](../handbook/budget-and-sessions.md),
> [web-app](../handbook/web-app.md), [requests](../handbook/requests.md).
> Supersedes [mission-limits-editable-after-issuance](mission-limits-editable-after-issuance.md);
> extends [mission-permissions-and-explicit-requests](mission-permissions-and-explicit-requests.md).
> Builds on [atomic-budget-accounting](atomic-budget-accounting.md).

## Context

After issuance a creator could change the limits of the permissions already in a
mission (`setLimits`), its gates (`setGate`), and add or remove permissions on its
existing accounts and resources (`changePermissions`). Nothing else moved: no
resource, no account, not the name, not the expiry. Yet the spec ("a resource
discovered later is not covered until the creator adds it", §3.1) and the agent's
`resource-not-in-mission` hint ("ask the mission creator to add the resource")
promised an edit that did not exist. Verified live on 2026-10-24: the owner's Miro
mission could not be given a board created after issuance; the only path was
"Duplicate", which hands the agent a new key, a new session and counters at zero.

Three edits with three rules also meant three places to keep in step. The owner
asked for one edit of the whole mission, by its creator, with no limit on what
moves.

## Decision

1. **One edit of everything a draft holds.** `MissionService.edit(user, missionId,
{ draft, revision })` takes the same `MissionDraft` a creation takes — name,
   expiry, the accounts of the mission (added or removed), per account its resource
   scope (`all` / `connection` / `selected`) and its resources, its permissions
   (added or removed) with their quota, rate limit (calls and window) and gate — and
   makes the mission be that draft. `revision` is the mission's revision the editor
   started from (`missionRevision`, a digest of everything an edit may move): a
   mission changed meanwhile answers `conflict` and nothing is written.
   `POST /api/missions/:id/edit` (and `…/edit/preview`, which writes nothing) carry
   it. `setLimits`, `setGate` and `changePermissions` stay as narrower entry points
   (the limits deep link, the gate switch, the answer to a permission request).

2. **Not the period.** The reset period (one-off, or its length) is the key of the
   counters (`session_counters.period_start`), of the claims' credits and of the gate
   openings. Changing its length mid-flight moves the start of the current period:
   either every counter silently restarts from zero — a reset nobody asked for, which
   a claim exists to grant — or the counters must be moved to a new key, after which
   the structural check (`SUM(counters) + credits == COUNT(audit allowed)` over the
   period's interval) no longer holds for the period that straddles the change. An
   edit whose period differs from the mission's is refused with the issue
   `period-not-editable`; the creator duplicates the mission to get another period.

3. **Who.** The creator only, like every mutation of a mission: a teammate, an
   administrator as such, an owner of one of its accounts and anyone else are
   answered "not found". The management door is not handed the method
   (`ManagementMissions` is a `Pick` without it; `hard-deny.test.ts` asserts it): a
   connected app never changes a live mission's authority. A revoked or orphaned
   mission is not edited (`gateEditBlockedBy`); an expired one is, and an expiry moved
   into the future brings a mission stored `expired` back to `active`, as a claim's
   `extend-expiry` does.

4. **Judged by issuance's own check, on what moves.** The edit is never judged by a
   second rule. The edited draft goes through `previewDraft` — the creation's
   preview — under the creator's authority **now** (`issuanceContext`), and the
   refusal carries its issues word for word. But a creation judges everything, and an
   edit must not be refused because of a fact unrelated to what it changes (the lesson
   of the superseded ADR: a lowered limit refused because a resource went stale). So
   the issues of that preview are kept only when they are about something the edit
   moves (`judgeEdit`, `missions/mission-edit.ts`, pure and shared with the form):

   | The edit                                                                                                     | Issues of the creation's preview that count                                                                                                                     |
   | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | changes the name                                                                                             | `name-missing`                                                                                                                                                  |
   | changes the expiry                                                                                           | `invalid-expiry`                                                                                                                                                |
   | changes the period                                                                                           | `period-not-editable` (point 2)                                                                                                                                 |
   | adds an account                                                                                              | every issue of that account                                                                                                                                     |
   | adds resources to a kept account, or widens its scope                                                        | the resource issues naming an added resource; `connection-unavailable`; `connection-unknown`                                                                    |
   | changes the selection of a kept account at all                                                               | `no-resource-selected`                                                                                                                                          |
   | adds a permission, or changes its quota, calls or window (up or down)                                        | the line issues naming it (`unknown-risk`, `exceeds-authority`, `unresolvable-env`, `missing-budget`, `invalid-budget`, `duplicate-risk`); `connection-unknown` |
   | adds a permission, or raises a quota or a rate, on a kept account                                            | `connection-unavailable`                                                                                                                                        |
   | adds or removes permissions of a kept account                                                                | `no-accepted-risk`                                                                                                                                              |
   | anything                                                                                                     | `no-connection`, `duplicate-connection`, `duplicate-provider`, `unknown-preset`, `connection-ambiguous`                                                         |
   | removes an account, a resource or a permission; narrows a scope; changes only a gate; leaves a line as it is | nothing                                                                                                                                                         |

   A gate alone is not judged (a gate is not part of what a share restricts, as for
   `setGate`). A lowered value is judged like a raised one, as before (it must still
   be a valid budget inside the authority); only the connection's own state
   (`connection-unavailable`: it needs reconnecting) does not block a narrowing.

5. **What is written: what moves, and what does not move as it is.** The new
   state is built from the stored mission, not from the preview: a line or a
   resource the edit leaves alone is written back exactly as stored — a stale
   resource kept in a selection stays in it (and comes back when discovery returns
   it), an unchanged line keeps its values. A moving line takes the values the preview
   resolved. "Every resource known now" chosen in an edit is resolved as at
   issuance: the explicit list of the resources known at that instant. An account the
   editor cannot show (the creator no longer has authority on it, or it was
   disconnected) is carried back unchanged by the form; dropping it is a removal, and
   is listed as one.

6. **Applied at once, same token, same session, same counters.** One `BEGIN
IMMEDIATE` transaction (`MissionsRepo.edit`) re-reads the mission, checks the
   creator, the stored status and the revision, then writes only the rows that move:
   the name and expiry; `mission_connections` and `mission_resources` rows added,
   removed or re-scoped (kept rows are not rewritten, so a column a later migration
   adds to them is not lost — `mission_resources.source` of ADR
   created-resources-join-the-mission keeps `issuance` or `created` on a kept row,
   and a resource row the edit adds is stored with `source = 'edit'`, which the
   mission page does not mark); `mission_policy` rows added, removed or updated. In the
   same transaction:
   - the open requests the edit makes moot are closed — a claim on a removed
     permission, an approval request that lists one: state `refused`, decided by the
     creator, `decision_json = { resolution: 'mission-changed', removed: [...] }`,
     sealed arguments erased, a `request` event on the session; permission requests
     are left open (an edit never makes asking for a permission moot);
   - unconsumed approvals covering a removed permission are retired (consumed), so a
     permission removed then added again never revives an old approval;
   - the session events below are recorded.

   **What a call sees.** Accepted risks, resources and gates are the caller's
   context, loaded when the call starts (`loadMissionContext`); limits and gates are
   read again by the budget inside its decision transaction (`DecideContext.limits`,
   `livePolicy`), and a touched risk no longer stored fails closed there. So:
   - a call **decided after the commit** sees the new limits, the new gates, and
     refuses a removed permission;
   - a call **already past its risk and resource stages** when the edit commits keeps
     its admission on resources (an in-flight call on a resource just removed may
     still run, once) and on accepted risks — except that the budget refuses it if a
     touched risk was removed meanwhile;
   - a **next call** loads the new context: a removed resource is refused
     (`resource-not-in-mission`), an added one is reached, an added permission starts
     at zero with its own limits.

   What was used stays used: a limit changed in the current period applies at once
   over the counters already there (a quota lowered under them leaves the permission
   exhausted until the reset or a claim); a permission removed then added again in the
   same period finds its counter as it was. Rate windows are in memory and keyed by
   mission and risk: a shorter window applies at once; a longer one counts only the
   calls the shorter window still remembered, so for one window's length after the
   change it can let through slightly more than the new rate — the same leniency as a
   restart of the instance.

7. **Trace.** One administrative audit entry `mission-changed` (object: the
   mission), its `before` and `after` holding only the sections that moved, each in
   full: `name`, `expires_at`, `connections` (the account ids), `resources` (per
   account that moved: scope and resource ids), `permissions` (each line that moved,
   with quota, rate limit and gate; an added line is only in `after`, a removed one
   only in `before`), plus `after.requests_closed`. On the session, when it exists:
   one `mission-changed` event (no risk; its details are the summary the activity
   words: "Changed the mission: 2 resources added, 1 permission removed, quota of
   github.read 200 → 500") and one event per permission that moved —
   `permission-added`, `permission-removed`, `limits-changed` (now also carrying the
   window when it moved), `gate-changed`. `permission-removed` ends a gate opening of
   that risk like `gate-changed` (`GATE_EVENT_KINDS`). The narrower edits keep their
   own acts (`limits-changed`, `gate-changed`, `permissions-changed`); the mission's
   activity shows all of them in one timeline.

8. **Interface.** "Edit mission" on the mission page (header and "···") opens
   `/missions/<id>/edit`: the creation form, prefilled from the mission, in edit
   mode — the name, the accounts with their resources and permissions, the expiry
   ("as it is" by default); the period is shown and fixed. "Save changes" opens a
   confirmation that lists every change before → after and what it means (a new
   limit already used up, a permission removed and the requests it closes, a resource
   that will stop being reached, the same key for every holder). "Change limits"
   (`?edit=limits`) keeps working. The bootstrap kit does not change: same token; the
   mission page and `GET /mcp/catalog` show the new state. The management door's
   `list_my_missions` reads the stored mission and reflects the edit.

## Consequences

- "Add the resource to the mission" is now true: the `resource-not-in-mission`
  hint and the form's "Every resource known now" explanation say so.
- A lost account can be replaced on the same mission by adding the account that
  replaced it (spec §7.8 used to require a new mission).
- `MissionDraft` is the one shape of "what a mission is" for creation, preview,
  duplication and edit; `judgeEdit` is the one place that says which creation issues
  bind an edit.
- The authority is checked before the transaction, as for an issuance; if it
  disappears in between, the mission reads `orphaned` and serves nothing.
- One more session event kind per moving section; old readers print an unknown kind
  as it is stored.
- 2026-10-27: the mission page's "Modify permissions" button and its page
  (`/missions/:id/permissions`, ADR mission-permissions-and-explicit-requests) are
  gone: a strict subset of "Edit mission", kept by oversight. `changePermissions` and
  its editor stay, for the answer to an agent's permission request only.

## Rejected alternatives

- **Re-run the whole `previewDraft` and refuse on any issue.** Refuses a lowered
  limit because a resource went stale or an account needs reconnecting.
- **A second validation written for edits.** Two rules would drift; the owner asked
  for one. `judgeEdit` only filters the creation's issues, it never words its own
  (but `period-not-editable`).
- **Allow the period to change.** Point 2: a silent reset or a broken counters/audit
  invariant. Duplicate the mission instead.
- **Write the whole state again (delete and re-insert every row).** Simpler, but it
  drops what a kept row carries beyond the edit (a later column such as the origin of
  a resource row) and rewrites history nobody touched.
- **Close every open request of the mission on any edit.** A claim on a permission
  whose quota was raised is still worth answering; only the requests of removed
  permissions are moot.
- **Let a connected app edit the missions it issued.** It may issue a wider mission,
  visibly; changing a live one in place would be an enlargement nobody sees issued.
