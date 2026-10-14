---
title: Plugin contract, credential spec, presets and the single registry
status: accepted
date: 2026-10-13
extends:
  - pivot-v4-to-v5-on-prem-mission-tokens
  - repository-layout-and-contribution-workflow
  - pivot-to-risk-based-model
  - unified-gates-drop-confirm
partially-supersedes:
  - oauth-app-install-per-provider
  - mint-install-token-credential
amended-by:
  - plugin-catalog-path-and-standalone-tracing
  - fallback-risk-only-when-uncategorized
  - token-connections-beside-the-integration-app
---

# Plugin contract, credential spec, presets and the single registry

> Fixes the public API every provider plugin is written against
> (`@vaubaan/plugin-sdk`), the way a plugin declares how its provider is
> connected, the `Resource` model that replaces v4 bindings, the YAML
> catalog loaded at boot, the presets shipped in that catalog, the single
> registry every provider list derives from, the mandatory test kit and the
> plugin versioning rule. Implemented by feature P0.2. Plugins migrate to
> the contract in P1.2 ; nothing in `plugins/<provider>` changes here.
>
> **Amended on 2026-10-13 — streamed results** (feature P2.7, spec §4.1
> "Streaming") : `ExecuteContext` gains an optional `emitPart` and the SDK a
> module `streaming.ts`. See "Amendment 2026-10-13 — streamed results" at the
> end of this document.
>
> **Amended on 2026-10-13** by [[plugin-catalog-path-and-standalone-tracing]]
> (D4 : the catalog is located with `catalogPathNextTo(import.meta.url)`, not
> `new URL(…, import.meta.url)`) and [[fallback-risk-only-when-uncategorized]]
> (D1 : optional `envOf` hook ; D4 : one flagged fallback per catalog, touched
> only when no other entry matches).
>
> **Amended on 2026-10-13 by P1.2-align.** D1 : `ProviderPlugin` gains
> `experimental?: boolean` (a plugin the host registers but keeps out of the
> default connect and issuance flows ; gmail) and `labels()` carries it. D2 :
> a `refreshable: true` `oauth2` spec **no longer requires** a `refresh()`
> — the host performs the standard RFC 6749 `refresh_token` grant itself
> from `tokenUrl`, `clientAuthMethod` and `resourceIndicator` (sent on every
> token request) ; `refresh?` remains as an override for a non-standard flow
> (a re-minted installation token). Gmail's rejecting placeholder and the
> pure standard refreshes of supabase and railway were deleted. D5 : a
> preset entry on the fallback is a loader error (see the fallback ADR).
>
> **Amended on 2026-10-13 by P1.4b.** D2 : the `app-install` spec gains an
> optional, declarative `userVerification` block (`codeParam`, `tokenUrl`,
> `clientAuthMethod`, `installationsUrl`, `installationsHeaders?`,
> `installationsListField?`, `installationIdField`, `pagination?`) from which
> the host proves that the human who authorized the app during installation
> can reach the installation the callback names ; a spec that declares it
> must list `client_id` and a secret `client_secret` in `appConfigFields`,
> and `definePlugin` validates the block. The rule "a plugin never sees the
> OAuth client secret" now holds for every kind : the host removes
> `client_secret` from `ctx.appConfig` of `app-install` plugins too. The SDK
> exports `CLIENT_ID_FIELD` / `CLIENT_SECRET_FIELD`. A spec without the block
> is refused by the host unless the operator accepts unverified
> installations. Decision and alternatives :
> [[connect-driver-and-resource-curation]], amendment of the same day (D9,
> D10).

> **Amended on 2026-10-14** by [[token-connections-beside-the-integration-app]]
> (D2 : a plugin may declare more than one way to connect —
> `alternativeCredentials`, read with `credentialSpecsOf` ; every spec may name
> `unavailableTools` and its own `manualRevocation` ; an `api-key` spec may
> carry `label`, `guide` and `verify`).

## Context

The v5 spec (§5) gives a plugin two responsibilities — classify a call into
slices, execute it with an ephemeral credential — plus three declarations :
how to obtain and refresh a credential from the app the company registered,
how to discover the resources reachable through a connection, and at least
one **preset** (§3.2). The pivot ADR [[pivot-v4-to-v5-on-prem-mission-tokens]]
D5 keeps the ten v4 plugins and their 709 unit tests, and makes plugins the
unit of community contribution (D6).

What the v4 code offers does not fit that role (plan §1.4) :

