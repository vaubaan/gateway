---
title: Missions — authority, issuance, presets, resources, members and tokens, bootstrap kit
status: current
date: 2026-10-13
last_synced: 2026-10-13
tracks:
  - apps/gateway/src/server/authority/
  - apps/gateway/src/server/missions/
  - apps/gateway/src/server/store/membership.ts
  - apps/gateway/src/server/store/errors.ts
  - apps/gateway/src/server/store/repositories/missions.ts
  - apps/gateway/src/server/users/service.ts
  - apps/gateway/src/app/(app)/missions/
  - apps/gateway/src/app/api/missions/
  - apps/gateway/src/app/agent-bootstrap.md/
  - apps/gateway/src/components/shell/AppShell.tsx
  - apps/gateway/src/components/risk/
  - apps/gateway/src/server/providers/
  - apps/gateway/tests/integration/missions/
  - apps/gateway/tests/e2e/v5/issue-mission.spec.ts
  - apps/gateway/tests/e2e/v5/team-mission.spec.ts
  - apps/gateway/migrations/0010_mission_members_and_token_holders.sql
  - apps/gateway/tests/e2e/v5/browser.ts
  - apps/gateway/tests/e2e/v5/instance.ts
  - apps/gateway/tests/e2e/v5/ephemeral-instance.ts
---

# Missions — authority, issuance, presets, resources, members and tokens, bootstrap kit

How a connection owner issues a mission — a per-`RiskId` `(budget, gate)`
policy on selected resources — and receives its token once. Spec:
[vaubaan-gateway](../spec/vaubaan-gateway.md) §0 (Mission, Mission policy,
Budget, Gate, Preset, Resource), §3.1, §3.2, §4.2 "Missions", §4.4, §7.4,
§7.8. Decisions: pivot ADR D4 (nullable expiry, mandatory budget),
[api-key-format-vbn-live-argon2id](../decisions/api-key-format-vbn-live-argon2id.md)
(the token format),
[mission-token-sha256-digest](../decisions/mission-token-sha256-digest.md)
(what is stored),
[fallback-risk-only-when-uncategorized](../decisions/fallback-risk-only-when-uncategorized.md),
[execution-door-json-faithful-arguments-and-shared-throttle](../decisions/execution-door-json-faithful-arguments-and-shared-throttle.md)
(a repeated `approval` ends an opening),
[management-door-rotation-scope-and-replay-trace](../decisions/management-door-rotation-scope-and-replay-trace.md)
(rotation through a delegation),
[mission-members-and-per-holder-tokens](../decisions/mission-members-and-per-holder-tokens.md),
[one-membership-rule-checked-in-the-token-insert](../decisions/one-membership-rule-checked-in-the-token-insert.md)
(who is on a mission, the token insert, the gates of an expired mission),
[decision-stages-fail-closed-and-audited](../decisions/decision-stages-fail-closed-and-audited.md)
(a call whose resources disagree on the environment).
Built on the [store](store.md) repositories, the
[plugin SDK](plugin-sdk.md) registry (catalogs, presets, `experimental`,
`envOf`), [connections](connections.md) (resources, their `env` labels, hidden
and stale flags), [budget and sessions](budget-and-sessions.md) (policy vocabulary,
mission state) and [authentication](authentication.md) (session, origin check).

## Layout

```
apps/gateway/src/server/authority/
  catalog-authority.ts   explicitRiskIdsOf(), fullCatalogRiskIds()  — a catalog as explicit ids;
                         uncoveredRisks() — the one "asked minus held"                              (pure)
  authority-service.ts   AuthorityService, ConnectionAuthorityService
                         (the rest of the module — grounds, shares — is in handbook authority)
apps/gateway/src/server/missions/
  model.ts               MissionDraft, IssuanceConnection, MissionPreview, PreviewIssue, PreviewNotice… (types)
  catalog-view.ts        enumerateCatalog(), severityOf(), isResolvable(), presetWidth()           (pure)
  preview.ts             previewDraft(), previewConnection(), expandPreset(), budgetProblem(),
                         envNotices()                                                              (pure)
  summary.ts             summarize() — the three lines; period / expiry phrases                    (pure)
  bootstrap-kit.ts       buildBootstrapKit(), REFUSAL_GUIDANCE, MISSION_TOKEN_ENV, AGENT_LABEL_*   (pure)
  draft-schema.ts        missionDraftSchema, parseMissionDraft() — zod shape check of a JSON draft; the schema is
                         also the input of the management door's `preview_policy` and `issue_mission`
  token.ts               mintMissionToken(), prefixOfBearer(), bearerMatches(), maskedToken()
  token-issuer.ts        issueTokenTo() — mints one token for one holder; the secret is in its return value only
  member-token.ts        reissueMemberToken() — a member's own token, issued or replaced: the one implementation
                         behind MissionService.rotate and MissionTeamService.generateToken (store, entry, event)
  token-name.ts          parseTokenName(), TOKEN_NAME_RULE — the name of a named token             (pure)
  team-service.ts        MissionTeamService: team / addMember / removeMember / generateToken /
                         createNamedToken / revokeToken / revokeTokensOfDeactivated
  team-handlers.ts       Request → Response handlers of /api/missions/:id/{members,tokens}/**
  mission-service.ts     MissionService: issuanceContext / preview / issue / draftFrom / duplicate /
                         rotate / revoke / setGate / verifyToken / provenToken / access / list / get /
                         stateOf / stateAfterRefusal / kitOf; gateEditBlockedBy(), tokenHolderOf()
  orphan-reason.ts       explainOrphan() — the sentences of the orphaned banner on /missions/<id>          (pure)
  handlers.ts            Request → Response handlers of /api/missions/**
  index.ts               createMissionsModule(deps) → root.missions; server-only barrel
  testing.ts             ACME_CATALOG, acmeConnection(), seedConnection(), catalogEnvs() — tests only
apps/gateway/src/server/store/
  membership.ts          membershipOf(), isOnMission(), MEMBERSHIPS — who a user is to a mission      (pure)
  errors.ts              TokenNotIssuableError, TOKEN_NOT_ISSUABLE_REASONS — a token insert the store refused
  repositories/missions.ts  MissionsRepo — issueToken() and addMember() are described below; the rest in handbook store
apps/gateway/src/app/(app)/missions/
  page.tsx               /missions — list
                         (the user comes from `currentUser()` in `@/lib/auth/session`; the bootstrap
                         operator sees `NeedsUser` from `@/components/auth/NeedsUser`)
  new/page.tsx           /missions/new — loads the issuance context (and ?from=<id>)
  new/mission-form.tsx   the one-page creation screen (client)
  new/form-state.ts      state and transitions of the form, Preset | Custom, explainPreset(),
                         editorRows() / filterRows() (pure, unit-tested)
  new/preset-panel.tsx   Preset mode of one connection: the choice, and what the chosen preset means (client)
  new/custom-editor.tsx  Custom mode of one connection: the granular editor (client)
  new/policy-lines.tsx   PolicyLines, FamilyList, SkippedList — the compact reading of a policy
  [id]/page.tsx          /missions/<id> — detail (links to its session page)
  [id]/session/page.tsx  /missions/<id>/session — counters, requests, timeline (handbook audit)
  [id]/mission-actions.tsx  Duplicate / Rotate / Revoke (client)
  [id]/gate-control.tsx  one button per policy row: Require approval / Set to auto (client)
  [id]/team-section.tsx  "Members and tokens": the reader's own token, members, tokens, the creator's two forms (client)
  [id]/team.module.css   styles of that section
  bootstrap-kit-view.tsx BootstrapKitView, RevealDialog (client)
  state-badge.tsx        StateBadge — the derived mission state (list and detail)
  message-of.ts          messageOf(), statedMessageOf() — the sentence a mission page shows for a refusal
                         of the mission API (pure, unit-tested)
  new/labels.ts          GATE_LABELS
  missions.module.css    styles of the Missions pages
apps/gateway/src/app/api/missions/   route.ts, preview/route.ts, [id]/rotate, [id]/revoke, [id]/gate,
                                     [id]/members, [id]/members/[userId]/remove, [id]/tokens, [id]/tokens/mine,
                                     [id]/tokens/[tokenId]/revoke — one-line adapters
```

`model`, `catalog-view`, `preview` and `summary` are **browser-safe** (values
only from `@vaubaan/shared/risk-id`, `@vaubaan/shared/domain` and
`@vaubaan/policy-engine`): the creation
form imports them directly and runs the same decision as the server. The
`index.ts` barrel is server-only (`node:crypto` and argon2 through `token.ts`).

The pages live in the `(app)` route group and take its layout: a web
session gets the `AppShell` (`components/shell/AppShell.tsx`), where "Missions"
is one of the seven entries of the side navigation (handbook
[web-app](web-app.md), "The shell"); until the "Now" page lands, the home (`/`)
shows this list too; a visitor with no session is
sent to `/login`. The
bootstrap operator has a session but is not a user: each page then renders
`NeedsUser` (a mission always has an identified human behind it).

## Authority

