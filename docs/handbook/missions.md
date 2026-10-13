---
title: Missions — authority, issuance, presets, resources, tokens, bootstrap kit
status: current
date: 2026-10-13
last_synced: 2026-10-13
tracks:
  - apps/gateway/src/server/authority/
  - apps/gateway/src/server/missions/
  - apps/gateway/src/app/(app)/missions/
  - apps/gateway/src/app/api/missions/
  - apps/gateway/src/app/agent-bootstrap.md/
  - apps/gateway/src/components/shell/AppShell.tsx
  - apps/gateway/tests/integration/missions/
  - apps/gateway/tests/e2e/v5/
---

# Missions — authority, issuance, presets, resources, tokens, bootstrap kit

How a connection owner issues a mission — a per-`RiskId` `(budget, gate)`
policy on selected resources — and receives its token once. Spec:
[vaubaan-gateway](../spec/vaubaan-gateway.md) §0 (Mission, Mission policy,
Budget, Gate, Preset, Resource), §3.1, §3.2, §4.2 "Missions", §4.4, §7.4,
§7.8. Decisions: pivot ADR D4 (nullable expiry, mandatory budget),
[api-key-format-vbn-live-argon2id](../decisions/api-key-format-vbn-live-argon2id.md),
[fallback-risk-only-when-uncategorized](../decisions/fallback-risk-only-when-uncategorized.md).
Built on the [store](store.md) repositories, the
[plugin SDK](plugin-sdk.md) registry (catalogs, presets, `experimental`,
`envOf`), [connections](connections.md) (resources, their `env` labels, hidden
and stale flags), [budget and sessions](budget-and-sessions.md) (policy vocabulary,
mission state) and [authentication](authentication.md) (session, origin check).

## Layout

```
apps/gateway/src/server/authority/
  catalog-authority.ts   explicitRiskIdsOf(), fullCatalogRiskIds()  — a catalog as explicit ids   (pure)
  authority-service.ts   AuthorityService, OwnerAuthorityService, uncoveredRisks()
apps/gateway/src/server/missions/
  model.ts               MissionDraft, IssuanceConnection, MissionPreview, PreviewIssue, PreviewNotice… (types)
  catalog-view.ts        enumerateCatalog(), severityOf(), isResolvable(), presetWidth()           (pure)
  preview.ts             previewDraft(), previewConnection(), expandPreset(), budgetProblem(),
                         envNotices()                                                              (pure)
  summary.ts             summarize() — the three lines; period / expiry phrases                    (pure)
  bootstrap-kit.ts       buildBootstrapKit(), REFUSAL_GUIDANCE, MISSION_TOKEN_ENV, AGENT_LABEL_*   (pure)
  draft-schema.ts        parseMissionDraft() — zod shape check of a JSON draft
  token.ts               mintMissionToken(), prefixOfBearer(), bearerMatches(), maskedToken()
  mission-service.ts     MissionService: issuanceContext / preview / issue / draftFrom / duplicate /
                         rotate / revoke / verifyToken / list / get
  handlers.ts            Request → Response handlers of /api/missions/**
  index.ts               createMissionsModule(deps) → root.missions; server-only barrel
  testing.ts             ACME_CATALOG, acmeConnection(), seedConnection(), catalogEnvs() — tests only
apps/gateway/src/app/(app)/missions/
  page.tsx               /missions — list
                         (the user comes from `currentUser()` in `@/lib/auth/session`; the bootstrap
                         operator sees `NeedsUser` from `@/components/auth/NeedsUser`)
  new/page.tsx           /missions/new — loads the issuance context (and ?from=<id>)
  new/mission-form.tsx   the one-page creation screen (client)
  new/form-state.ts      state and transitions of the form (pure, unit-tested)
  new/risk-detail.tsx    per-risk table of one connection (client)
  [id]/page.tsx          /missions/<id> — detail (links to its session page)
  [id]/session/page.tsx  /missions/<id>/session — counters, requests, timeline (handbook audit)
  [id]/mission-actions.tsx  Duplicate / Rotate / Revoke (client)
  bootstrap-kit-view.tsx BootstrapKitView, RevealDialog (client)
  state-badge.tsx        StateBadge — the derived mission state (list and detail)
  new/labels.ts          GATE_LABELS
  missions.module.css    styles of the Missions pages
apps/gateway/src/app/api/missions/   route.ts, preview/route.ts, [id]/rotate, [id]/revoke — one-line adapters
```

