---
title: Plugin SDK — the contract a provider plugin implements
tracks:
  - packages/plugin-sdk/src/
  - packages/plugin-sdk/package.json
  - packages/plugin-sdk/README.md
  - packages/plugin-sdk/scripts/
  - packages/plugin-sdk/tsconfig.build.json
  - packages/shared/src/mcp.ts
  - packages/shared/src/risk.ts
  - plugins/_template/
  - apps/gateway/next.config.ts
last_reviewed: 2026-10-31
---

# Plugin SDK — handbook

`@vaubaan/plugin-sdk`, the package a plugin author writes against, including outside this repo.
Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §5,
[gateway-risk-model](../spec/gateway-risk-model.md) §4.6 (macro-actions), §7. ADRs:
[plugin-contract-and-credential-spec](../decisions/plugin-contract-and-credential-spec.md),
[plugin-identifiers-one-grammar-for-classify-and-execute](../decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md),
[fallback-risk-only-when-uncategorized](../decisions/fallback-risk-only-when-uncategorized.md),
[macro-actions-and-trust-levels-prefill-the-policy](../decisions/macro-actions-and-trust-levels-prefill-the-policy.md).
Contributor guide: [`plugins/README.md`](../../plugins/README.md).

## Start here

- [`plugin.ts`](../../packages/plugin-sdk/src/plugin.ts) — `ProviderPlugin`, every member's doc.
- [`define-plugin.ts`](../../packages/plugin-sdk/src/define-plugin.ts) — what is refused at
  definition (all issues in one `PluginDefinitionError`); the credential checks are in
  `credential-issues.ts`.
- [`catalog-loader.ts`](../../packages/plugin-sdk/src/catalog-loader.ts) — the YAML entry points;
  the structure is `catalog-document.ts` / `catalog-risk-entry.ts`, the rules a TypeScript catalog
  also meets are `catalog-rules.ts`.
- [`transport/`](../../packages/plugin-sdk/src/transport/index.ts) — the one way to call a provider:
  `httpJson`, `readBounded`, `readShape`, the upstream MCP client.
- [`data-model-paths.ts`](../../packages/plugin-sdk/src/data-model-paths.ts) — a slice or a
  pattern walked on the data model.
- [`testing/`](../../packages/plugin-sdk/src/testing/index.ts) (`@vaubaan/plugin-sdk/testing`) — the
  assertions every plugin runs, `policyFromMacroActions`, `decideCall` and what tests need of the
  policy engine. [`git/`](../../packages/plugin-sdk/src/git/index.ts) (`@vaubaan/plugin-sdk/git`) —
  the git wire code, for GitHub and the host's git door.
- [`plugins/_template`](../../plugins/_template/src/index.ts) — a complete plugin to copy;
  [`plugins/miro`](../../plugins/miro/src/execute.ts) — a rewrap on the SDK's MCP client.

## The contract