`AuthorityService.authorityOf(user, connection)` → `{ connectionId, provider,
basis, riskIds }`, implemented by `ConnectionAuthorityService`
([authority](authority.md) has the whole rule):

- the **owner** — the user who owns the connection, or any _current_ member of
  the group that owns it (`groups.groupsOf`, read on every call) — holds
  `fullCatalogRiskIds(catalog)`: every account-scoped id, and one id per
  `acceptable_in_envs` entry of every env-scoped risk
  (`supabase[staging].bulk-row-write`). It is the same set the store's
  `RegistryCatalogIndex` accepts, minus base ids of env-scoped risks;
- a **beneficiary** holds the union of the restrictions of the active shares
  of that connection made to them or to one of their current groups
  (`basis: 'share'`), kept to the ids the catalog still lists;
- everyone else, a user an operator deactivated, and any connection whose provider has
  no registered plugin, hold `basis: 'none'`, `riskIds: []`.

`connectionsOf(user)` lists the candidates of an issuance: owned connections
and connections shared with the user, every status. The root injects
`root.authority.service` through `MissionsModuleDeps.authority`; issuance and
preview are the same for an owner and a beneficiary, the `authority` list of
each `IssuanceConnection` is what differs.

A mission whose creator later loses that authority is `orphaned` for as long
as it is missing, and serves again when it is back — same token, same session,
same counters ([authority](authority.md), "Orphaned missions"). The state is
**derived, never stored**: the service takes `grounds: Pick<MissionGrounds,
'inspect'>` and reads every mission it loads through it (`access` and
`ownInspected` for one mission, `list` for all), so each of its answers is
about this instant:

| Method                           | On an orphaned mission                                                                                                                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`, `get`                    | `mission.status: 'orphaned'`, `state.kind: 'orphaned'`, `orphan: { cause, … }`                                                                                                                                             |
| `setGate`                        | `{ ok: false, reason: 'inactive', state: 'orphaned' }`                                                                                                                                                                     |
| `rotate`                         | `{ ok: false, reason: 'inactive', state: 'orphaned' }`                                                                                                                                                                     |
| `revoke`                         | revokes: the stored status goes `active` → `revoked`, terminal. The creator; **or, while the mission is orphaned, an owner of one of its connections** (handbook [authority](authority.md), "Closing an orphaned mission") |
| `orphanedOn(user, connectionId)` | the orphaned missions that carry a connection, for an owner of that connection; nobody else reads any                                                                                                                      |
| `draftFrom` / `duplicate`        | unaffected: a copy is a new issuance, checked against what the creator holds now                                                                                                                                           |
| `verifyToken`                    | returns the stored record; the door derives the state right after (execution-door)                                                                                                                                         |

`MissionOverview.orphan` (`MissionOrphanReason`: `cause`, `connection_id`,
`uncovered`) is `null` unless the mission is orphaned. `/missions/<id>` renders
it with `explainOrphan(orphan, connections)` (`orphan-reason.ts`, pure): a
banner that names the connection and the uncovered risks, says whether the
authority can come back (`reversible` is false for a revoked or missing
connection) and that the token, session and counters are kept. The page shows
"Revoke mission" on every mission that is not revoked yet, an orphaned or
expired one included; "Rotate token" only on an active one.

## The draft

```jsonc
{
  "name": "Ship the billing page",
  "connections": [
    {
      "connection_id": "…", // or "provider": "github" when the creator holds exactly one active one
      "resources": { "scope": "all" }, // or { "scope": "selected", "resource_ids": […], "resource_refs": […] }
      "preset": "developer", // optional, a preset id of the connection's plugin
      "policy": [
        // optional
        {
          "risk_id": "github.read-code",
          "quota": 42,
          "rate_limit": { "max": 60, "window_seconds": 60 },
          "gate": "auto",
        },
      ],
    },
  ],
  "period": { "kind": "recurring", "length_seconds": 86400 }, // or { "kind": "one-off" }
  "expires_at": null, // ISO-8601 or null
}
```

The policy is **partitioned per connection** in the draft itself. Two modes per
connection:

| Draft line          | Accepted risks                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preset`, no policy | the preset's entries, intersected with the authority and with what the selected resources can resolve; what is left out is reported in `skipped_from_preset`        |
| `policy` (± preset) | exactly the listed risks; a line that omits `quota` / `rate_limit` / `gate` takes the preset's entry for that risk (or for its base id); otherwise `missing-budget` |
| neither             | `no-accepted-risk`                                                                                                                                                  |

The creation form always sends the second mode with complete lines and `preset:
null`: what is persisted is the explicit enumeration, never a preset reference.

## The decision — `previewDraft(context, draft)`

Pure; `context` is `{ connections: IssuanceConnection[], now }` where each
`IssuanceConnection` carries the connection's resources, the catalog as explicit
rows (`CatalogRisk`), the creator's `authority` and its `basis` (`owner` or
`share`), the plugin's presets, `experimental` and `derives_env`. It never throws on a refusable draft: every
reason is a `PreviewIssue { code, message, connection_index?, connection_id?,
risk_ids?, resource_refs? }`, so everything is fixed in one pass.

