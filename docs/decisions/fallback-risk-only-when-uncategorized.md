---
title: The fallback risk counts only when no other entry matched, and the environment of a slice is resolved plugin-first
status: accepted
date: 2026-10-13
extends:
  - plugin-contract-and-credential-spec
  - pivot-to-risk-based-model
  - unified-gates-drop-confirm
amends:
  - plugin-contract-and-credential-spec
---

# The fallback risk counts only when no other entry matched, and the environment of a slice is resolved plugin-first

> Two runtime rules of the risk evaluation, surfaced by the first plugin
> migrations to the v5 SDK (P1.2e stripe, P1.2 vercel) and fixed in P1.2-SDK :
> **when** the catch-all `<provider>.uncategorized-write` entry is part of
> `risks_touched`, and **how** the environment of an executed slice is
> resolved when the provider carries it in the call rather than on the
> resource. Implemented in `@vaubaan/policy-engine` (`risk-evaluator.ts`,
> `qualify.ts`) and `@vaubaan/plugin-sdk` (loader, `ProviderPlugin.envOf`).

## Context

### The fallback co-fired with every write

The risk-model spec (§4.3) requires every catalog to declare a fallback
entry, `<provider>.uncategorized-write`, matching `<provider>.**.W`, whose
stated purpose is "catch-all for writes that have not been explicitly
categorized ; if seen in production, it signals a missing catalog entry".

`risksTouchedBy` implemented the fallback like any other entry : every
entry whose pattern intersects the slice is touched. Since the fallback's
pattern intersects **every** write, every write touched the fallback **in
addition to** its dedicated entry — `github.repo[x].branch[main].W` touched
`github.merge-protected` _and_ `github.uncategorized-write`. The runtime
then requires `risks_touched ⊆ accepted_risks`, so a mission that accepted
`merge-protected` but not the fallback was refused.

The stripe migration (P1.2e) made the consequence visible : every write
preset had to carry the fallback (`stripe[test].uncategorized-write`,
`stripe[live].uncategorized-write`), and the stripe test suite asserts
"write presets carry the fallback of their mode (the engine never drops
it)". That defeats the fallback's purpose twice over : accepting it no
longer means "I accept writes the catalog has not reviewed", it means
"I want any write at all" ; and since every write preset includes it, its
appearance in an audit log no longer signals anything. The four parallel
migrations (github, vercel, supabase, railway) were about to copy the same
workaround.

### The environment was resolved from the resource label only

Spec §0 "Resource" : environment-qualified `RiskId`s "resolve against the
environment label of the resource a call touches ; for providers where the
environment lives in the arguments (the branch, for GitHub), the plugin
derives it". The policy engine's default resolver, `resourceEnvResolver`,
implements only the first half : the slice's first `ident` segment equal to
a resource `ref` yields that resource's `env`. For Vercel the environment
is a slice segment (`vercel.project[p].env[prod].env-var[X].W`) ; for
GitHub it is the branch. With label-only resolution a Vercel project
labelled `staging` by its owner qualifies a prod env-var write as
`vercel[staging].env-var-write`, and a preset entry `vercel[prod].deploy`
never matches `risks_touched`. The vercel migration already exports a
`vercelEnvOf(slice)` with nothing to plug it into.

## Decision

### D1 — The fallback is touched only when no other entry matched

`risksTouchedBy(slice, catalog)` partitions the matching entries into
non-fallback and fallback. It returns the non-fallback matches when there
is at least one ; otherwise the fallback, when it matched ; otherwise the
empty set. In `risksTouchedByAll` the rule applies per slice, so a call
with one categorized and one uncategorized write touches the dedicated
entry _and_ the fallback.

"No silent passthrough" is preserved : a write matched by no dedicated
entry still touches the fallback and is refused unless the mission
accepted it ; a slice matching nothing at all — not even the fallback,
which catches writes only — still yields an empty set, which the runtime
refuses as a catalog gap. Overlapping dedicated entries keep co-firing
(`ssh.exec-read` and `ssh.exec-read-secret-files`) : only the fallback is
subject to the rule.

### D2 — The fallback is an explicit flag, detected by convention when absent

`RiskEntry` gains `fallback?: boolean` (`@vaubaan/shared`), accepted by the
YAML loader. `isFallbackEntry(entry, provider)` in the policy engine
decides : the flag when present ; otherwise the catch-all write pattern
`<provider>.**.W` (bare or bracketed `[**]`) or the id prefix
`<provider>.uncategorized-` — the convention every existing catalog follows,
including GitHub's whose fallback pattern is `github.repo[**].W` and would
not be recognised by pattern alone. `IndexedRiskCatalog` carries the
resulting `fallback` boolean per entry, so the hot path reads a flag.

The SDK loader (`fallbackIssues`) requires **exactly one** fallback entry
per catalog, named `<provider>.uncategorized-*` so audit logs read the same
for every provider ; zero or two is a boot error listing the entries.
`fallback: false` on a catch-all entry opts it out explicitly. The template
and the SDK fixture declare `fallback: true` ; existing catalogs keep
loading unchanged through the detection and add the flag as they migrate.

### D3 — Presets should not include the fallback ; the loader warns

With D1, a preset entry on the fallback pre-accepts exactly the writes the
catalog has not reviewed, which is the opposite of what a reviewed preset
is for. The loader reports it through `catalogWarnings` → `warn` (default
`console.warn`, injectable), not as an error : a provider may have a
reasoned exception, and a mission creator may still accept the fallback by
hand at issuance. The template's presets do not include it.
`assertCatalogCoverage` reports `fallbackHits` — the samples a dedicated
entry does not cover — so a plugin author sees the gap in the test output.