- Plugins implement **no interface**. The real contract is the
  `UpstreamAdapter` duck type inside the gateway (`gateway.ts:83`) ; every
  adapter depends on the SaaS row types `ProviderAdmin` and
  `ProviderBinding`, so a plugin cannot be written without importing the
  gateway's data model.
- Every plugin ships `risk-catalog.yaml` **and** a hand-mirrored
  `risk-catalog.ts`, kept in sync by a test, because the Vercel bundler
  dropped `.yaml` files. Two sources of truth for the one artefact the
  security review reads.
- The provider list is duplicated in at least eleven places (`shared`
  union, loader, three `z.enum`s, routes, pages, `build.ts`, a SQL
  `CHECK`). The repository memory rule is "one source of truth for the
  provider list".
- Credential acquisition is spread over web routes (`/api/integrations/*`)
  with provider-specific code paths ; railway and supabase have real
  refresh, github mints per call, five providers fake a one-year expiry on
  a static key. Operator app credentials are read from `process.env` in the
  web app.
- No plugin test asserts that every tool classifies to something the
  catalog covers, or that no wildcard reaches a persisted list ; spec §10
  makes both structural tests mandatory.
- `policy-engine` resolves environments from `ProviderBinding[]`, and
  `scope-injection.ts` hard-codes four providers and a `vercelTeamId` ;
  plan §8-Q4 leaves its future open.

A third party will depend on this API, so it must be settled before any
plugin migrates, and changed afterwards only by a new ADR.

## Decision

### D1 — `ProviderPlugin`, validated by `definePlugin`

A plugin is a frozen object satisfying `ProviderPlugin`
(`packages/plugin-sdk/src/plugin.ts`) :

| Member                                        | Role                                                                                                                                                            |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `displayName`, `version`, `description` | Identity. `id` is a lowercase slug (`^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*$`) ; `version` is semver.                                                                |
| `tools: McpToolDeclaration[]`                 | Named `<id with - → _>__<local>`. May be empty for an experimental, classifier-only plugin (gmail today).                                                       |
| `dataModel`, `catalog`                        | The risk-model spec §2 and §4 artefacts. `catalog` is the YAML loaded at boot, presets included.                                                                |
| `credential: CredentialSpec`                  | Declarative : the host drives the flow (D2).                                                                                                                    |
| `classify(tool, args, resources)`             | Pure. Returns `{ slices }` or `{ denied }`. `resources` are the mission's resources on this connection.                                                         |
| `execute(ctx, tool, args)`                    | Receives the decrypted credential, the company's app config, the mission resources, an injected `fetch`, signal, logger. Throws `UpstreamAuthError` on 401/403. |
| `discoverResources(ctx)`                      | Lists the resources reachable through a connection ; called at connect time and on the owner's refresh.                                                         |
| `refresh?(ctx)`                               | Returns a fresh `CredentialSecret` ; required when the credential spec says `refreshable: true`.                                                                |
| `normalizeForCaps?(args, caps)`               | Rewrites arguments to honour scope caps (ADR [[scope-caps-amplification-axis]]).                                                                                |
| `normalizeArgs?(args, resources)`             | Fills arguments the mission leaves no choice over. Called only when the host flag `argNormalization` is on — **default off** (plan §8-Q4).                      |

`definePlugin(definition)` runs `pluginIssues` — id grammar, semver, tool
prefixes and uniqueness, `catalog.provider === id`, `dataModel.provider ===
id`, data-model referential integrity, catalog semantics (D4, D5),
credential spec coherence — and throws `PluginDefinitionError` listing every
issue. A broken plugin fails at import, not at the first call.

The plugin knows **neither the mission, nor the accepted risks, nor the
budget**. It receives `fetch` and never reads `process.env` : both are
injected so unit tests run against `mockFetch` and never touch a provider.
A plugin imports `@vaubaan/plugin-sdk` only (which re-exports what it needs
from `@vaubaan/shared` and `@vaubaan/policy-engine`) ; it never imports
`@vaubaan/gateway-core` or the application.

### D2 — `CredentialSpec` : four kinds, the host drives the flow

```
api-key      { fields: CredentialField[] (≥ 1 secret), createUrl? }
oauth2       { authorizationUrl, tokenUrl, scopes, pkce, resourceIndicator?,
               clientAuthMethod: client_secret_basic | client_secret_post | none,
               refreshable, extraAuthorizationParams?, appConfigFields? }
app-install  { appConfigFields (app id, private key, slug…), installUrl(appConfig),
               installationIdParam, userVerification? }
ssh-key      { algorithm: 'ed25519', fields (host, port, user) }
```