| Code                         | When                                                                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name-missing`               | empty name, or longer than 120 characters                                                                                                            |
| `no-connection`              | no connection in the draft                                                                                                                           |
| `connection-unknown`         | unknown id **or** no authority on it (one answer, no probing); unknown provider; no id at all                                                        |
| `connection-ambiguous`       | `provider` names several active connections                                                                                                          |
| `connection-unavailable`     | the connection is not `active`                                                                                                                       |
| `duplicate-connection`       | the same connection twice                                                                                                                            |
| `duplicate-provider`         | two connections of one provider (see below)                                                                                                          |
| `resource-not-in-connection` | a selected id or ref is not a resource of that connection                                                                                            |
| `resource-stale`             | a selected resource is stale (discovery no longer returns it)                                                                                        |
| `no-resource-selected`       | `selected` scope with an empty list                                                                                                                  |
| `unknown-preset`             | not a preset of the plugin                                                                                                                           |
| `unknown-risk`               | not an explicit id of that connection's catalog: wildcard, sentinel, other provider, base id of an env-scoped risk, env outside `acceptable_in_envs` |
| `duplicate-risk`             | a risk listed twice in one partition                                                                                                                 |
| `exceeds-authority`          | accepted ⊄ authority; `risk_ids` is the uncovered list (spec §3.1 "Monotonicity")                                                                    |
| `unresolvable-env`           | env-qualified entries whose environment no selected resource carries                                                                                 |
| `missing-budget`             | an accepted risk with no resolved quota + rate limit                                                                                                 |
| `invalid-budget`             | quota / rate max / window not an integer ≥ 1, gate outside the closed set, or rate above the catalog's `infra_limits.calls_per_minute_max`           |
| `no-accepted-risk`           | a connection that ends up accepting nothing                                                                                                          |
| `invalid-period`             | recurring period outside 60 s … 366 days, or not an integer                                                                                          |
| `invalid-expiry`             | not a date, or not in the future                                                                                                                     |

The budget rule itself (positive integer quota, positive integer rate over a
positive integer window, gate of the closed set) is `budgetIssues` of
`@vaubaan/policy-engine` — the function the plugin SDK's catalog loader applies
to a preset entry. `budgetProblem(entry, risk)` calls it, words the first issue
for the creator, and adds the one check issuance owns: the catalog's rate
ceiling (`exceedsRateCeiling`).

`previewConnection(connection, draft, index)` is an orchestration of four named
steps, each returning values (no shared accumulator): `resolveResources` (the
selection and its issues), `resolvePreset` (the preset, its lines expanded
against the selection, the budget defaults of an explicit line),
`classifyLines` (each line into exactly one `LineBuckets` bucket, first reason
wins: duplicate, unknown, outside the authority, unresolvable environment, no
budget, invalid budget, else `passes`) and `issuesOf` (one issue per non-empty
refusing bucket, in the order of the table above; `invalid-budget` is one
issue per line, each naming its problem).

`MissionPreview` = `{ ok, issues, notices, name, connections: ConnectionPreview[],
policy, period, expires_at, summary, resolved }`. Per connection: `passes` (what becomes
callable, complete `MissionPolicyEntry` lines), `exceeds`, `unknown`,
`unresolvable`, `missing_budget`, `skipped_from_preset`, the explicit
`resources` and `resources_total`. `resolved` is the passing part of the draft
with every alias resolved; the form loads it after a proposal or a duplicate.
The management door answers `preview_policy` with this shape
(`management/views.ts` `previewView`; handbook [management-door](management-door.md)).

**Notices — what passes but the creator should know.** `notices` is a list of
`PreviewNotice { code, message, connection_index?, connection_id?,
resource_refs, risk_ids }`. A notice never blocks: `ok` is `issues.length === 0`
and ignores it. Both codes (`PREVIEW_NOTICE_CODES`) come from `envNotices` and
state one rule of the policy engine ([policy-engine](policy-engine.md)): at call
time an env-scoped risk touched on a resource whose environment label is
absent, or is not an environment the risk is acceptable in, **refuses the call**
(`risk-not-accepted`), whatever the mission accepts. On such a resource the
mission reaches the account-scoped risks only. (The same refusal meets a call
that names resources of different environments: none can be chosen for it —
ADR [decision-stages-fail-closed-and-audited](../decisions/decision-stages-fail-closed-and-audited.md), D2.)

| Code                          | When                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `resource-without-env`        | a selected resource has no environment label, on a connection whose catalog has env-scoped risks                 |
| `resource-env-not-in-catalog` | a selected resource is labelled with an environment (`dev`, a typo) that no risk of the catalog is acceptable in |

`resource_refs` carries the refs of the resources, `risk_ids` the env-scoped
ids the draft accepts on that connection (unreachable there). The message
names each resource as the pages do, by its **display name** (its ref when it
has none) — the ref, a UUID at some providers, is for whoever reads the notice
as data — then the labels the catalog knows and the remedy: label the resource
on the connection's page, or leave it out. Nothing is emitted when the plugin derives the
environment from the call (`derives_env`, today Vercel) or when the catalog has
no env-scoped risk. This is separate from `unresolvable-env`, which refuses an
env-qualified entry that _no_ selected resource can resolve: a notice is about a
mission that is issuable and still cannot do, on one resource, what its policy
suggests. The creation form lists them under the issuance bar and `POST
/api/missions/preview` returns them.

**Hidden and stale resources** (handbook [connections](connections.md)).
`IssuanceResource` carries `hidden` and `stale` (`staleSince !== null`).
`defaultResources(connection)` — neither hidden nor stale — is what
`{ scope: 'all' }` resolves to and what the form ticks by default. A creator may
select a hidden resource explicitly (the form lists it, unticked, with a
`hidden` badge); a stale one is never accepted (`resource-stale`; its checkbox
is disabled), so it cannot resolve an env-qualified risk either.
`resources_total` — the "M" of "N of M resources" — is the default set plus the
hidden resources selected on purpose.

**One connection per provider.** `mission_policy` is keyed `(mission, risk_id)`
and a `RiskId` starts with its provider: two GitHub connections in one mission
would share one partition and one budget, and the execution door could not tell
which one a tool call targets. The draft is refused (`duplicate-provider`); the
creator issues a second mission. The message names the two connections, says
that risks and budget are counted per provider, and says to keep one and issue
a second mission for the other. Kept for now (product owner, 2026-10-13):
lifting it needs the connection in the key of the policy and of the counters.

**Env-qualified ids.** `isResolvable(risk, connection, selected)`: an
account-scoped id always resolves; an env-qualified id resolves when a selected
resource carries that label, or when the plugin derives the environment from the
call itself (`ProviderPlugin.envOf`, today Vercel: `derives_env: true`), in
which case resource labels are irrelevant.

**Base ids in presets.** A preset entry may name the _base_ id of an env-scoped
risk (Stripe's `read-only`: `stripe.read-catalog`, "of the selected mode"). The
runtime never matches a base id of an env-scoped risk, so `expandPreset` turns
such an entry into one explicit line per environment the selection resolves
(`stripe[test].read-catalog`, …), with the entry's budget; with none, the entry
is skipped (`unresolvable-env`, `env: null`). In an explicit `policy` a base id
of an env-scoped risk is an `unknown-risk`.

### Severity (ordering only)

`severityOf(vector)` sums the rank of each of the six axes (mildest = 0), 0–14;
`severityLevel`: 0–3 `low`, 4–6 `medium`, 7–9 `high`, ≥ 10 `critical`.
`enumerateCatalog` resolves `vector_overrides` per env, so `x[prod]` may rank
above `x[staging]`. It orders, labels and names "the most severe" — no decision
reads it. `SEVERITY_RANKS` restates `RISK_VECTOR_AXES` (the shared barrel is
server-only); a test asserts the two are equal.

## Presets

Presets are the plugins': `registry.presetsOf(provider)`, shipped in each
`risk-catalog.yaml` and validated by the SDK loader (at least one per plugin,
never the fallback). The gateway defines no preset and no budget value of its
own. The values in force are therefore the catalogs' — at this commit:

| Plugin         | Presets (entries)                                                 |
| -------------- | ----------------------------------------------------------------- |
| github         | `read-only`, `developer`, `release-manager`                       |
| supabase       | `read-only-analyst`, `staging-developer`, `migration-operator`    |
| vercel         | `read-only`, `developer`, `operator`                              |
| railway        | `read-only`, `developer`, `operator`                              |
| stripe         | `read-only` (base ids), `test-mode-developer`, `finance-operator` |
| ssh            | `read-only`, `developer`, `operator`                              |
| cloudflare-dns | `read-only`, `dns-operator`, `zone-admin`                         |
| upstash-redis  | `read-only`, `developer`, `operator`                              |
| resend         | `read-only`, `developer`, `marketing-operator`, `domain-admin`    |
| gmail          | `read-only`, `developer` (plugin `experimental`)                  |

They are provisional until the `mission-presets-default-values` ADR (plan §5.5).
The picker labels each preset with its width on this connection
(`presetChoiceLabel`, `new/form-state.ts`: number of risks, how many need
approval). `presetWidth` / `describePresetWidth` (`catalog-view.ts`: risks,
most severe, largest quota, approvals) are exported and unit-tested, and no
page calls them. The integration
suite previews every preset of every plugin the app depends on for an owner
whose resources carry every environment label of the catalog, and expects no
issue and nothing skipped.

Defaults the form adds: period **daily reload** (`DEFAULT_PERIOD`), expiry
**never** (`DEFAULT_EXPIRY`), gate `auto` when a line names none. "Never"
is decided, not an oversight (product owner, 2026-10-13, ADR
[owner-decisions-of-2026-10-13](../decisions/owner-decisions-of-2026-10-13.md)):
a mission is bounded by its budget, its gates and its revocation, and a
default date would stop scheduled agents at a moment nobody chose.

## Issuance — `MissionService.issue(user, draft)`

1. `issuanceContext(user)`: `authority.connectionsOf(user)`, minus `revoked`
   connections and those with no registered plugin or an empty authority; for
   each, `connections.listResources` (hidden and stale rows included, flagged),
   `enumerateCatalog`, `presetsOf`.
2. `previewDraft`. Not `ok` → `{ ok: false, reason: 'refused', preview }`,
   nothing written.
3. `missions.create`: `creatorUserId`, `periodSeconds` (null for one-off),
   `expiresAt`, the policy lines (`policyEntryRecordOf`), and per connection the
   **explicit resource ids** with `resourceScope: 'selected'` — also when the
   draft said `all` (then: the resources neither hidden nor stale), so a
   resource discovered later is not covered (spec §3.1). A connection on which
   nothing resolved (no resource known, or every resource hidden) is stored
   `all` with an empty list, because the store refuses an empty `selected`
   (`selectionRecordOf`). See "What a mission reaches" below for how that row is
   read.
4. Token: `issueTokenTo` (`token-issuer.ts`) for the creator as holder
   (`{ kind: 'member', userId: creatorUserId }`): `mintMissionToken()` →
   `vbn_live_<8>_<32>` and its SHA-256 digest; a prefix already taken is
   re-drawn (up to 5 times); `missions.issueToken` stores prefix + digest +
   `hashAlg: 'sha256'` + the holder + `createdBy`, after checking in its own
   transaction that the mission is active and the holder on it ("The token
   insert checks again" below).
5. Admin audit `mission-issued`; log line with the prefix. The `after` payload
   is built field by field by `issuedAuditOf` (type `MissionIssuedAudit`) in
   snake_case domain shapes only — the audit is immutable, so it never inherits
   the naming of a store record — and a test pins it:
   `{ name, connections: [{ connection_id, resource_ids }], policy: [{ risk_id,
quota, rate_limit: { max, window_seconds }, gate }], period: { kind,
length_seconds? }, expires_at, token_prefix }`. Never the secret.
6. Returns `{ ok: true, mission, token: { secret, prefix }, kit, preview }`.
   The secret exists nowhere else.

Mission creation and token insertion are two transactions; a failure between
them leaves a mission without a token, which `rotate` repairs.

`issue`, `duplicate`, `rotate` and `revoke` take an optional `IssueOptions {
delegation: { id, clientId } }`, set by the management door
([management-door](management-door.md)): an issued mission is stored with
that `delegationId`, and the `mission-issued`, `mission-rotated` and
`mission-revoked` entries carry `delegated_client_id`. The user stays the
actor and the creator. `MissionOverview.issuedVia` (`MissionIssuer`:
`delegation_id`, `client_id`, `client_name`) names the client behind a
delegated mission, read through `store.missions.issuersOf`: by `get` for any
reader, by `list` for the missions the reader created only (a mission shared
with a member is listed with `issuedVia: null`);
it is `null` for a mission issued in the interface. `/missions` marks such a
mission with a `delegated` badge and the client's name; `/missions/<id>` adds
an "Issued by" line with the client id, a link to `/delegations#<delegation_id>`
and the reminder that the name is the one the application gave itself.
`duplicate` also takes `overrides` for `name`,
`period` and `expires_at`, and answers `not-found` for a mission that is not
the creator's.

