---
title: Missions — issuance, edit, members and keys, bootstrap kit
tracks:
  - apps/gateway/src/server/missions/
  - apps/gateway/src/server/authority/catalog-authority.ts
  - apps/gateway/src/server/store/membership.ts
  - apps/gateway/src/server/store/mission-reach.ts
  - apps/gateway/src/server/store/repositories/missions.ts
  - apps/gateway/src/server/execution/created-resources.ts
  - apps/gateway/src/app/(app)/missions/
  - apps/gateway/src/app/api/missions/
  - apps/gateway/src/app/agent-bootstrap.md/
last_reviewed: 2026-10-27
---

# Missions — handbook

How a mission is previewed, issued, edited, shared with teammates and handed to an agent. Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §0, §3.1–3.3 bis, §4.2, §4.4, §7.4–7.9 bis; who may delegate what: [authority](authority.md). ADRs: [preset-everything-i-hold-expands-explicitly](../decisions/preset-everything-i-hold-expands-explicitly.md), [mission-reaches-the-whole-connection-on-request](../decisions/mission-reaches-the-whole-connection-on-request.md), [created-resources-join-the-mission](../decisions/created-resources-join-the-mission.md), [mission-members-and-per-holder-tokens](../decisions/mission-members-and-per-holder-tokens.md), [mission-editable-after-issuance](../decisions/mission-editable-after-issuance.md), [permission-request-asked-by-the-agent](../decisions/permission-request-asked-by-the-agent.md), [mission-token-sha256-digest](../decisions/mission-token-sha256-digest.md).

## Start here

- [`mission-service.ts`](../../apps/gateway/src/server/missions/mission-service.ts) — every act on a mission: issue, preview, edit, gate, limits, rotate, revoke, `verifyToken`, `access`.
- [`preview.ts`](../../apps/gateway/src/server/missions/preview.ts) — `previewDraft`, the pure decision behind the form, the management door's `preview_policy`, `issue` and `edit`.
- [`everything-i-hold.ts`](../../apps/gateway/src/server/missions/everything-i-hold.ts) — the built-in preset and its one budget rule (spec §3.2; `RATE_BY_LEVEL`, `QUOTA_BY_LEVEL`).
- [`team-service.ts`](../../apps/gateway/src/server/missions/team-service.ts) — teammates and keys (member and named tokens).
- [`mission-reach.ts`](../../apps/gateway/src/server/store/mission-reach.ts) — what a mission reaches on a connection.
- [`bootstrap-kit.ts`](../../apps/gateway/src/server/missions/bootstrap-kit.ts) — what the agent is told.

## Invariants

- **One decision, run in the browser too.** `preview.ts`, `model.ts`, `catalog-view.ts`, `summary.ts`, `everything-i-hold.ts`, `mission-edit.ts` are browser-safe: the forms import them and show the server's own verdict. The `index.ts` barrel is server-only (`node:crypto`, argon2); never import it from those files.
- **The persisted policy is the enumeration.** `issue` recomputes any preset, `everything-i-hold` included, server-side and stores explicit lines only: the row, the token, the `mission-issued` entry and the kit never name a preset, so a later catalog or authority change cannot widen a mission.
- **One reach rule, three readers.** `reachedResources` is read at every request by the execution door (`loadMissionContext`), the mission detail and the kit, never cached, so the agent is never told it may touch what the door refuses.
- **`all` is a frozen list.** It is stored as the explicit ids known at issuance (an empty one reaches nothing); only `{ scope: 'connection' }` reaches resources found later, and nothing converts one into the other. A resource the mission's own creating call made joins its list (`CreatedResources.record`, after the call, before the answer).
- **Creator-only mutations.** Every mutation goes through `ownMission`, which knows only the creator; `access` gives read to the creator and current members. "Not found" and "not yours" are one answer everywhere.
- **One membership rule.** `membershipOf` (`store/membership.ts`) is read by `access`, `list`, `standingOf` and inside `MissionsRepo.issueToken`'s transaction; it lives in the store because that transaction reads it.
- **A token's standing is read, not remembered.** `standingOf` re-reads holder status and membership on every call, so removal and deactivation take effect without a write. The writes on remove, deactivate and re-add exist so a returning member starts with no token rather than an old Bearer working again.
- **The secret exists in one answer.** Only the issue, rotate or `tokens/mine` answer to its holder carries it; the store keeps prefix and SHA-256 digest; the kit's `mcp_json` references `${VAUBAAN_MISSION_TOKEN}`. A test searches everything the creator can read, and every column, for a member's secret.
- **No store record leaves.** Store records are camelCase; what crosses a handler, a page prop or an audit payload is snake_case, translated only in `budget/mapping.ts` and `connections/mapping.ts`. `issuedAuditOf` builds the `mission-issued` payload field by field (pinned by a test).
- **A refusal code needs its kit line.** `REFUSAL_GUIDANCE` is a `Record<RefusalCode, string>`, so a new code does not compile without one; `GET /agent-bootstrap.md` (`content.md`) is tested to document every code and to name no instance.
- **Pages decide nothing.** An act is shown when the server would take it (`MissionTeam`, the state); `gates_editable` and `limits_editable` come from `gateEditBlockedBy`, the same rule `setGate` and `setLimits` apply (`rules-read-by-pages.test.ts`).