The host implements each flow **once**, generically : the api-key form, the
authorization-code dance with PKCE and RFC 8707 resource indicator, the
app-installation redirect and callback, the key-pair generation with the
public key shown to the operator. A plugin writes no HTTP handler and never
sees the OAuth client secret ; it receives the result as a
`CredentialSecret` (`api-key` fields, `oauth2` tokens, `app-install`
installation id, `ssh-key` private key and connection fields) plus
`metadata` (non-secret facts such as `team_id`), and the company's
`ProviderAppConfig` (client id, app id…) at call time. A public OAuth client
(`clientAuthMethod: 'none'`) must use PKCE ; a `refreshable` spec needs no
`refresh()` — the host performs the standard grant and `refresh` overrides
it for a non-standard flow only (amended 2026-10-13, P1.2-align ; the
original text required one) ; `expectCredentialKind(pluginId, secret,
kind)` is how a plugin narrows the secret it receives instead of casting.

The stored form (`Credential` in `@vaubaan/shared`) is an opaque
`ciphertext` with `key_version`, `expires_at` and `metadata` ; the plugin
never sees it. Operator app credentials come from instance configuration
(P0.4), not from `process.env` inside a plugin. This supersedes the
provider-specific connect routes of [[oauth-app-install-per-provider]] and
the credential plumbing of [[mint-install-token-credential]] ; the GitHub
installation-token idea itself survives as the `app-install` kind.

### D3 — `Resource` replaces `ProviderBinding`

`Resource { provider, ref, env?, displayName, metadata? }` lives in
`@vaubaan/shared` (so `policy-engine` can depend on it without a cycle) and
is re-exported by the SDK. `ref` is what the agent cites and the gateway
checks ; `env` is the owner's environment label ; `metadata` carries the
provider-specific, non-secret facts a classifier may need (the Gmail
allowlists that v4 kept in `binding.metadata`). `ConnectionResource` adds
the storage identity (`id`, `connection_id`, `discovered_at`). Missions
select resources per connection (spec §3.1, answer Q1 of the plan).

`policy-engine` resolves environments through an **`EnvResolver`**
interface (`resolveEnv(slice) → env | null`) with a default implementation
`resourceEnvResolver(resources)` carrying the v4 matching rule (first
`ident` segment equal to a `ref` wins ; single resource of the provider
when the path carries no ref ; ambiguity → null). Hosts may supply another
resolver, for instance one that lets the GitHub plugin derive the
environment from the branch. A `bindingsEnvResolver` bridge keeps the v4
pipeline compiling until P1.6 and is deleted with it.

### D4 — YAML catalog loaded at boot, TypeScript twins retired

`risk-catalog.yaml` is the only catalog artefact. The SDK loads it with
`loadCatalogFile(new URL('./risk-catalog.yaml', import.meta.url))` at module
load — that is, at gateway boot — through a strict validator : every key
known, provider slug, every id of the plugin's provider and matching the
RiskId grammar, every `matches` pattern parsing as a slice of that provider,
the six vector axes from the closed enums, `vector_overrides` and
`acceptable_in_envs` well-formed, a `<provider>.uncategorized-*` fallback
present (risk-model spec §4.3 says MUST ; `prepareCatalog` only warned),
then `prepareCatalog` from `policy-engine`. Issues are collected and
reported together, path-qualified (`risks[3].vector.blast`). The YAML is
parsed with the YAML 1.2 core schema, so dates stay strings and nothing is
coerced. The `risk-catalog.ts` twins and the `risk-catalog-sync` tests
disappear from each plugin as it migrates (P1.2).

The catalog gains `catalog_version` (monotonic integer) and `catalog_date`.
Renaming or deleting a risk stays forbidden ; a risk is `deprecated` with a
`replaced_by`, and the loader refuses deprecated risks in presets.

### D5 — Presets ship in the catalog ; the persisted policy is always explicit

Renaud's ruling, recorded here : presets are **shipped by plugins** in their
catalog, they are **UI sugar**, and the **persisted policy is always the
explicit enumeration** — never a preset reference.

```yaml
presets:
  - id: developer # slug, unique in the catalog
    label: Developer
    description: Read everywhere, write on staging, approval on prod writes.
    entries:
      - risk_id: github.read-code # a risk of THIS catalog, account- or env-scoped
        quota: 2000 # actions per period — always a number
        rate_limit: { max: 120, window_seconds: 60 }
        gate: auto # auto | approval, default auto
```