`model`, `catalog-view`, `preview` and `summary` are **browser-safe** (values
only from `@vaubaan/shared/risk-id`, `@vaubaan/shared/domain` and
`@vaubaan/policy-engine`): the creation
form imports them directly and runs the same decision as the server. The
`index.ts` barrel is server-only (argon2 through `token.ts`).

The pages live in the `(app)` route group and take its layout: a web
session gets the `AppShell` (`components/shell/AppShell.tsx`), where "Missions"
is one entry of `APP_NAV` (an entry may carry a `Count` server component, used
by "Requests": handbook [requests](requests.md)); a visitor with no session is
sent to `/login`. The
bootstrap operator has a session but is not a user: each page then renders
`NeedsUser` (a mission always has an identified human behind it).

## Authority

`AuthorityService.authorityOf(user, connection)` → `{ connectionId, provider,
basis, riskIds }`. `OwnerAuthorityService` is the only implementation today:

- the **owner** — the user who owns the connection, or any _current_ member of
  the group that owns it (`groups.groupsOf`, read on every call) — holds
  `fullCatalogRiskIds(catalog)`: every account-scoped id, and one id per
  `acceptable_in_envs` entry of every env-scoped risk
  (`supabase[staging].bulk-row-write`). It is the same set the store's
  `RegistryCatalogIndex` accepts, minus base ids of env-scoped risks;
- everyone else, and any connection whose provider has no registered plugin,
  holds `basis: 'none'`, `riskIds: []`.

`connectionsOf(user)` lists the candidates of an issuance (owned connections,
every status). Shares (P2.2) arrive as a second implementation behind the same
interface, injected through `MissionsModuleDeps.authority`; nothing in
`missions/` changes.

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
rows (`CatalogRisk`), the creator's `authority`, the plugin's presets,
`experimental` and `derives_env`. It never throws on a refusable draft: every
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
refusing bucket, in the order of the table above).

`MissionPreview` = `{ ok, issues, notices, name, connections: ConnectionPreview[],
policy, period, expires_at, summary, resolved }`. Per connection: `passes` (what becomes
callable, complete `MissionPolicyEntry` lines), `exceeds`, `unknown`,
`unresolvable`, `missing_budget`, `skipped_from_preset`, the explicit
`resources` and `resources_total`. `resolved` is the passing part of the draft
with every alias resolved; the form loads it after a proposal or a duplicate.
The same shape is what the management door will expose (P2.4).

**Notices — what passes but the creator should know.** `notices` is a list of
`PreviewNotice { code, message, connection_index?, connection_id?,
resource_refs, risk_ids }`. A notice never blocks: `ok` is `issues.length === 0`
and ignores it. Both codes (`PREVIEW_NOTICE_CODES`) come from `envNotices` and
state one rule of the policy engine ([policy-engine](policy-engine.md)): at call
time an env-scoped risk touched on a resource whose environment label is
absent, or is not an environment the risk is acceptable in, **refuses the call**
(`risk-not-accepted`), whatever the mission accepts. On such a resource the
mission reaches the account-scoped risks only.

| Code                          | When                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `resource-without-env`        | a selected resource has no environment label, on a connection whose catalog has env-scoped risks                 |
| `resource-env-not-in-catalog` | a selected resource is labelled with an environment (`dev`, a typo) that no risk of the catalog is acceptable in |

`resource_refs` names the resources, `risk_ids` the env-scoped ids the draft
accepts on that connection (unreachable there), and the message names the
labels the catalog knows and the remedy: label the resource on the connection's
page, or leave it out. Nothing is emitted when the plugin derives the
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
creator issues a second mission.

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
The picker shows each preset's width in one line (`presetWidth`: number of
risks, most severe, largest quota, how many under approval). The integration
suite previews every preset of every plugin the app depends on for an owner
whose resources carry every environment label of the catalog, and expects no
issue and nothing skipped.

Defaults the form adds: period **daily reload** (`DEFAULT_PERIOD`), expiry
**never** (`DEFAULT_EXPIRY`), gate `auto` when a line names none.

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
4. Token: `mintMissionToken()` → `vbn_live_<8>_<32>`, argon2id hash; a prefix
   already taken is re-drawn (up to 5 times); `missions.issueToken` stores
   prefix + hash + `hashAlg: 'argon2id'`.
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

`issue` and `duplicate` take an optional `IssueOptions { delegation: { id,
clientId } }`: the mission is stored with that `delegationId` and the audit
entry carries `delegated_client_id` (reserved for the management door, P2.4;
no caller sets it today). `duplicate` also takes `overrides` for `name`,
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
  (`deriveMissionState`); the old token becomes `rotated`; audit
  `mission-rotated`; a `rotation` session event when the session exists.