## Traps

- **Two transactions at issuance.** The mission row and its first token are written apart; a mission left without a token is repaired by `rotate`.
- **The token insert checks again.** Services check mission and caller before minting, but other requests run while hashing. `MissionsRepo.issueToken` re-reads mission status and membership in the `BEGIN IMMEDIATE` transaction that inserts, else throws `TokenNotIssuableError`. Keep both checks: the service alone knows derived states (`expired`, `orphaned`), the insert alone cannot be raced (`team-interleaving.test.ts`).
- **One connection per provider** because `mission_policy` is keyed `(mission, risk_id)` and a `RiskId` starts with its provider: two GitHub connections would share one budget. Lifting it needs the connection in the policy and counter keys.
- **The environment label is the effective one** — the resource's own, else the connection's `default_env` — applied by the repository on read; changing a default relabels every resource inheriting it.
- **A base id of an env-scoped risk** is valid in a preset (expanded per environment the selection resolves) but `unknown-risk` in an explicit policy.
- **Severity orders, never decides.** `SEVERITY_RANKS` restates `RISK_VECTOR_AXES` because the shared barrel is server-only; a test asserts they agree.
- **`setGate` is single-process.** It reads the gate opening and writes the gate in two store calls; with a second process, move the decision into `MissionsRepo.setGate`'s transaction. It looks for the opening in the period running now even on an expired mission, else extending the expiry would revive it.
- **Wiring order.** The root builds missions before the `SessionService`, so `budget` defaults to `missionUsageReader(store.sessions)` — the same function, not a copy.
- **`changePermissions` has one screen**: `permissions-editor.tsx`, rendered by a permission request in Waiting for you. A hand edit of permissions is "Edit mission"; the mission page has no permissions page of its own (removed as a strict subset of the edit).
- **Management door limits.** A delegation rotates only the missions it issued (`not-issued-by-delegation`, mapped to 404); `edit` is not exposed there (`hard-deny.test.ts`).
- `preview(…, { assumedEnvs })` exists for the v4 importer's dry run ([import-from-v4](import-from-v4.md)); `issue` never takes it.
- The form's "Select all" leaves out deprecated ids and the `uncategorized-write` fallback; `everything-i-hold` includes the fallback and names it in its notice.
- The teammate picker lists every active address on purpose: a free-text field would confirm or deny any address typed (threat model, A25).

## Debug

- **`connection-unknown` on an existing account** → the reader is not its owner (or left the owning group), it is `revoked`, or its plugin is not registered (`root.registry.ids`).
- **Detail says "no resource" on an account that has some** → issued when it had none (or all hidden): it reaches none; edit the mission and pick them.
- **`risk-not-accepted` on one resource only** → the preview's `notices`: the resource has no label, or one no risk is acceptable in.
- **`unknown-risk` on `provider.name`** → an env-scoped risk: write `provider[env].name`.
- **"Needs an owner"** → derived per page load; reload after a re-share or a sign-in ([authority](authority.md)).
- **Edit answers `conflict`** → changed since opened (another tab, Change limits, a permission answer): reload. **`period-not-editable`** → duplicate instead.
- **A key is refused** → `retired/rotated`, `revoked`, `holder-removed`, `holder-deactivated`, or `unknown` (another instance, truncated, not `vbn_live_`).
- **A member does not see the mission** → needs a `mission_members` row with `removed_at IS NULL` and an active user.
- **`mission-token-revoked` (`member-removed`) right after `mission-member-added`** → the re-added member still held an old working token.