The loader and `definePlugin` enforce : at least one preset per plugin ;
preset ids unique ; every `risk_id` an explicit id (no wildcard, no
sentinel) of the same provider and present in the catalog ; an
env-qualified entry targets an env-scoped risk and an env inside its
`acceptable_in_envs` ; quota and rate limit positive integers ; gate from
the closed set ; no deprecated risk. This is the structural test of spec
§10 "every plugin ships at least one preset, and every preset references
only RiskIds of its own catalog", run at boot and in every plugin's test
suite. The shared types `Preset`, `PresetEntry`, `Budget`, `RateLimit`,
`Gate` are the same ones a `MissionPolicyEntry` uses, so pre-filling a
policy from a preset is a copy, not a translation. The _values_ of the
first real presets remain the subject of the deferred ADR
`mission-presets-default-values` (plan §5.5) ; this ADR fixes the shape and
the rules, not the numbers.

### D6 — One registry, every list derived

`PluginRegistry` (`packages/plugin-sdk/src/registry.ts`) is built once by
the host from the plugins it ships. It rejects duplicate ids and ill-formed
plugins, indexes every catalog with `prepareCatalog`, and derives :
`ids` (the provider list), `providerForTool(toolName)` (exact tool name,
then the prefix rule), `toolDeclarations()`, `labels()` for the UI,
`idEnum()` for validation schemas (a non-empty tuple ; throws on an empty
registry rather than produce an enum that accepts nothing), `catalogOf(id)`
and `presetsOf(id)`. Tool names cannot collide across plugins because ids
are unique and the prefix rule is a bijection on ids, checked per plugin.
Nothing else in the repository may enumerate providers ; the v4 `Provider`
union and `PROVIDERS` constant are quarantined in `legacy-v4.ts` and
deleted with the last v4 consumer.

`toolPrefixFor(id)` and `splitToolName(name)` in `@vaubaan/shared` are pure
string helpers ; membership is always the registry's call.

### D7 — Mandatory test kit

`@vaubaan/plugin-sdk/testing` ships framework-agnostic assertions that
throw `PluginAssertionError` with every finding :

- `assertPluginWellFormed(plugin)` — `definePlugin`'s checks ;
- `assertCatalogCoverage(plugin, samples)` — every declared tool has at
  least one sample call, every non-denied sample yields ≥ 1 slice of the
  plugin's provider, every slice is matched by ≥ 1 catalog risk ; returns
  the touched and untouched risks ;
- `assertNoWildcard(catalog | plugin | ids)` — no pattern or sentinel in a
  risk id, a preset entry, or a persisted list (restriction,
  `accepted_risks`) ;
- `assertPresetsValid(catalog | plugin)` — D5 ;
- `mockFetch(routes)` — a `fetch` double that records calls, answers by
  method and URL, enforces `times`, and **rejects any unmatched request**.

A plugin's `tests/unit/plugin.test.ts` runs the four assertions and
exercises `execute` and `discoverResources` against `mockFetch` ; this is
the "unit tests kept, community validation" of pivot ADR D5. The `_template`
test file is the reference.

### D8 — `shared` reset and the legacy quarantine

`@vaubaan/shared` holds the v5 domain types (spec §2 : `User`, `Group`,
`Principal`, `Delegation`, `Connection`, `Credential`, `Resource`,
`ConnectionResource`, `Share`, `Restriction`, `Mission`,
`MissionPolicyEntry`, `Period`, `MissionToken`, `Session`, `SessionEvent`,
`SessionCounter`, `Request`, `Approval`), the eight `RefusalCode` values
(spec §4.1 plus `wrong-credential-kind`, §6), `parseRiskId` /
`formatRiskId` / `baseRiskId` / `isExplicitRiskId`, and the MCP primitives.
The v4 row types still compiled against by the ten plugins, the v4 gateway
pipeline and the v4 web app are moved, unchanged but `@deprecated`, into
`legacy-v4.ts`, re-exported from the barrel. Rule : no new import from that
module ; it is deleted, with the `policy-engine` bridges and
`scope-injection.ts`, when P1.2 and P1.6 remove the last consumer. Types
with no consumer (`EscalationChannel`, `TokenContextPayload`,
`narrowTokenContext`, the deprecated aliases, `RiskAcceptance`) are deleted
now.

### D9 — Plugin versioning