| Rule                    | What the plugin must do                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Imports                 | `@vaubaan/plugin-sdk`, `/testing`, `/git` only, tests included (`no-restricted-imports` on `plugins/**`); never `process.env`, never the OAuth client secret, no app configuration.                                                                                                                                                                                                |
| `classify`              | Pure. `connection?.fields` are the non-secret form fields only, never the credential (`{ fields: {} }` for OAuth).                                                                                                                                                                                                                                                                 |
| Names                   | `PROVIDER_ID`, `TOOL_PREFIX` and `TOOL` in `src/identity.ts`; no tool name or provider id literal elsewhere in `src/` but `tools.ts` (`plugin-names-declared-once.test.ts`).                                                                                                                                                                                                       |
| Same grammar both sides | One grammar function per identifier kind, used by `classify` and `execute`; refuse, never escape (`encodeURIComponent` keeps `.` / `..`). Default path segment: `pathIdent` in the template.                                                                                                                                                                                       |
| Unplaceable call        | `denied`, never a broad slice. A raw value that the slice grammar cannot carry → `identSegment` / `ANY_IDENT` (every instance), the SDK's, never a copy or a repair (`plugin-identifier-helpers.test.ts`).                                                                                                                                                                         |
| Closed arguments        | An executor that forwards `args` calls `undeclaredArgumentDenial` in `classify` (audited, before the budget) **and** in `execute`; `routing` names the arguments the plugin rewrites itself.                                                                                                                                                                                       |
| Resource ref            | An explicit ref must be one of the mission's resources, else `denied`; absent → the single resource; none or several → `denied`.                                                                                                                                                                                                                                                   |
| Calling the provider    | Through the transport: `httpJson(ctx, request, guard)` or the MCP client (`callUpstreamTool`, `mcpRequest`); a body read by hand through `readBounded` and `upstreamFailure`. Never `.json()` / `.text()` on a response (`plugin-transport.test.ts`).                                                                                                                              |
| Provider failure        | Thrown, typed by the transport: `UpstreamAuthError` (401/403), `UpstreamHttpError` (other status), `UpstreamProtocolError` (502: a JSON-RPC error frame, not JSON, a shape the guard refuses), or the `fetch` error. Only a 401 is a rejected credential (refresh, retry, then `expired`).                                                                                         |
| Untrusted answer        | Read through a guard (`httpJson`'s, `readShape`), never a cast (`as …Dto` refused by `plugin-transport.test.ts`); bounded (`maxBytes`, 10 MB by default).                                                                                                                                                                                                                          |
| Declining               | `ExecutorRefusal` under `declining()`, or `refusalResult()`: an `isError` result, "nothing failed at the provider". Never a plain `Error` (reads as a provider failure).                                                                                                                                                                                                           |
| Credential refusal      | `CredentialRefusal` from `verify` / `discoverResources`: the plugin's own sentence, ≤ 300 chars, never provider text or credential.                                                                                                                                                                                                                                                |
| Credential              | One `CredentialSpec` per plugin, the simplest the provider offers; `oauth2` has exactly one client source: `clientRegistration` (RFC 7591 by the host) or `broker` (fields of its own refused).                                                                                                                                                                                    |
| Service mark            | `icon` (the `d` of one 24×24 path) and `iconColor` (`#RRGGBB`) vendored together in `src/icon.ts` with a comment naming the source (Simple Icons CC0, or drawn); never an icon package. Required of shipped plugins (`plugin-icons.test.ts`).                                                                                                                                      |
| Token guide             | An `api-key` way declares `label`, `createUrl` (the token page itself), `guide` (`steps` as `GuideStep`, `reach`, `permissions`, `expiry`, `docsUrl`) and `verify`, or `definePlugin` refuses it. The grant asked is the widest (ADR one-place-to-authorize-services-token-first, amended); `verify` names the account and throws `CredentialRefusal` for every cause it can name. |
| Revocation              | `credential.revocation` declared (`token-form` / `client-credentials-json`) or `revoke(ctx)`; else `manualRevocation` is what the person reads.                                                                                                                                                                                                                                    |
| Streaming               | Open the provider response before the first `emitPart`, await every `emitPart`, throw when the stream breaks (the credit stays consumed).                                                                                                                                                                                                                                          |
| Data model              | Every slice and every live pattern is a path of `dataModel`: rooted at a declared entity, each name a child of the one before (a descendant after `[**]`), only the last name a virtual leaf; a leaf two letters from an entity is its typo. Cardinalities are checked on slices unless turned off.                                                                                |
| Created resources       | `resourceCreatingTools` requires `createdResources`; its answer is untrusted: every ref goes through the discovery grammar.                                                                                                                                                                                                                                                        |
| Catalog                 | Exactly one fallback `<provider>.uncategorized-*` matching `<provider>.**.W`, in no macro-action; every other live entry in exactly one macro-action (`macroActionIssues`); every key known; a `presets` key refused (retired). A rule for TS catalogs goes in `semanticIssues`.                                                                                                   |
| `envOf`                 | A label, `undefined` (use the resource label) or `NO_SINGLE_ENV` for a wildcard or list: then the label is not consulted and env-scoped risks are refused.                                                                                                                                                                                                                         |
| Plugin versions         | Semver; below `1.0.0` while young. A stricter classification is a major (minor before 1.0). A wording-only catalog change bumps `catalog_version`, not the plugin version. `definePlugin`'s `version` equals `package.json`'s; the README states neither version (`plugin-versions.test.ts`).                                                                                      |
| Shipping                | No hidden plugin state: a plugin not ready is not in `SHIPPED_PLUGINS`. At most one plugin declares `gitRemote`.                                                                                                                                                                                                                                                                   |

## Versions of the SDK

`@vaubaan/plugin-sdk` has its own semver, in `packages/plugin-sdk/package.json`; **the SDK moves
when the contract moves**: a change of `packages/plugin-sdk/src/` that a plugin can observe bumps it
in the same pull request, with its line under `### Plugin SDK` in `CHANGELOG.md`.

| Change                                                                                                                                                                                                                                                                                     | From `1.0.0` | Before `1.0.0` |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | -------------- |
| Breaking: an export, a subpath, a `ProviderPlugin` member or a field of an exported type removed or renamed; an optional member made required; a rule of `definePlugin`, the loader or the kit that refuses what it accepted; a helper that throws or returns otherwise for the same input | major        | minor          |
| A new export, a new optional member, a new kit assertion a plugin may call                                                                                                                                                                                                                 | minor        | patch          |
| A fix that makes a check do what its documentation says, wording of a message                                                                                                                                                                                                              | patch        | patch          |

## Publication

The package is publishable, not published. `npm pack --workspace @vaubaan/plugin-sdk` builds
`dist/` (`tsconfig.build.json`: JavaScript and declarations, `.ts` imports rewritten) and packs
`dist/`, `README.md` and `package.json` only. Inside the repository `exports` point at `src/*.ts`;
`prepack` swaps in the published manifest (`publishConfig.exports` → `dist/`,
`scripts/publish-manifest.ts`) and `postpack` restores it — npm does not apply `publishConfig.exports`
itself. A stray `package.repo.json` means a pack died between the two: `node
scripts/publish-manifest.ts restore`.

Its dependencies `@vaubaan/shared` and `@vaubaan/policy-engine` are workspace packages with
`exports` on TypeScript sources and version `0.0.0`: published as they are, the SDK cannot be
installed. Either publish both too, or inline them. **Recommended: inline them** (bundle the
JavaScript the SDK uses and roll up its declarations at build): `@vaubaan/shared` carries `argon2`, a
native module no plugin needs, and publishing both would make two more APIs public contracts with
versions of their own, while plugin authors only ever write against the SDK.

## Traps

- Never `new URL('./risk-catalog.yaml', import.meta.url)`: Turbopack rewrites it into a static
  asset and `next build` fails. Use `loadCatalogFile(catalogPathNextTo(import.meta.url))`; its
  `join` carries `turbopackIgnore` (without it the whole app, tests included, is traced into
  `.next/standalone`).
- The YAML reaches `.next/standalone` only through the `plugins/*/src/**/*.yaml` glob of
  `outputFileTracingIncludes` in `apps/gateway/next.config.ts`: keep it under
  `plugins/<id>/src/` (`standalone-plugin-catalogs.test.ts` checks after a build).
- `@vaubaan/shared`'s barrel is server-only (`node:crypto`); code the UI bundles takes
  values from `@vaubaan/shared/risk-id`, `/domain`, `/api-key`.
- A plugin matching a glob from its arguments uses `matchWildcard`, never a `RegExp`.
- A destructive operation gets its own risk through a verb leaf (`widget[<id>].delete.W`); the
  broad write covers it too, so a mission needs both.

## Procedures

- A test of what a guide says reads `guideText(guide)`; a fixture plugin whose guide is not
  under test takes `apiKeyCredentialFixture(fields)` (both in `@vaubaan/plugin-sdk/testing`).
- Every plugin test runs `assertPluginWellFormed`, `assertNoWildcard`,
  `assertCatalogCoverage` (one sample per tool, `risksUntouched` `[]`, `fallbackHits` empty) and
  `assertIdentifiersRefused` (`plugin-identifier-tests.test.ts` fails a plugin without it), and
  `assertSlicesOnDataModel` on the same samples. Every shipped catalog is walked on its model by
  `plugin-data-model-paths.test.ts`, with no known gap. The check moves into `definePlugin` once
  the gateway's `depot` test fixture (`src/server/execution/testing.ts`, `account.profile`) walks
  its own model too.
- A test of one call's decision uses `decideCall(plugin, { tool, args, resources, accepted })`: the
  classifier, then the engine with `envResolverFor(resources, plugin.envOf)`, as the gateway does
  (no budget, no gate).
- A test of what a mission allows builds it with `policyFromMacroActions(plugin, { <id>: <trust level> },
{ envs })`, not by hand: it runs the policy engine's trust-level rules (`expandAtTrustLevel`), as
  the creation form does. It does not model the creator's authority.
- `npx vitest run packages/plugin-sdk plugins/_template`; the standalone test after `next build`.

## Debug

- **`Invalid risk catalog`** → every bullet is path-qualified; `the fallback … must match the
catch-all write` → give the fallback `<provider>.**.W`, move the narrow pattern to a named risk.
- **`ENOENT … risk-catalog.yaml` in the container** → the YAML is not under `plugins/<id>/src/`.
- **`report.fallbackHits` not empty** → a catalog entry is missing (the fallback catches writes
  only; a read covered by nothing is refused).
- **Audit shows `upstream_error` though nothing left** → a plain `Error` used to decline.
- **`… is restricted from being used by a pattern`** (lint, `plugins/**`) → the import is the
  gateway's: take it from `@vaubaan/plugin-sdk` or `/testing`; a function a test needs and the kit
  lacks is added to `testing/decide.ts`.
- **`'x' is not below 'y' in the data model, and a virtual leaf ends the path`** → an entity
  missing from `dataModel`, or a slice that skips one; `did you mean '…'` → a typo.
- **`credential.guide: expected { steps, reach, permissions, expiry, docsUrl }`** → an `api-key`
  way without its guide: copy `plugins/_template/src/credential.ts`. A step written as a string is
  `steps[i]: expected { do, url?, code? }`.
