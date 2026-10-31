---
title: Plugin SDK — the contract a provider plugin implements
tracks:
  - packages/plugin-sdk/src/
  - packages/plugin-sdk/package.json
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
[macro-actions-and-trust-crans-prefill-the-policy](../decisions/macro-actions-and-trust-crans-prefill-the-policy.md).
Contributor guide: [`plugins/README.md`](../../plugins/README.md).

## Start here

- [`plugin.ts`](../../packages/plugin-sdk/src/plugin.ts) — `ProviderPlugin`, every member's doc.
- [`define-plugin.ts`](../../packages/plugin-sdk/src/define-plugin.ts) — what is refused at
  definition (all issues in one `PluginDefinitionError`).
- [`catalog-loader.ts`](../../packages/plugin-sdk/src/catalog-loader.ts) — the YAML catalog rules.
- [`testing/`](../../packages/plugin-sdk/src/testing/index.ts) — the assertions every plugin runs, and
  `policyFromMacroActions`, a mission's lines from macro-actions at crans.
- [`plugins/_template`](../../plugins/_template/src/index.ts) — a complete plugin to copy.

## The contract

| Rule                    | What the plugin must do                                                                                                                                                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Imports                 | `@vaubaan/plugin-sdk` only; never `process.env`, never the OAuth client secret, no app configuration.                                                                                                                                                                            |
| `classify`              | Pure. `connection?.fields` are the non-secret form fields only, never the credential (`{ fields: {} }` for OAuth).                                                                                                                                                               |
| Same grammar both sides | One grammar function per identifier kind, used by `classify` and `execute`; refuse, never escape (`encodeURIComponent` keeps `.` / `..`). Default path segment: `pathIdent` in the template.                                                                                     |
| Unplaceable call        | `denied`, never a broad slice. A raw value that the slice grammar cannot carry → `identSegment` / `ANY_IDENT` (every instance).                                                                                                                                                  |
| Closed arguments        | An executor that forwards `args` calls `undeclaredArgumentDenial` in `classify` (audited, before the budget) **and** in `execute`; `routing` names the arguments the plugin rewrites itself.                                                                                     |
| Resource ref            | An explicit ref must be one of the mission's resources, else `denied`; absent → the single resource; none or several → `denied`.                                                                                                                                                 |
| Provider failure        | Thrown: `UpstreamAuthError` (401/403), `UpstreamHttpError` (other status), or the `fetch` error. Only a 401 is a rejected credential (refresh, retry, then `expired`).                                                                                                           |
| Declining               | `ExecutorRefusal` under `declining()`, or `refusalResult()`: an `isError` result, "nothing failed at the provider". Never a plain `Error` (reads as a provider failure).                                                                                                         |
| Credential refusal      | `CredentialRefusal` from `verify` / `discoverResources`: the plugin's own sentence, ≤ 300 chars, never provider text or credential.                                                                                                                                              |
| Credential              | One `CredentialSpec` per plugin, the simplest the provider offers; `oauth2` has exactly one client source: `clientRegistration` (RFC 7591 by the host) or `broker` (fields of its own refused).                                                                                  |
| Service mark            | `icon` (the `d` of one 24×24 path) and `iconColor` (`#RRGGBB`) vendored together in `src/icon.ts` with a comment naming the source (Simple Icons CC0, or drawn); never an icon package. Required of shipped plugins (`plugin-icons.test.ts`).                                    |
| Revocation              | `credential.revocation` declared (`token-form` / `client-credentials-json`) or `revoke(ctx)`; else `manualRevocation` is what the person reads.                                                                                                                                  |
| Streaming               | Open the provider response before the first `emitPart`, await every `emitPart`, throw when the stream breaks (the credit stays consumed).                                                                                                                                        |
| Created resources       | `resourceCreatingTools` requires `createdResources`; its answer is untrusted: every ref goes through the discovery grammar.                                                                                                                                                      |
| Catalog                 | Exactly one fallback `<provider>.uncategorized-*` matching `<provider>.**.W`, in no macro-action; every other live entry in exactly one macro-action (`macroActionIssues`); every key known; a `presets` key refused (retired). A rule for TS catalogs goes in `semanticIssues`. |
| `envOf`                 | A label, `undefined` (use the resource label) or `NO_SINGLE_ENV` for a wildcard or list: then the label is not consulted and env-scoped risks are refused.                                                                                                                       |
| Versions                | Semver; below `1.0.0` while young. A stricter classification is a major (minor before 1.0). A wording-only catalog change bumps `catalog_version`, not the plugin version.                                                                                                       |
| Shipping                | No hidden plugin state: a plugin not ready is not in `SHIPPED_PLUGINS`. At most one plugin declares `gitRemote`.                                                                                                                                                                 |
| Reserved                | `normalizeForCaps` is never called by the v5 host ([scope-caps-amplification-axis](../decisions/scope-caps-amplification-axis.md)); `normalizeArgs` only behind a host flag, default off.                                                                                        |

## Traps

- Never `new URL('./risk-catalog.yaml', import.meta.url)`: Turbopack rewrites it into a static
  asset and `next build` fails. Use `loadCatalogFile(catalogPathNextTo(import.meta.url))`; its
  `join` carries `turbopackIgnore` (without it the whole app, tests included, is traced into
  `.next/standalone`).
- The YAML reaches `.next/standalone` only through the `plugins/*/src/**/*.yaml` glob of
  `outputFileTracingIncludes` in `apps/gateway/next.config.ts`: keep it under
  `plugins/<id>/src/` (`standalone-plugin-catalogs.test.ts` checks after a build).
- `@vaubaan/shared`'s barrel is server-only (argon2, `node:crypto`); code the UI bundles takes
  values from `@vaubaan/shared/risk-id`, `/domain`, `/api-key`.
- A plugin matching a glob from its arguments uses `matchWildcard`, never a `RegExp`.
- A destructive operation gets its own risk through a verb leaf (`widget[<id>].delete.W`); the
  broad write covers it too, so a mission needs both.

## Procedures

- Every plugin test runs `assertPluginWellFormed`, `assertNoWildcard`,
  `assertCatalogCoverage` (one sample per tool, `risksUntouched` `[]`, `fallbackHits` empty) and
  `assertIdentifiersRefused` (`plugin-identifier-tests.test.ts` fails a plugin without it).
- A test of what a mission allows builds it with `policyFromMacroActions(plugin, { <id>: <cran> },
{ envs })`, not by hand: it runs the policy engine's cran rules (`expandAtCran`) and asks first
  for a write-token handout (`writeHandoutRiskIds`), as the creation form does. It does not model
  the creator's authority.
- `npx vitest run packages/plugin-sdk plugins/_template`; the standalone test after `next build`.

## Debug

- **`Invalid risk catalog`** → every bullet is path-qualified; `the fallback … must match the
catch-all write` → give the fallback `<provider>.**.W`, move the narrow pattern to a named risk.
- **`ENOENT … risk-catalog.yaml` in the container** → the YAML is not under `plugins/<id>/src/`.
- **`report.fallbackHits` not empty** → a catalog entry is missing (the fallback catches writes
  only; a read covered by nothing is refused).
- **Audit shows `upstream_error` though nothing left** → a plain `Error` used to decline.