`version` is semver and is what telemetry reports (spec §9 :
`plugin_version`). Rules : patch for a fix that changes no risk id, no
tool name and no preset ; minor for a new tool, a new risk, a new preset or
a widened `matches` ; major when a tool is removed or a classification
becomes stricter in a way that refuses calls it used to allow. A risk id is
never renamed or removed (D4) ; `catalog_version` is bumped on every
reviewed YAML change, independently of `version`.

## Consequences

- A plugin can be written, tested and reviewed without the gateway :
  `plugins/_template` compiles against the SDK alone and its test runs the
  kit. `plugins/README.md` is the contributor guide ;
  `docs/handbook/plugin-sdk.md` the maintainer handbook.
- P1.2 migrates each plugin by : replacing the adapter class with
  `definePlugin`, moving credential acquisition into a `CredentialSpec`,
  deleting `risk-catalog.ts` and its sync test, adding `presets:` to the
  YAML, replacing `ProviderBinding[]` with `Resource[]` in the classifier,
  and adding the kit to the test file. The `_template` shows the target.
- P0.5 (`gateway-core`) and P1.6 (execution door) consume `PluginRegistry`,
  `ExecuteContext`, `resourceEnvResolver` and `RefusalCode` ; the v4
  `evaluateCall({ bindings })` form still works through the bridge until
  then.
- The structural tests of spec §10 for presets and wildcards exist as code
  (loader + kit) ; the store (P0.3) adds the write-time FK check against
  the loaded catalog.
- The catalog becomes **stricter at boot** : a YAML without fallback, with
  an unknown key or without preset refuses to load. Two of the ten v4 YAMLs
  (railway, ssh) use a legacy top-level shape (`railway:` instead of
  `provider:`) and none ships presets ; all are fixed in P1.2.
- Scope injection has no v5 behaviour yet : the v4 module answers `null`
  unless explicitly enabled, and the `normalizeArgs` hook is not called by
  default. Deciding §8-Q4 flips one flag, not a contract.
- Negative : the SDK validates by hand rather than with a schema library,
  so adding a catalog field means editing the validator and its tests ;
  accepted to keep the SDK dependency-light (`js-yaml` only) and the error
  messages precise.

## Rejected alternatives

### Keep the duck-typed adapter and document it

Cheapest, but a third party cannot discover a contract that lives in the
host's call sites, and nothing stops a plugin from importing the gateway.
Rejected : the SDK is the product surface for contributors.

### Plugins implement their own connect routes

v4 did this (`/api/integrations/<provider>/connect`). It spreads OAuth
security details (PKCE, state, redirect validation) across ten code bases
written by different authors. Rejected : the host runs four generic flows
and the plugin declares parameters.

### Keep the TypeScript catalog twins for bundler safety

The constraint came from Vercel's Lambda bundling. v5 runs in a Docker
image where reading a YAML next to the module is trivial, and two sources
of truth for the one security artefact under review is exactly what the
sync tests were compensating for. Rejected.

### Validate the YAML with zod or JSON Schema

zod was declared in three packages and imported in none ; a schema library
would be the SDK's only runtime dependency besides `js-yaml`, and the
cross-field rules (env-qualified preset entries, deprecated risks, fallback)
need custom code anyway. Rejected for now ; the validator is small and
fully tested, and can be replaced behind the same `validateCatalog`
function.

### Persist a preset reference on the mission

Simpler UI state, but a preset changed in a later plugin version would
silently alter running missions, and the spec (§0 "Preset", §3.2, §10)
forbids anything but the explicit enumeration. Rejected ; presets are copied
into the policy at issuance.

### Presets as a cross-provider concept ("developer" for every plugin)

What "developer" means on GitHub has no equivalent on Stripe (spec §3.2).
Rejected : presets are provider-specific and live in the plugin's catalog.

### Resolve environments from the catalog entry alone

Env-scoped risks need a resource to say which environment a call touches ;
without the mission's resources the runtime cannot qualify
`supabase.bulk-row-write` into `supabase[prod].bulk-row-write`. Rejected ;
the `EnvResolver` keeps the runtime pure while letting the host choose the
source.

### Delete `scope-injection.ts` now

Plan §8-Q4 is still open. Deleting costs twelve tests and a behaviour
Renaud may want back ; keeping it unguarded would let v5 code depend on a
module hard-coded to four SaaS providers. Quarantined behind a default-off
flag instead.

### Delete the v4 row types outright