### D4 — Environment resolution is plugin-first, label next, unqualified last

`ProviderPlugin` gains the optional pure hook
`envOf?(slice, resources): string | undefined`. The policy engine gains
`EnvDeriver` (the same signature, without importing the SDK) and
`envResolverFor(resources, derive?)`, the composed default resolver :

1. `derive(slice, resources)` when provided and non-empty — the plugin
   knows the environment is in the slice (Vercel's `env[prod]` segment,
   GitHub's branch) ;
2. else the owner's label on the matching resource (`resourceEnvResolver`,
   unchanged) — Supabase, Railway, and Stripe whose plugin labels one
   resource per mode at discovery ;
3. else `null` : the risk stays unqualified.

The SDK ships `envFromSliceSegment(entity)` for the common case : it reads
the identifier that follows the named entity (`envOf:
envFromSliceSegment('env')` for Vercel) and returns `undefined` for
wildcards, lists, or an absent segment. The function form was preferred to
a purely declarative `envFrom: 'slice-segment' | 'resource-label'` because
GitHub's rule (branch → environment) is not a segment lookup ; the helper
gives the declarative case one line without closing the door on the other.

Hosts build the resolver per call with
`envResolverFor(missionResources, plugin.envOf?.bind(plugin))`. Wiring it
into `gateway-core`'s `evaluateCallForToken` (widen `adapter` to
`Pick<ProviderPlugin, 'classify' | 'envOf'>`, default resolver →
`envResolverFor`) and declaring `envOf` in the vercel and github plugins
is the follow-up P1.2-align ; this ADR fixes the contract.

## Consequences

- A mission built from a preset without the fallback can perform every
  write the preset names. The stripe presets that carry
  `stripe[test|live].uncategorized-write` now trigger the loader warning
  and should drop those entries (P1.2-align) ; their test "write presets
  carry the fallback" encodes the old rule and goes with them.
- `risks_touched` in audit logs shrinks to the dedicated entries ; the
  fallback's appearance again means "a catalog entry is missing". The
  `CoverageReport.fallbackHits` list surfaces the same signal at test time.
- Existing tests asserting the co-fire were inverted deliberately, each
  with a comment citing this ADR : `policy-engine` (`risk-evaluator`,
  `risk-runtime`), `gateway-core` (`risk-gateway`), `plugins/_template`,
  the SDK kit, and the v4 catalog tests of `ssh`, `railway`, `supabase`,
  `cloudflare-dns`. The latter three are rewritten by their migrations.
- The YAML schema has one more key ; a typo (`fallbak`) is still refused.
  `hasFallbackRisk` and `fallbackRiskPrefix` moved from `risk-policy.ts` to
  `risk-evaluator.ts` (same barrel exports).
- Env-qualified preset entries (`vercel[prod].deploy`) become matchable
  once the host wires `envResolverFor` and the plugin declares `envOf` ;
  until then behaviour is unchanged (`envResolverFor(resources)` without a
  deriver is exactly `resourceEnvResolver(resources)`).
- Negative : the fallback rule is one more special case in the evaluator
  (a dozen lines) and a contributor reading only the YAML cannot tell that
  the fallback behaves differently — hence the mandatory `fallback: true`
  in the template and the handbook section.

## Rejected alternatives

### Require every write preset to carry the fallback

What the stripe plugin did. Mechanically simple, but it turns the fallback
into a mandatory "allow writes" switch, makes its audit appearance
meaningless, and pre-accepts the unreviewed writes in every preset. The
spec's own description of the fallback ("if seen in prod, a catalog entry
is missing") is incompatible with it. Rejected.

### Drop the fallback entirely

Without it a write no entry covers yields an empty `risks_touched`, which
the runtime already refuses. The fallback then only adds an explicit opt-in
for uncategorized writes. That opt-in is useful (an operator who knowingly
runs a new tool before the catalog is updated) and the spec says MUST ;
removing it would also change every catalog and the store's write-time
check. Rejected ; kept, with the semantics the spec describes.

### Make a preset that includes the fallback a boot error

Cleaner than a warning, but it would refuse to boot the stripe plugin
today and forbid a provider's reasoned exception. A warning in the boot
log and in test output, plus `fallbackHits`, gives the signal without the
cliff. Can be tightened later by one line.

### Detect the fallback by pattern only

Would miss GitHub's `github.repo[**].W` and any provider whose writes all
live under one root entity. The explicit flag is authoritative ; pattern
and id prefix are the compatibility path.

### A declarative `envFrom` on the plugin instead of a function

Covers Vercel in one line but not GitHub, whose environment is a function
of the branch name and the mission's resources. The function hook plus the
`envFromSliceSegment` helper gives both. A purely declarative form can be
added later as sugar producing the same hook.

### Resolve the environment inside `gateway-core` with provider `switch`es

Reintroduces the hard-coded provider list the registry removed (memory
rule : one source of truth). The plugin owns its data model ; it owns the
environment derivation.

## References

- Spec : [`gateway-risk-model.md`](../spec/gateway-risk-model.md) §4.3 ;
  [`vaubaan-gateway.md`](../spec/vaubaan-gateway.md) §0 "Resource", §3.2,
  §10.
- ADR amended : [[plugin-contract-and-credential-spec]] (D1 contract, D4
  loader) ; sibling [[plugin-catalog-path-and-standalone-tracing]].
- Handbooks : [[plugin-sdk]], [[policy-engine]].
- Code : `packages/policy-engine/src/{risk-evaluator,qualify,risk-policy}.ts`,
  `packages/plugin-sdk/src/{catalog-loader,env-of,plugin,testing/assertions}.ts`,
  `packages/shared/src/risk.ts`, `plugins/_template/src/risk-catalog.yaml`.