### What a mission reaches on a connection — one rule, three readers

A mission reaches, on each of its connections, **exactly the resource ids stored
at issuance that discovery still returns**. Scope `all` with an empty list means
"none known at issuance", never "everything discovered later". The execution
door enforces it (`loadMissionContext`, handbook
[execution-door](execution-door.md)); the two human-facing readers say the same
thing:

- `MissionService.get` (`detailConnections`) lists, per connection, the stored
  ids that are not stale — an empty list for a connection that had no resource
  at issuance, whatever it discovered since; the page then shows "no resource
  (account-level tools only)";
- the bootstrap kit (issuance, rotation, revisited page) is built from that same
  list, so the agent is never told it may touch a resource the door refuses
  with `resource-not-in-mission`.

A hidden resource selected on purpose stays reached (hiding is a listing
preference of the owner); a stale one is dropped by all three.

- **`draftFrom(user, missionId)` / `duplicate(...)`** — the creator's own
  mission as a draft: same connections, the selected resources that still exist
  and are not stale,
  the explicit policy split by provider, same period, **no expiry**, name
  `"<name> (copy)"`. `duplicate` issues it, so the copy is re-checked against the
  creator's _current_ authority and gets its own token, session and budget.
  A source that stored no resource on a connection is drafted `{ scope: 'all' }`:
  the copy is a new issuance and resolves "all" against the resources known when
  _it_ is issued, while the source keeps reaching none.