Would break the ten plugins, `gateway-core` and the web app in the same
feature, in parallel with three other features editing those trees.
Quarantined in `legacy-v4.ts` with a deletion rule instead.

## References

- Spec : [`vaubaan-gateway.md`](../spec/vaubaan-gateway.md) §0, §2, §3.2,
  §5, §10 ; [`gateway-risk-model.md`](../spec/gateway-risk-model.md) §2, §4,
  §7.
- Handbooks : [[plugin-sdk]], [[policy-engine]].
- Code : `packages/plugin-sdk/`, `packages/shared/src/{domain,risk,risk-id,refusal,mcp,legacy-v4}.ts`,
  `packages/policy-engine/src/{qualify,risk-runtime,legacy-bindings,scope-injection}.ts`,
  `plugins/_template/`.
- Plan : `.vaubaan/reports/v5-implementation-plan.md` §1.1, §1.2, §1.4,
  §3.7, §4 P0.2, §5.10, §8-Q4 (untracked).

## Amendment 2026-10-13 — streamed results (P2.7)

Adds to D1 (the plugin API) ; changes none of the decisions above. Handbook :
[execution-door](../handbook/execution-door.md), "Streaming".

### Context

Spec §4.1 ("Streaming") : a tool call is always answered by one complete
result ; a plugin reading a long upstream response may emit its parts as they
arrive, and the decision is made before anything leaves. MCP answers a
`tools/call` with exactly one JSON-RPC message, in the 2025-era protocol and in
2026-07-28 alike : there is no partial result. What may leave before that
message is a `notifications/progress` on the call's own event stream, and only
for a caller that sent `_meta.progressToken`.

### Decision

- **A sink in the context.** `ExecuteContext` gains an optional
  `emitPart(part: McpToolContent): Promise<void>` ; the SDK adds
  `streamToolResult`, `textParts` and `appendPart` (`streaming.ts`). `execute`
  still returns one complete `McpToolResult`. The change is additive : a
  plugin that ignores `emitPart` behaves as before, and no shipped plugin
  streams yet.
- **Parts travel as progress notifications, one complete result closes the
  call.** Each part leaves the gateway at once as `notifications/progress`
  (`progress` = parts so far, a text part as `message`) ; the complete result
  is still sent at the end, and is the only thing a caller without a progress
  token receives, as one JSON body.
- **The decision comes first.** `emitPart` is reachable from the upstream
  stage only, the pipeline's last : mission state, resource, risk and the
  budget transaction (decrement, `call-allowed` event) are committed before
  the first byte. A refused call reaches no plugin and is answered by its
  error alone.
- **One audit entry, when the stream ends**, with the latency of the whole
  stream. A stream that breaks after N parts stays `allowed`, records
  `stream failed after N parts` and keeps its credit consumed
  ([[atomic-budget-accounting]]).
- **No replay after a first part.** The refresh-and-retry ladder of
  [[upstream-credential-cache-and-rejected-credentials]] applies only while
  nothing was emitted ; a 401 after a part is a stream failure and leaves the
  connection untouched.
- **A caller that goes away stops the stream at the next part** : `emitPart`
  rejects and the entry records it. A call that does not stream is not
  affected by a disconnect.

### Consequences

- The complete result is held in memory until the end : what is not buffered
  is the delivery, not the result. A tool whose output does not fit needs
  pagination, not streaming.
- A progress notification carries text parts only, is not stored and is not
  resumable (the door is stateless : no event store, no `Last-Event-ID`). A
  caller that loses the connection calls again, and that is a new call for
  the budget.
- Between the first part and the end of the stream, the record of the
  decision is the counter and the session event ; a process that dies
  mid-stream leaves a counted action without its audit entry, which
  `countersAgreeWithAudit` reports.
- Nothing changes in the process shape of [[docker-image-and-config-format]] :
  the Next standalone server and the reference Caddyfile carry the event
  stream unbuffered as shipped (measured ; handbook `execution-door`, "What
  the process shape allows").

### Rejected alternatives

- **A streamed return type (`AsyncIterable`) for `execute`.** MCP answers a
  `tools/call` with exactly one message, so the host needs the complete
  result in every case ; a second return type would have widened `execute`
  for all eleven plugins and their tests to express what a callback already
  does, and would have left the host to assemble a result the plugin knows
  better how to build.
- **Replaying a call after a first part** (the retry ladder applied to a
  stream that failed). The caller would receive the beginning twice.
- **A change of transport or of process shape for streaming.** Not needed :
  the transport supports it without any change.