- **`revoke`** — creator only, idempotent; status `revoked`, active tokens
  `revoked`; audit `mission-revoked`; `revocation` session event.
- **`verifyToken(bearer)`** — `prefixOfBearer` (a `vbn_live_` key only) →
  `missions.findTokenByPrefix` → `bearerMatches` (argon2 verify) →
  `{ outcome: 'verified', mission, token }`, `{ outcome: 'retired', reason:
'rotated' | 'revoked', mission, token }` or `{ outcome: 'unknown' }` (malformed,
  unknown prefix and wrong secret are one answer). `token` is a `VerifiedToken`
  — `{ id, prefix }`: the token record and its hash do not leave the service.
  The execution door
  ([execution-door](execution-door.md)) calls it behind its verified-token
  cache, turns `retired/rotated` into an authentication failure (401) and a
  revoked mission into `mission-inactive` through gateway-core's
  `checkMissionActive`.
- **`list` / `get`** — the creator's missions with their state and the active
  token's prefix; `get` adds connections, the resources the mission reaches,
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

## HTTP surface

| Route                           | Handler   | Answers                                                                                 |
| ------------------------------- | --------- | --------------------------------------------------------------------------------------- |
| `POST /api/missions/preview`    | `preview` | 200 `{ preview }`                                                                       |
| `POST /api/missions`            | `issue`   | 201 `{ mission, token: { secret, prefix }, kit }` · 422 `{ error: 'refused', preview }` |
| `POST /api/missions/:id/rotate` | `rotate`  | 200 `{ mission, token, kit }` · 404 · 409 `mission-inactive`                            |
| `POST /api/missions/:id/revoke` | `revoke`  | 200 `{ mission: { id, status } }` · 404                                                 |

All four go through `guardMutation(request, deps, 'user')` (handbook
[authentication](authentication.md)): origin check first (403
`origin-mismatch`), then a **user** session (401 without, 403 for the
bootstrap operator — a mission always has an identified human behind it), `Cache-Control: no-store`; a body that is not a
draft is 400 `invalid-draft` with one problem per field (unknown keys refused).

## The creation screen (`/missions/new`)

One page, one column, in the order of spec §4.2:

1. **Name** — with, on the same row, "Duplicate from…" (a select of the
   creator's missions → `/missions/new?from=<id>`) and "Paste an agent's
   proposal" (a JSON draft, or only its `connections`, sent to
   `/api/missions/preview`; what passes is loaded with `loadResolved`, the
   issues are listed, nothing is issued).
2. **Connections, resources, preset** — one row per connection: include
   checkbox, provider and name, "N of M resources" (a link that unfolds the
   resource checkboxes: all ticked by default except the hidden ones, the stale
   ones disabled), the preset select; under it one
   truncated line with the preset's width and description, and what the preset
   left out. "Show experimental providers" appears only when the creator owns a
   connection of an `experimental` plugin; those rows are hidden until ticked.
   A creator with a single non-experimental connection finds it included.
3. **Summary** — three lines, `summarize()`: _Can_ (per connection: accepted
   risks, resources, most severe accepted risk), _Cannot_ (withheld risks and
   the most severe one, resources left out), _Quantities_ (largest quota per
   period, fastest rate, risks under approval, reload, expiry).
4. **Per-risk detail** — one `<details>` per included connection, **closed**.
   Open: "Select all", "Clear", then one row per risk the creator holds that
   the selection resolves — checkbox, label, severity, env, id; quota, rate
   limit (`max` per `window` s), gate. Rows the selection cannot resolve or the
   creator does not hold are listed under "N entries unavailable with this
   selection" with the reason and cannot be ticked; an entry ticked earlier that
   stopped resolving stays, marked "Refused", with "Remove the N refused".
5. **Period and expiry**, and **Issue mission**, in a bar that stays at the
   bottom of the viewport. Under it, what still blocks issuance, then the
   preview's `notices` (`data-testid="notices"`): one warning-coloured line
   each — a folded `<details>` whose summary names the code's meaning and the
   resources, and which unfolds to the full message. A notice never disables
   the button, and the list is absent when there is none.

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
The Playwright spec asserts it: no per-risk detail open, a page at most two
viewports tall (one scroll), at most six visible checkboxes, and the Issue
button in view.

After a 201 the **reveal-once dialog** shows the bootstrap kit with the secret;
"I copied the token" goes to `/missions/<id>`, which only ever shows
`vbn_live_<prefix>_…`. Rotation opens the same dialog.