- **`rotate`** — creator only; the mission must be `active` and unexpired
  (`deriveMissionState`); the **creator's own** token becomes `rotated` and
  every other holder's token is untouched ("Members and tokens" below); audit
  `mission-rotated`; a `rotation` session event when the session exists.
  A mission revoked while the hash was computed is caught by the insert
  (`TokenNotIssuableError`): the answer is `inactive` with
  `stateAfterRefusal(missionId)`, and nothing is written.
  Through a delegation (`options.delegation`, the management door) only a
  mission that very delegation issued is rotated: any other answers
  `reason: 'not-issued-by-delegation'`, before the state is derived
  ([management-door](management-door.md), "Rotation reaches only what the
  delegation issued"). The human rotates any of their missions; the HTTP
  handler, which passes no delegation, maps that reason to 404 like
  `not-found`.
- **`revoke`** — creator only, idempotent; status `revoked`, every active
  token of every holder `revoked`; audit `mission-revoked`; `revocation`
  session event.
- **`verifyToken(bearer, legacyGate?)`** — `prefixOfBearer` (a `vbn_live_`
  key only) → `missions.findTokenByPrefix` → `bearerMatches` (the stored
  SHA-256 digest, compared in constant time; argon2id for a row an earlier
  build stored, after asking `legacyGate` when one is given, and then
  `rehashToken` to move the row to the digest — see
  [execution-door, "Token verification"](execution-door.md#token-verification-token-verifierts))
  → `standingOf`: `{ outcome: 'verified', mission, token }`, `{ outcome:
'retired', reason, mission, token }` or `{ outcome: 'unknown' }` (malformed,
  unknown prefix and wrong secret are one answer). `token` is a `VerifiedToken`
  — `{ id, prefix, holder }`: the token record and its hash do not leave the
  service. `reason` is a `TokenRetirement`: `rotated`, `revoked`,
  `holder-removed` or `holder-deactivated` ("What a token is worth" below).
  **`provenToken(prefix, tokenId)`** is the same judgement for a bearer whose
  hash match the execution door already holds in its cache: it re-reads the
  row and ends in the same `standingOf`.
  The execution door ([execution-door](execution-door.md), "Token holders")
  turns a retirement into a 401 that states the reason, and a token revoked
  with its mission into `mission-inactive` through gateway-core's
  `checkMissionActive`.
- **`access(user, missionId)`** — who may **read** a mission, and as what:
  `role: 'creator'`, or `role: 'member'` for a current member who is an active
  user; `null` otherwise (one answer for "does not exist", "not yours", "no
  longer shared with you"). The role is the membership `membershipOf` answers
  ("Who is on a mission" below). `get`, the session view and the team service
  read through it. Every mutation above goes through `ownMission`, which knows
  the creator only: a member gets `not-found`.
- **`stateAfterRefusal(missionId)`** — the state to report when the store
  refused a token insert because the mission stopped serving between the
  service's check and the write: the mission re-read and derived
  (`grounds.inspect`, `stateOf`), and `revoked` when it is gone or reads
  `active` again — the refusal itself is the fact. Used by `rotate` and by
  the team service.
- **`list` / `get`** — the missions the user created (`role: 'creator'`) and
  the ones shared with them as a member (`role: 'member'`: the rows
  `listForMember` returns, each kept only if `membershipOf` says `member`),
  newest first, each
  with its state, its `creator` (`{ id, email }`) and the prefix of the
  reader's **own** active token (`null` for a member who has not generated
  theirs); `get` adds connections, the resources the mission reaches,
  labelled policy lines with what is left this period, and the kit with the
  masked prefix. The state comes from the budget's single "load counters,
  derive state" read (`SessionService.stateOf`, handbook
  [budget-and-sessions](budget-and-sessions.md)), which loads the counters of
  the current period only: listing missions costs the same on day 300 as on
  day 1.

### Records and views

Store records (`MissionRecord`, `ConnectionRecord`, …, camelCase) are the read
model of the service; what leaves it is a snake_case view. The translations
have two homes and no other: `budget/mapping.ts` (policy entry in both
directions — `policyEntryOf` / `policyEntryRecordOf` —, the period —
`periodOf`, `statedPeriodOf`, `budgetPeriodOf` —, `isStale`, the counter) and
`connections/mapping.ts` (`connectionSummaryOf`, `connectionOwnerOf`). The rule:
**no `*Record` crosses an HTTP handler, a page prop or an audit payload.**

Where it holds today: every handler answer (`{ id, name }`, `{ id, status }`,
the kit, the preview), the `mission-issued` / `mission-rotated` /
`mission-revoked` audit payloads, `TokenVerification.token`. Where it does not
yet, because the consumers are pages and the audit module: `MissionOverview.mission`
(a `MissionRecord`, read by `/missions`, `/missions/<id>` and the session view)
and `MissionOverview.token.createdAt`; `IssueResult.mission` /
`RotateResult.mission` / `RevokeResult.mission` (records inside the service
result, reduced to `{ id, name }` by the handlers); `TokenVerification.mission`
(the door maps it with `loadMissionContext`).

The store's camelCase policy entry and selection are named `MissionPolicyEntry`
and `MissionConnection`, like the shared and gateway-core domain types; the
store's names are its contract, so consumers alias them (`…Record`).

"Not found" and "not yours" are one answer everywhere (`not-found`).

## Members and tokens — `MissionTeamService` (`team-service.ts`)

Spec §0 "Mission member", "Mission token"; §7.9 bis "Work on a mission as a
team". ADR
[mission-members-and-per-holder-tokens](../decisions/mission-members-and-per-holder-tokens.md).
Built by the module as `root.missions.team`.

A mission has **one or more tokens, each with one holder**, so that every call
through the execution door is attributed:

| Kind     | Holder                                                            | Generated by           | The secret is shown, once, to |
| -------- | ----------------------------------------------------------------- | ---------------------- | ----------------------------- |
| `member` | a member of the mission: its creator, or a user the creator added | that member, signed in | that member only              |
| `named`  | something with no account, identified by its name                 | the creator            | the creator                   |

All tokens share the mission's resources, its policy and its **one** budget
(spec §3.2). The creator is a member **by construction** and has no row in
`mission_members`; the token a mission is issued with is the creator's own
member token.

| Method                                       | Who                                                                             | What it does                                                                                                                                                                                                                    | Audit act                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `team(user, id)`                             | creator, member                                                                 | members (creator first), the tokens that work now with holder, kind, created, last used, `mine`, `revocable`; `candidates` for the creator                                                                                      | —                                                                                              |
| `addMember(user, id, { email })`             | creator                                                                         | the target must be an **active user** (`findActiveUserByEmail`); refused on a revoked mission; no authority is checked on the member; a working token of theirs that predates the membership is revoked by the same store write | `mission-member-added`; `mission-token-revoked` (`member-removed`) when such a token was found |
| `removeMember(user, id, userId)`             | creator                                                                         | marks the row removed and revokes the member's token in **one store transaction**                                                                                                                                               | `mission-member-removed`                                                                       |
| `generateToken(user, id)`                    | creator, member                                                                 | a new member token for the **caller**; their previous one becomes `rotated`; the mission must serve calls, and the store checks again in the insert; returns the secret and the kit                                             | `mission-token-issued` (first) / `mission-rotated`                                             |
| `createNamedToken(user, id, name)`           | creator                                                                         | `parseTokenName`; the mission must serve calls; one active token per name (`name-taken`, checked before the hash and again in the insert); returns the secret and the kit                                                       | `mission-token-issued`                                                                         |
| `revokeToken(user, id, tokenId)`             | its holder, creator                                                             | one token, on its own; idempotent (`already: true`)                                                                                                                                                                             | `mission-token-revoked` (`by-holder` / `by-creator`)                                           |
| `revokeTokensOfDeactivated(actorId, userId)` | the users module (a deactivation, and a reactivation before the status returns) | revokes the tokens a user holds on missions they did **not** create                                                                                                                                                             | `mission-token-revoked` (`holder-deactivated`), one each                                       |

Token issuance and revocation also leave a session event when the session
exists: `rotation` (`{ token_prefix, token_kind, holder, replaced_prefix }`,
also for a holder's first token and for a named token, with `replaced_prefix:
null`) and `revocation` (`{ tokens_revoked: 1, token_prefix, token_kind,
holder }`: a token revoked on its own, the token of a member removed, a stale
token revoked as its holder is added again); a mission-wide revocation keeps
`{ tokens_revoked: n }` alone. `revokeTokensOfDeactivated` records none: the
actor of a session event is a user and the operator may be the bootstrap
operator, so its audit entries are the record.

**What a member can and cannot do.** A member reads the mission, its session
and its team, and manages their own token. They cannot edit the mission, its
gates, its members or its named tokens, nor see or answer its requests:
`MissionService` mutations and `RequestService` (`own`, the inbox) know the
creator only, and the team service answers `not-found` to a member for the
creator's acts (`tests/integration/missions/team.test.ts` tries each and
compares the store before and after). `MissionDetail.gates_editable` is
`false` for a member.

**Authority.** A member works under the creator's authority and needs no share
of the mission's connections (spec §11.2). `orphaned` is still derived from
the **creator** alone: it holds for every holder at once, and comes back for
every holder at once, same tokens.

**One implementation for a member's own token.** The creator's "Rotate token"
(`MissionService.rotate`) and "Generate / Rotate my token"
(`MissionTeamService.generateToken`, which the creator may use too) are the
same act on the same row. Both call `reissueMemberToken` (`member-token.ts`):
it mints and stores the token (the holder's previous active one becomes
`rotated`), writes `mission-token-issued` for a first token or
`mission-rotated` for a replacement — with the delegated client when the act
came through the management door — and records the `rotation` event. The
callers keep what differs: who may ask (the creator, within what a delegation
issued; any member), and what is handed back.

**The creator never sees a member's secret.** `generateToken` returns it to
the member who called, and `issueTokenTo` (`token-issuer.ts`) hands the store
a prefix and a SHA-256 digest. No method of either service, no handler answer
to the creator, no audit entry and no row carries it; a test reads everything
the creator can read, and every column of every table, and looks for it.

### Who is on a mission — `membershipOf` (`store/membership.ts`)

"Is this user the creator or a member of this mission, now?" is stated once:
`membershipOf(mission, userId, user, row)`, pure, takes the user's row (or
`null`) and their member row on the mission, removed or not (or `null`), and
answers one of `MEMBERSHIPS`:

| Membership    | When                                                                                       | On the mission (`isOnMission`) |
| ------------- | ------------------------------------------------------------------------------------------ | ------------------------------ |
| `creator`     | `mission.creatorUserId` is the user — whatever their status and whatever row exists        | yes                            |
| `member`      | an active user with a member row that is not removed                                       | yes                            |
| `deactivated` | a user who is not active (or unknown to the instance) and has a member row, removed or not | no                             |
| `removed`     | an active user whose member row is removed                                                 | no                             |
| `none`        | no member row                                                                              | no                             |

Deactivation is told before removal: it is the wider fact about the person.
The creator's own status is not judged here: a deactivated creator orphans the
mission (`MissionGrounds`), which is the mission's state, not a membership.

It lives in the store because one of its readers is a repository transaction
no service can reach into. The readers:

| Reader                                            | Decides                                                                             |
| ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `MissionService.access`                           | who may **read** the mission (`creator` or `member`; anything else is `null`)       |
| `MissionService.list`                             | which missions shared with the user are listed (`member` only)                      |
| `MissionService.standingOf`                       | whose Bearer **authenticates** at the execution door (below)                        |
| `MissionsRepo.issueToken`, inside its transaction | for whom a member token may be **inserted** ("The token insert checks again" below) |

The three service readers go through one private wrapper,
`MissionService.membershipOf(mission, userId, known?)`: the creator costs no
read; anyone else costs their user row (unless the caller already holds it)
and their member row. `store/membership.test.ts` (12) pins the rule, case by
case. ADR [one-membership-rule-checked-in-the-token-insert](../decisions/one-membership-rule-checked-in-the-token-insert.md), D1.

### What a token is worth — `standingOf`

One private function of `MissionService`, reached by `verifyToken` and by
`provenToken`, read from the store on every call:

1. a **member** token is judged on its holder's membership (`membershipOf`,
   above): `deactivated` → `retired / holder-deactivated`; any other answer
   that is not on the mission (`removed`, `none`) →
   `retired / holder-removed`. The creator's own token passes this step:
   its holder is `creator`;
2. a token row that is not `active` → `retired / rotated` or `revoked`;
3. otherwise `verified`, with the holder (`tokenHolderOf`: a member is shown
   by their email, a named token by its name).

Step 1 does not depend on any write having happened: removal and deactivation
are effective at the next call. The writes exist too (`removeMember`,
`revokeTokensOfDeactivated`, and the revocation `addMember` makes) so that a
member added again, or a user reactivated, starts with no token rather than
with an old Bearer working again. The creator's own token is not judged on the
creator's status: a deactivated creator orphans the mission instead,
reversibly.

### The token insert checks again — `MissionsRepo.issueToken`, `TokenNotIssuableError`

Every token goes through `issueTokenTo` → `store.missions.issueToken`. The
services check the mission and the caller **before** they mint the token, and
other requests run between that check and the insert (the mint and the
prefix lookup are awaited): a revocation, a removal or a deactivation
committed meanwhile must not be undone by the insert. So
`issueToken` reads the mission's stored status and, for a member token, the
holder's user status and member row (`membershipOf`) in the same
`BEGIN IMMEDIATE` transaction that retires the holder's previous token and
inserts the new one, and throws `TokenNotIssuableError` (`store/errors.ts`, its own
class apart from `InvariantError`) with one of `TOKEN_NOT_ISSUABLE_REASONS`:

| `reason`              | The store found                                       | `generateToken` answers                        | `createNamedToken` answers | `rotate` answers                 |
| --------------------- | ----------------------------------------------------- | ---------------------------------------------- | -------------------------- | -------------------------------- |
| `mission-not-active`  | the mission's stored status is not `active`           | `inactive` + `stateAfterRefusal` → 409         | the same                   | `inactive` + `stateAfterRefusal` |
| `holder-not-a-member` | a member token whose holder is not on the mission now | `not-found` → 404, what `access` would say now | —                          | — (the creator is always on it)  |
| `name-taken`          | a named token: an active one already carries the name | —                                              | `name-taken` → 409         | —                                |

Nothing is written when the insert is refused: no token, no audit entry, no
event, and the holder's previous token is not retired. The check made earlier
in the service stays — it gives the precise answer in the common case, and it
is the only one that knows a **derived** state (`expired` by its date,
`orphaned`); the check in the insert is the one that cannot be raced.
`tests/integration/missions/team-interleaving.test.ts` drives a removal, a
deactivation, a revocation of the mission and a second creation of the same
name between the check and the write.

`MissionsRepo.addMember` returns `{ member, tokenRevoked }`. A member starts
with no token: a working member token of that user found on the mission — one
that predates this membership — is revoked in the transaction that writes the
row, and returned; `tokenRevoked` is `null` otherwise, which is the normal
case since a removal revokes and the insert refuses a holder who is not on the
mission. The team service then records it like any revocation of one token
(`mission-token-revoked` with `reason: 'member-removed'`, and a `revocation`
session event).

`UserAdminService.reactivate` (`users/service.ts`) closes the same loop for a
user: before it restores the status it runs `closeHeldBy` — the user's
delegations, the member tokens they hold on missions of other creators
(`revokeTokensOfDeactivated`), their group memberships — each a no-op when the
deactivation completed; a step that fails stops the reactivation
([authentication](authentication.md), "Deactivating a user"). ADR
[one-membership-rule-checked-in-the-token-insert](../decisions/one-membership-rule-checked-in-the-token-insert.md), D2–D4.

### The name of a named token (`token-name.ts`)

`parseTokenName`: trimmed, inner runs of spaces collapsed, 1 to 60 characters
of letters, digits, spaces and `. _ -`, starting with a letter or a digit. No
`@`: a holder shown with one is always a member's email. The name is what the
session, the audit and the catalog show, and what a filter is typed with.

## HTTP surface

| Route                           | Handler   | Answers                                                                                                                                                |
| ------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/missions/preview`    | `preview` | 200 `{ preview }`                                                                                                                                      |
| `POST /api/missions`            | `issue`   | 201 `{ mission, token: { secret, prefix }, kit }` · 422 `{ error: 'refused', preview }`                                                                |
| `POST /api/missions/:id/rotate` | `rotate`  | 200 `{ mission, token, kit }` · 404 · 409 `mission-inactive`                                                                                           |
| `POST /api/missions/:id/revoke` | `revoke`  | 200 `{ mission: { id, status } }` · 404                                                                                                                |
| `POST /api/missions/:id/gate`   | `setGate` | 200 `{ mission: { id }, risk_id, gate, previous, opening_closed }` · 400 `invalid-gate-edit` · 404 · 409 `mission-inactive` · 422 `risk-not-in-policy` |

The team's routes (`team-handlers.ts`, same guard, merged into
`root.missions.handlers`):

| Route                                           | Handler            | Answers                                                                                                          |
| ----------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `POST /api/missions/:id/members`                | `addMember`        | 201 `{ member }` · 400 `invalid-member` · 404 · 409 `already-member` / `mission-inactive` · 422 `user-not-found` |
| `POST /api/missions/:id/members/:userId/remove` | `removeMember`     | 200 `{ user_id, token_revoked }` · 404                                                                           |
| `POST /api/missions/:id/tokens/mine`            | `generateToken`    | 200 `{ mission, token: { secret, prefix }, kit, rotated }` · 404 · 409 `mission-inactive`                        |
| `POST /api/missions/:id/tokens`                 | `createNamedToken` | 201 `{ mission, token, kit, rotated: false }` · 400 `invalid-name` · 404 · 409 `name-taken` / `mission-inactive` |
| `POST /api/missions/:id/tokens/:tokenId/revoke` | `revokeToken`      | 200 `{ token_id, already }` · 404                                                                                |

`tokens/mine` answers the caller with their **own** token. The secret of a
member token is only ever in the answer to the member it belongs to:
`tokens/mine` for anyone, `POST /api/missions` and `…/rotate` for the creator's
own. No route answers the creator with another member's secret. The 404 and
the 409 `mission-inactive` of the two token routes are also what a refused
insert answers ("The token insert checks again" above).

All ten routes of the two tables go through `guardMutation(request, deps, 'user')` (handbook
[authentication](authentication.md)): origin check first (403
`origin-mismatch`), then a **user** session (401 without, 403 for the
bootstrap operator — a mission always has an identified human behind it), `Cache-Control: no-store`; a body that is not a
draft is 400 `invalid-draft` with one problem per field (unknown keys refused).

## Editing a gate after issuance — `MissionService.setGate(user, missionId, riskId, gate)`

"The creator sets the risk's gate to `approval` at issuance, or later" (spec §3.5). On
the mission page (`/missions/<id>`) each row of the policy table has one button
(`gate-control.tsx`, a client component): _Require approval_ on an `auto` risk, _Set to
auto_ on an `approval` one. It posts `{ risk_id, gate }` to `/api/missions/<id>/gate`
and reloads the page's data.

- **Only the gate moves.** Accepted risks, quotas, rate limits, resources and the token
  are untouched; the body takes `risk_id` and `gate` and refuses any other key. The risk
  must already be in the policy (`risk-not-in-policy` otherwise): an edit never adds a
  risk.
- **No authority is re-checked.** A gate is not part of what a share restricts (spec
  §11.2: no quantities or gates in shares) and loosening or tightening it does not change
  which risks the mission accepts.
- **Creator only**, like every act on a mission: anyone else gets `not-found`. A revoked
  or orphaned mission answers `inactive`: these are the states a mission does not leave
  by an act on the mission itself. `orphaned` is derived at the instant of the edit, so
  the gate is editable again as soon as the creator's authority is back. The rule is
  stated once, in `gateEditBlockedBy(mission)` (`mission-service.ts`: `revoked`,
  `orphaned` or `null`): `setGate` refuses on it and the mission page reads it as
  `MissionDetail.gates_editable` (for the creator; `false` for a member), so the page
  shows the gate buttons exactly when the edit would be taken
  (`tests/integration/authority/rules-read-by-pages.test.ts`).
- **An expired mission keeps its gates editable.** It refuses every call, but its creator
  can bring it back by extending the expiry (a claim's `extend-expiry`,
  [requests](requests.md)), and the gates set meanwhile are the ones it serves with
  again: the creator can tighten a gate before granting the claim that revives the
  mission. ADR [one-membership-rule-checked-in-the-token-insert](../decisions/one-membership-rule-checked-in-the-token-insert.md), D5.
- **It applies to the next call.** The execution door loads the policy for each call;
  nothing is cached, nothing is re-issued, the token does not change. Open approval
  requests are left where they are (the creator answers them, or they expire).
- **It ends an opening.** `store.missions.setGate` updates the row and, when the mission
  has a session, records `gate-changed { gate, gate_before }` in the same transaction: an
  opening "for the rest of the period" granted earlier on that risk stops there
  ([budget-and-sessions](budget-and-sessions.md), "Gates opened for the period").
- **Asking `approval` on a gated risk that is open for the period closes the opening.**
  The stored gate is already `approval` and does not move, so the service looks for the
  opening with the budget's own derivation (`openedGatesOf`, through `openGatesIn`) and
  passes `{ closeOpening: true }` to the store, which records the `gate-changed` event
  without touching the row. The result carries `opening_closed: true` (`previous` equals
  `gate`) and the mission page shows the gate closed again (`gate_open_until: null`). ADR
  [execution-door-json-faithful-arguments-and-shared-throttle](../decisions/execution-door-json-faithful-arguments-and-shared-throttle.md).
- **The opening is looked for in the period that runs now, whatever the mission's
  state.** `setGate` computes the period itself (`periodNow`: `currentPeriod` over the
  mission's period and the clock) and reads the gate events since it started
  (`openGatesIn`); it does not ask for the mission's state. On an expired mission whose
  gate was opened before the expiry passed, `approval` asked again therefore closes the
  opening (one audit entry, one event): were the expiry extended later in the same
  period, the mission would otherwise come back with the opening the creator had just
  closed. With no opening to close it writes nothing. The page is a different read:
  `openGatesOf` shows an opening on an **active** mission only, so `gate_open_until` is
  `null` on an expired one whether or not an opening stands.
- **`// single-process only`.** The read of the opening and the write of the gate are two
  store calls, marked so above them in `setGate`: an opening granted between the two is
  missed. Not reachable while every store call is synchronous in one process; with a
  second process the decision belongs inside `MissionsRepo.setGate`'s transaction, which
  owns the session's events.
- **One audit entry per change**: act `gate-changed`, object the mission, `before` /
  `after` `{ risk_id, gate }`; when an opening was closed, `before` also carries
  `open_for_period: true` and `after` `open_for_period: false`. Setting the gate a risk
  already has, with no opening to close, writes nothing (`opening_closed: false`).

`SetGateResult` is `{ ok: true, mission, risk_id, gate, previous, opening_closed }`; the
route answers `{ mission: { id }, risk_id, gate, previous, opening_closed }`.

`MissionService.get()` gives each policy line `gate_open_until`: the end of the period the
creator opened the gate for, or `null` (always `null` on a mission that is not active);
the page shows it next to the gate.

## The creation screen (`/missions/new`)

One page, one column, in the order of spec §4.2:

1. **Name** — with, on the same row, "Duplicate from…" (a select of the
   creator's missions → `/missions/new?from=<id>`) and "Paste an agent's
   proposal" (a JSON draft, or only its `connections`, sent to
   `/api/missions/preview`; what passes is loaded with `loadResolved`, the
   issues are listed, nothing is issued).
2. **Connections, resources, policy** — one block per connection: include
   checkbox, provider and name, "N of M resources" (a link that unfolds the
   resource checkboxes: all ticked by default except the hidden ones, the stale
   ones disabled), and the mode switch **Preset | Custom** (two native radios
   in a group named "Policy for `<provider>` `<name>`"). "Show experimental
   providers" appears only when the creator holds a connection (owned or shared) of an
   `experimental` plugin; those rows are hidden until ticked. A creator with a
   single non-experimental connection finds it included. The two modes are
   described below.
3. **Summary** — three lines, `summarize()`: _Can_ (per connection: accepted
   risks, resources, most severe accepted risk), _Cannot_ (withheld risks and
   the most severe one, resources left out), _Quantities_ (largest quota per
   period, fastest rate, risks under approval, reload, expiry).
4. **Period and expiry**, and **Issue mission**, in a bar that stays at the
   bottom of the viewport. Under it, what still blocks issuance, then the
   preview's `notices` (`data-testid="notices"`): one warning-coloured line
   each — a folded `<details>` whose summary names the code's meaning and the
   resources, and which unfolds to the full message. A notice never disables
   the button, and the list is absent when there is none.

### Preset mode (`preset-panel.tsx`)

The default. The plugin's presets are an explicit choice: one radio each (group
"Preset for `<provider>` `<name>`"), labelled with the preset's name and its
width on this connection (`presetChoiceLabel`: "10 risks · 2 need approval").
For the preset picked, the block shows, without leaving the page:

- its description, in full;
- its counts in one sentence (`presetDigest`: "8 allowed without asking · 2
  need your approval · 5 not included", plus "N entries of the preset left out
  here" when some cannot apply), a button that spreads the lists out or hides
  them, and a link to the preset's entry in the provider reference
  (`/reference/<id>#preset-<preset>`, new tab);
- spread out: **Allowed without asking** and **Needs your approval, action by
  action** — each risk by its human label, its environment, its quota and its
  rate limit (`formatRate`: `240/min`) —, **Not included** (a count; the names
  unfold in place) and **In the preset, left out here** (each entry with the
  reason: outside the authority, or the label a selected resource would need).

All of it is `explainPreset(connection, state, presetId)`: the same
`previewConnection` call as `applyPreset`, read instead of applied, so what the
block says and what the policy holds cannot differ (a unit test compares them
for every preset).

**One reading is spread out at a time by default**: picking a preset spreads
its own lists out and reduces the other connections to their description and
counts; "Show what it allows, with quotas" spreads any of them out again, and
the creator may keep several open. This is what keeps a mission on three
connections at about two viewports (2.1 at 1280×800 in the browser test) while
every preset still says what it is; with every list spread out the same page is
a little over three viewports.

### Custom mode (`custom-editor.tsx`)

One click on **Custom** opens the granular editor in place, on the values the
preset filled (`enterCustom`: nothing is lost, nothing counts as edited yet):

- a toolbar: "Start from preset…" (`startFromPreset`), "Select all", "Clear",
  "Remove the N refused", and "N accepted of M you can accept here"; under it
  one line of help, the rest behind "More" (`Help`, id `custom-editor`);
- when the catalog has more than `SEARCH_THRESHOLD` (8) explicit ids, or the
  provider's data model has several planes, a search box (every word must
  appear in the label, the id, the reason, the environment, the kind or the
  severity level) and a filter (all, accepted, not accepted yet, unavailable
  to you): `filterRows`;
- when the provider's data model has several planes (`riskPlanesOf`, computed
  by `new/page.tsx` from the registry and passed down as `planes`), a **plane
  filter** beside them: all planes, one plane, or `other`
  ([web-app](web-app.md), "Planes"). It narrows what is listed, never what is
  accepted;
- **every explicit id of the catalog** (`editorRows`), grouped by `groupByKind`:
  Reads, Writes, Irreversible writes. An account-scoped entry is one row; an
  env-scoped entry states its label and reason once, then one row per
  environment. A row is the shared `RiskExplain` in three lines (label,
  environment, severity and markers; the id linked to the reference and one
  line of reason that unfolds; the six-cell vector strip), a checkbox
  (`aria-label` "Accept risk `<id>`") and, once ticked, quota, rate limit
  (`max` per `window` s) and gate, aligned in three columns whose captions
  are written once per group;
- a risk the creator does not hold, or that no selected resource can resolve,
  **stays listed**, greyed, with "Not available: `<reason>`" and a disabled
  checkbox; an entry ticked earlier that stopped resolving stays ticked,
  marked "Refused at issuance".

Going back to **Preset**, or choosing another preset in "Start from preset…",
after an edit (`discardsEdits`) does not act at once: an inline warning asks
"Discard my changes" / "Keep editing". Without an edit the switch is immediate
(`backToPreset` re-applies the preset).

A policy loaded from a duplicated mission or from an agent's proposal
(`loadResolved`) is a custom one: the connection opens in Custom mode, first as
the compact reading of its explicit lines ("Custom policy, as loaded", allowed /
needs approval), with "Edit risk by risk" to open the editor.

The mode is a property of the screen. `draftOf` sends the same explicit
`RiskId → (quota, rate limit, gate)` lines in both modes and never the preset
(`preset: null`); `issue()` re-checks them server-side as before.

Behaviour worth knowing (`form-state.ts`):

- picking a preset fills the policy (`applyPreset` = `previewConnection` in
  preset-only mode) and the form is issuable;
- while the policy is the untouched preset it follows the resource selection;
  once edited, entries are kept and the preview flags the unresolvable ones;
- a hand-ticked risk starts with the chosen preset's budget for it, else the
  first other preset's that carries it, else **blank** — and a blank budget
  blocks issuance (`missing-budget`);
- "Select all" ticks every held, resolvable risk as an enumerated list, without
  deprecated entries and without the `uncategorized-write` fallback (the creator
  ticks it knowingly);
- the browser's preview decides nothing: `issue()` recomputes it, and a 422
  replaces the list of blockers with the server's.

With three connections and their presets the page stays compact at 1280×800.
The Playwright spec asserts it: no editor open (no `[data-risk]` row), a page of
at most 2.25 viewports, at most six visible checkboxes, and the Issue button in
view. The same spec then walks the other paths: a preset shows its content,
Custom lists the fifteen GitHub risks with their labels, the discard warning,
the search box on Supabase, and the link from a risk id of the mission page to
its entry in the reference.

### How a risk is explained (`components/risk/RiskExplain.tsx`)

One component, used by the Custom editor, the Share dialog's checklist, the
policy table of `/missions/<id>` and the provider reference:

| Export                           | Renders                                                                                                                                                                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RiskExplain({ risk })`          | a compact row: label, environment, class, severity, markers; then the id and one line of reason; then the vector strip. `kindTag={false}` in a list already grouped by class                                                                                                                     |
| `VectorStrip({ vector })`        | six cells, the axis in a few letters over its value (`vectorBadges`): neutral at the mildest value, a status tone above it; the value is always written, each cell names its axis in full (`aria-label`, `title`), and the whole profile shows on hover and, with `focusable`, on keyboard focus |
| `VectorLegend()`                 | each axis with its short name, the question it answers, its scale (`VECTOR_AXES`)                                                                                                                                                                                                                |
| `RiskIdLink({ riskId })`         | the id as a `Slug` of kind `risk`, linked to `/reference/<provider>#risk-<base id>` (`riskReferencePath`); `newTab` on pages holding unsaved input                                                                                                                                               |
| `RiskClassTag({ kind })`         | `read`, `write` or `irreversible` as an outlined word: the class of a risk where the list is not grouped by it (mission page, Share dialog)                                                                                                                                                      |
| `RiskReason`                     | the reason on one line that unfolds in place (a native `<details>`: a button to the keyboard, no script)                                                                                                                                                                                         |
| `RiskMarkers`, `RiskMarkerNotes` | the `fallback` and `deprecated` badges, and the sentence that explains each                                                                                                                                                                                                                      |

The short names of the axes are `abbr` in `VECTOR_AXES` (Undo, Blast, Data,
Cost, Seen, Lasts); `noteBody(note)` gives a marker's sentence without its lead
word, for a callout that already has it as its title.

`CatalogRisk` carries what they need: `vector` (resolved for the id's
environment) and `kind` (`read` when every pattern of the entry ends in `.R`,
`destructive` when the vector says `irreversible`, else `write`). `kind` only
groups a list; like the severity, nothing is decided from it.

On `/missions/<id>` the policy table looks each persisted id up with
`riskExplainer(registry)` (`server/providers/reference.ts`); an id no shipped
catalog declares any more is shown as its stored label and its bare id.

After a 201 the **reveal-once dialog** shows the bootstrap kit with the secret;
"I copied the token" goes to `/missions/<id>`, which only ever shows
`vbn_live_<prefix>_…`. Rotation opens the same dialog.

## The pages for a team

- **`/missions`** — two lists: "Created by me" and "Shared with me" (the
  creator's email, and "not generated yet" while the member has no token).
  "Duplicate from…" on the creation screen offers the created ones only.
- **`/missions/<id>`** — read by the creator and by members. A member gets a
  "Shared with you" callout (`Callout`, the member glyph) naming the creator and none of the creator's
  controls (Duplicate, Rotate token, Revoke mission, the gate buttons). The
  page was otherwise left as it is; the team lives in one self-contained
  section, `TeamSection` (`team-section.tsx`), fed by
  `root.missions.team.team()`:
  - **Your token** — its masked prefix, when it was generated and last used;
    "Generate my token" / "Rotate my token" (the reveal-once dialog with the
    kit, as at issuance) and "Revoke my token";
  - **Members** — email, role, added, whether they generated a token; for the
    creator, "Remove" and a select of the active users not on the mission yet
    ("Add member"). The select lists every active user's email on purpose
    (product owner, 2026-10-13; threat model, A25): the instance is one
    company's, and a free-text field would confirm or deny any address typed;
  - **Tokens that work now** — holder, kind, masked prefix, created (and by
    whom, for a named token), last used; for the creator, "Revoke" on each and
    a name field ("Create named token").

  No list of this section carries more than a prefix.

## Bootstrap kit (`bootstrap-kit.ts`)

`buildBootstrapKit({ instanceUrl, mission, connections, policy, token })` →

1. `env` — `export VAUBAAN_MISSION_TOKEN='<secret>'` (or the masked prefix on a
   revisited page; `reveals_secret` says which);
2. `mcp_json` — `{ mcpServers: { vaubaan: { type: 'http', url:
'<public_url>/mcp', headers: { Authorization: 'Bearer
${VAUBAAN_MISSION_TOKEN}' } } } }`: the variable by reference, never the
   secret;
3. `agent_instructions` — a Markdown block: a section "Whose token this is"
   (one holder per token, every call recorded under that holder, `GET
/mcp/catalog` says who; the budget is one for every holder; requests are
   the creator's), then a section "Sub-agents and agent
   labels" (`agentLabelGuidance`, spec §7.9) — an orchestrator hands its
   sub-agents this MCP configuration as is, same endpoint and same token,
   never a token per agent; each agent names itself with the header
   `X-Vaubaan-Agent: <label>` in its own copy of the configuration, or with
   `_meta.agent` on each `tools/call` when one process sends the calls of
   several agents (the per-call value wins); the shape of a label, printed
   from `AGENT_LABEL_MAX_LENGTH` and `AGENT_LABEL_PUNCTUATION`, the constants
   the execution door builds its check from; "attribution only … not an
   identity" (handbook [execution-door](execution-door.md), "Agent label") —
   then connections and resource refs (with
   env labels), accepted risks with quota per period, rate limit and gate,
   reload and expiry, then one line per
   refusal code from `REFUSAL_GUIDANCE` (a `Record<RefusalCode, string>`, so a
   new code fails to compile until it has its line), "Never work around a
   refusal… give that URL to the human as is", a section "When the token
   itself stops working" with one line per `AUTH_FAILURE_REASONS` entry from
   `TOKEN_STOPPED_GUIDANCE` (keyed the same way), and a closing section "The
   management door" (`managementDoorSection`): the URL of `/mcp/manage`, that
   the mission token does not open it, and that nothing behind it lifts a
   refusal. "The budget is shared, it is not multiplied" is said once, in the
   opening paragraph;
4. `verify` — `curl -sS '<endpoint>' … -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`.

The kit also carries `endpoint` (`<public_url>/mcp`) and `reveals_secret`.

`instanceUrl` is `InstanceConfig.publicUrl`; `EXECUTION_DOOR_PATH` (`/mcp`) is
the only path this file writes down; the management endpoint is built from
`MANAGEMENT_DOOR_PATH` (`/mcp/manage`, `oauth-as/endpoints.ts`). `GET
/agent-bootstrap.md` (`app/agent-bootstrap.md/route.ts`, static, public,
cached five minutes) serves `content.md`, the generic companion of the kit
(no instance URL in it); five tests check that it documents every refusal
code, the management door, sub-agents and the agent label, that a token has
one holder and what a stopped token means, and that it names no instance.

## Wiring

`createMissionsModule({ config, store, registry, authenticator, logger, grounds,
authority?, clock?, mint?, budget? })` → `root.missions = { authority, service,
team, handlers }` (composition root, after `root.auth`). `grounds` is required: the
root passes `root.authority.grounds`, and a test that builds a `MissionService`
by hand passes it too. `budget` is a
`Pick<SessionService, 'stateOf'>`; the root builds the missions module before
the `SessionService`, so it is left out and defaults to
`missionUsageReader(store.sessions)` — the same function over the same store.

The registry is the root's own (`compose/shipped-plugins.ts`): the plugins the
image ships are the plugins issuance offers, with no second list. Connections
and resources are read through the store repositories only
(`connections.getById`, `listResources`); nothing here touches a credential.

## Tests

Unit, beside the code (159): `authority/authority-service.test.ts` (20),
`missions/preview.test.ts` (44), `catalog-view.test.ts` (21), `summary.test.ts`
(8), `bootstrap-kit.test.ts` (16), `orphan-reason.test.ts` (4), `token.test.ts`
(8, with the draft schema), `app/(app)/missions/new/form-state.test.ts` (36),
`app/(app)/missions/message-of.test.ts` (2: the sentence a mission page shows
for a refusal of the mission API).

Also beside the code: `missions/token-name.test.ts` (23: what a name may be)
and `store/membership.test.ts` (12: each membership, and who is on the
mission).

Integration, `tests/integration/missions/` (89) on the real root over
`:memory:`: `team.test.ts` (27: members added, offered, removed and added
again; a member's own token generated, rotated, revoked; named tokens; the
mission revoked; the session events; each thing a member cannot do, with the
store compared before and after; requests not seen and not answered; the
creator reading everything and every table without finding a member's secret;
the handlers' statuses and guard), `team-interleaving.test.ts` (6: a token insert that
lost the race — the member removed, removed while rotating, or deactivated, and the
mission revoked, while the hash was computed; two creations of one name at once; nothing
happened meanwhile), `mission-lifecycle.test.ts` (33), `mission-handlers.test.ts` (8) and
`gate.test.ts` (20: both directions and what the next call answers, the audit entry and
the session event, a no-op, `approval` asked on a gate open for the period closing the
opening with one entry and one event, the same on an expired mission and what the next
call answers once the expiry is extended, creator only, the refusals, `gate_open_until`,
the route's statuses).
The repository side — the insert refused for a mission that does not serve or a holder
who is not on it, the stale token revoked by `addMember` — is in
`tests/integration/store/missions.test.ts` ([store](store.md)).
The lifecycle suite builds the pipeline's view with the door's own
`loadMissionContext`, pins the `mission-issued` payload, and checks that the
detail and the kit list what the door reaches (no resource at issuance then a
discovery; every resource hidden; a resource turned stale).
Scenarios in [integration-tests](../tests/integration-tests.md).

Browser, `tests/e2e/v5/team-mission.spec.ts` (1: a member added, a named
token, the member's own token in her browser only, three holders attributed in
the session and the audit, each token stopping on its own),
`tests/e2e/v5/issue-mission.spec.ts` (3) and the gate edit at the end of
`approve-action.spec.ts`, `npm run test:e2e:v5`: see [e2e-tests](../tests/e2e-tests.md)
for the ephemeral instance.

## How to debug

- **A resource is missing from the list, or cannot be ticked** — hidden
  resources are listed unticked; a disabled one is stale: refresh discovery on
  the Connections page.
- **`connection-unknown` for a connection that exists** — the user is not its
  owner (or no longer a member of the owner group), the connection is `revoked`,
  or its provider has no registered plugin (`root.registry.ids`).
- **The detail shows "no resource" on a connection that has resources** — the
  mission was issued when the connection had none (or all were hidden): it
  reaches none, and the door answers `resource-not-in-mission`. Duplicate the
  mission to issue one on the resources known now.
- **Calls are refused `risk-not-accepted` on one resource only** — read the
  preview's `notices`: the resource has no environment label, or a label the
  catalog does not know; env-scoped risks can never be touched on it. Label it
  on the Connections page. The line of the notice on the creation screen
  (`noticeHeadline` in `mission-form.tsx`) and the notice's own message name
  the resource as its owner named it; its ref is in `resource_refs` and on
  the connection's page.
- **A preset fills fewer risks than it lists** — the preset's counts say "N
  entries of the preset left out here"; spread its lists out ("Show what it
  allows, with quotas") and read "In the preset, left out here": each entry
  with its reason — outside the authority, or needing a resource labelled with
  an environment nobody labelled (Connections page).
- **`unknown-risk` on `provider.name` of an env-scoped risk** — an explicit
  policy must say `provider[env].name`.
- **Issue stays disabled** — the list under the bottom bar names every blocker;
  an empty quota field is `missing-budget`.
- **A mission shows `orphaned`** — the banner on its page gives the cause; it is
  computed on that page load, so reload after the owner shared again or after a new
  sign-in. Nothing in the `missions` table says `orphaned`: the row is `active`.
  [authority](authority.md), "How to debug".
- **A token is refused** — `verifyToken` → `retired/rotated`: its holder
  generated a newer one; `retired/revoked`: it was revoked on its own, or the
  mission was; `retired/holder-removed` / `holder-deactivated`: its member is
  no longer a member, or no longer an active user; `unknown`: wrong instance,
  truncated secret, or not a `vbn_live_` key. The mission page's "Members and
  tokens" lists the tokens that work now.
- **A member does not see the mission** — `access` wants `membershipOf` to
  answer `member`: a current row in `mission_members` (`removed_at IS NULL`)
  and `users.status = 'active'`.
- **"No token can be generated now"** — the mission does not serve calls
  (revoked, expired, orphaned): `generateToken` and `createNamedToken` answer
  `mission-inactive`. Revoking a token and removing a member still work.
- **`generateToken` answers 404 to somebody who was reading the mission a
  moment ago** — they were removed or deactivated while the token was being
  hashed: the store refused the insert (`holder-not-a-member`).
- **A gate button shows on an expired mission** — by design: its gates stay
  editable, and `approval` asked again there closes an opening of the current
  period.
- **A `mission-token-revoked` entry with `reason: 'member-removed'` right
  after a `mission-member-added`** — the member being added still held a
  working token from before; `addMember` revoked it.

## References

- Spec [vaubaan-gateway](../spec/vaubaan-gateway.md) §0, §2.3, §3.1–3.2, §4.2,
  §4.4, §7.4, §7.8, §10.
- Neighbours: [store](store.md), [plugin-sdk](plugin-sdk.md),
  [budget-and-sessions](budget-and-sessions.md),
  [authentication](authentication.md), [connections](connections.md),
  [configuration](configuration.md).