## Bootstrap kit (`bootstrap-kit.ts`)

`buildBootstrapKit({ instanceUrl, mission, connections, policy, token })` →

1. `env` — `export VAUBAAN_MISSION_TOKEN='<secret>'` (or the masked prefix on a
   revisited page; `reveals_secret` says which);
2. `mcp_json` — `{ mcpServers: { vaubaan: { type: 'http', url:
'<public_url>/mcp', headers: { Authorization: 'Bearer
${VAUBAAN_MISSION_TOKEN}' } } } }`: the variable by reference, never the
   secret;
3. `agent_instructions` — a Markdown block: how an agent labels itself for
   the audit (`X-Vaubaan-Agent: <label>` header or `_meta.agent` on one call,
   `AGENT_LABEL_HEADER` / `AGENT_LABEL_META_KEY`; handbook
   [execution-door](execution-door.md)), connections and resource refs (with
   env labels), accepted risks with quota per period, rate limit and gate,
   reload and expiry, "the budget is shared, not multiplied", then one line per
   refusal code from `REFUSAL_GUIDANCE` (a `Record<RefusalCode, string>`, so a
   new code fails to compile until it has its line) and "Never work around a
   refusal… give that URL to the human as is";
4. `verify` — `curl -sS '<endpoint>' … -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`.

The kit also carries `endpoint` (`<public_url>/mcp`) and `reveals_secret`.

`instanceUrl` is `InstanceConfig.publicUrl`; `EXECUTION_DOOR_PATH` (`/mcp`) is
the only path written down, next to the route it names. `GET
/agent-bootstrap.md` (`app/agent-bootstrap.md/route.ts`, static, public,
cached five minutes) serves `content.md`, the generic companion of the kit
(no instance URL in it); a test checks it documents every refusal code.

## Wiring

`createMissionsModule({ config, store, registry, authenticator, logger,
authority?, clock?, mint?, budget? })` → `root.missions = { authority, service,
handlers }` (composition root, after `root.auth`). `budget` is a
`Pick<SessionService, 'stateOf'>`; the root builds the missions module before
the `SessionService`, so it is left out and defaults to
`missionUsageReader(store.sessions)` — the same function over the same store.

The registry is the root's own (`compose/shipped-plugins.ts`): the plugins the
image ships are the plugins issuance offers, with no second list. Connections
and resources are read through the store repositories only
(`connections.getById`, `listResources`); nothing here touches a credential.

## Tests

Unit, beside the code (109): `authority/authority-service.test.ts` (7),
`missions/preview.test.ts` (44), `catalog-view.test.ts` (11), `summary.test.ts`
(8), `bootstrap-kit.test.ts` (9), `token.test.ts` (8, with the draft schema),
`app/(app)/missions/new/form-state.test.ts` (22).

Integration, `tests/integration/missions/` (36) on the real root over
`:memory:`: `mission-lifecycle.test.ts` (28) and `mission-handlers.test.ts` (8).
The lifecycle suite builds the pipeline's view with the door's own
`loadMissionContext`, pins the `mission-issued` payload, and checks that the
detail and the kit list what the door reaches (no resource at issuance then a
discovery; every resource hidden; a resource turned stale).
Scenarios in [integration-tests](../tests/integration-tests.md).

Browser, `tests/e2e/v5/issue-mission.spec.ts` (2), `npm run test:e2e:v5`:
see [e2e-tests](../tests/e2e-tests.md) for the ephemeral instance.

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
  on the Connections page.
- **A preset fills fewer risks than it lists** — read the line under the preset
  select: entries outside the authority, or needing a resource labelled with an
  environment nobody labelled (Connections page), are left out.
- **`unknown-risk` on `provider.name` of an env-scoped risk** — an explicit
  policy must say `provider[env].name`.
- **Issue stays disabled** — the list under the bottom bar names every blocker;
  an empty quota field is `missing-budget`.
- **A token is refused** — `verifyToken` → `retired/rotated`: an older token of
  the mission; `retired/revoked`: the mission was revoked; `unknown`: wrong
  instance, truncated secret, or not a `vbn_live_` key.

## References

- Spec [vaubaan-gateway](../spec/vaubaan-gateway.md) §0, §2.3, §3.1–3.2, §4.2,
  §4.4, §7.4, §7.8, §10.
- Neighbours: [store](store.md), [plugin-sdk](plugin-sdk.md),
  [budget-and-sessions](budget-and-sessions.md),
  [authentication](authentication.md), [connections](connections.md),
  [configuration](configuration.md).
