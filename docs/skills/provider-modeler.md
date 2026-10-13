---
title: Provider modeler — modelling a new provider plugin
status: current
date: 2026-10-13
last_synced: 2026-10-13
tracks:
  - plugins/README.md
  - plugins/_template/src/
  - plugins/_template/tests/unit/
  - packages/plugin-sdk/src/index.ts
  - packages/plugin-sdk/src/plugin.ts
  - packages/plugin-sdk/src/define-plugin.ts
  - packages/plugin-sdk/src/catalog-loader.ts
  - apps/gateway/src/server/compose/shipped-plugins.ts
---

# Provider modeler

> **How to use.** This skill is not loaded automatically. Tell the agent:
> "Read `docs/skills/provider-modeler.md`, then model the provider
> `<vendor>`."

You model a new provider for Vaubaan Gateway as a plugin on the v5 SDK
(`@vaubaan/plugin-sdk`). A plugin is complete or it does not load:
`definePlugin` rejects a definition without a data model, a catalog, a
`CredentialSpec`, `classify`, `execute` and `discoverResources`, and the
catalog loader rejects a catalog without a preset. The mechanics (file by file, YAML shape, SDK calls) are in
[`plugins/README.md`](../../plugins/README.md), "Writing a plugin"; this file
is the method around it.

## Inputs — ask before starting

1. The provider id: a lowercase slug (`notion`, `cloudflare-dns`). The tool
   prefix turns `-` into `_` (`cloudflare_dns__`).
2. The API surface: the upstream documentation, the list of tools wanted, or
   an existing MCP server to rewrap.
3. The why: the operational use case, which bounds the risks worth modelling.

## Read first

- [`plugins/README.md`](../../plugins/README.md) and the scaffold
  [`plugins/_template`](../../plugins/_template/README.md).
- [`docs/handbook/plugin-sdk.md`](../handbook/plugin-sdk.md): the contract,
  the catalog loader, environment resolution, the test kit.
- [`docs/spec/gateway-risk-model.md`](../spec/gateway-risk-model.md) §2 (data
  model), §3 (slice DSL), §4 (risk catalog), §7 (plugin). Where the spec and
  the SDK disagree, the loader and the test kit are the rules that run.
- One existing plugin and its handbook under
  [`docs/handbook/providers/`](../handbook/providers/README.md): `vercel` (one
  plane, environment in the call), `supabase` (several planes), `github`
  (app installation, per-call token), `ssh` (shell commands on a host),
  `railway` (rewrapped remote MCP server, OAuth with refresh).

Provider documentation comes from Context7
(`mcp__context7__resolve-library-id`, then `mcp__context7__query-docs`), not
from memory and not from ad-hoc web fetches.

## Phases

1. **Research — validated by a human before any code.** Draft the handbook
   `docs/handbook/providers/<vendor>.md` with the six sections listed in
   [`providers/README.md`](../handbook/providers/README.md) (data model,
   tool → slice mapping, catalog and presets, coverage, edge cases,
   credential / discovery / execution / tests) and the open questions. Stop
   and submit it.
2. **Scaffold.** Copy `plugins/_template` to `plugins/<vendor>` and rename
   `template` everywhere (folder, `package.json` name, plugin `id`, catalog
   `provider:`, tool prefix, data-model provider).
3. **Data model** — `src/data-model.ts`, exported as `<vendor>DataModel`
   (`vercelDataModel`, `gmailDataModel`): planes, entities with `parent` and
   `cardinalities`, and the `envScopable` entity. `definePlugin` runs
   `validateDataModel` on it.
4. **Risk catalog** — `src/risk-catalog.yaml`, the only catalog artefact:
   - Every risk has an explicit id `<vendor>.<name>`, never renamed and never
     deleted (`deprecated: true` with `replaced_by` instead).
   - Exactly one `<vendor>.uncategorized-write` entry flagged
     `fallback: true`. It is touched only when no dedicated entry matches a
     write, so every tool must be covered by a dedicated risk.
   - A risk that depends on the environment is one entry with
     `acceptable_in_envs` (and `vector_overrides.<env>` when the vector
     changes), never two ids with the environment in the name. The runtime
     qualifies it as `<vendor>[<env>].<name>` from the owner's label on the
     resource, or from the plugin's `envOf` when the environment lives in
     the call.
   - `presets:` is mandatory, at least one. Each entry names an explicit
     risk id of this catalog (env-qualified where the risk is env-scoped)
     with a numeric `quota`, a `rate_limit` and a `gate` (`auto` or
     `approval`). Never a wildcard or a sentinel, never the fallback, never
     a deprecated id: an "allow all" preset is the explicit enumeration.
5. **Classifier** — `src/classify.ts`:
   `classify<Vendor>(tool, args, resources): ClassifyOutcome`. Pure. It fails
   closed: an unknown tool, a resource that is ambiguous or outside the
   mission, or a missing or malformed identifier is `{ denied }`, never a
   broader slice. A call touching several entities returns several slices; a
   credential minted by a call is a write.
6. **Execute** — `src/execute.ts`: `ctx.fetch` only, the secret narrowed with
   `expectCredentialKind`, `UpstreamAuthError` on 401 / 403, an
   `McpToolResult` back.
7. **Credential** — the `CredentialSpec` in `definePlugin`: `api-key`,
   `oauth2`, `app-install` or `ssh-key`. The host runs the flow and the
   standard `refresh_token` grant; declare `refresh()` only for a
   non-standard one.
8. **Discovery** — `discoverResources(ctx)`: the `Resource` refs
   (`provider`, `ref`, `displayName`, optional `metadata`) the owner will
   label and a mission will select. The classifier sees the same refs.
9. **Tests** — keep `tests/unit/plugin.test.ts` from the template: the kit of
   `@vaubaan/plugin-sdk/testing` (`assertPluginWellFormed`,
   `assertPresetsValid`, `assertNoWildcard`, `assertCatalogCoverage` with at
   least one sample per tool), asserting that the coverage report has no
   `fallbackHits` and an explained `risksUntouched`. Add one classifier case
   per branch, `denied` paths included, and run `execute` and
   `discoverResources` against `mockFetch`. No test calls a real provider.
10. **Handbook** — align `docs/handbook/providers/<vendor>.md` with the code,
    with this frontmatter, and add the row to the index table of
    `docs/handbook/providers/README.md`:

    ```yaml
    ---
    title: <Vendor> provider plugin
    status: current
    date: <YYYY-MM-DD>
    last_synced: <YYYY-MM-DD>
    tracks:
      - plugins/<vendor>/src/
      - plugins/<vendor>/tests/unit/
    ---
    ```

11. **Registration** — one import and one array entry in
    `apps/gateway/src/server/compose/shipped-plugins.ts`, plus the
    `@vaubaan/plugin-<vendor>` dependency in `apps/gateway/package.json`. That
    registry is the single provider list; add the provider to no other list.

## Commands

- `npx vitest run plugins/<vendor>` — the plugin's tests (plugin packages
  have no `test` script).
- `npm run type-check` — every workspace.
- `npm run ci` — type-check, lint, format check, build, tests; must be green.

## Guard rails

- The specs are read-only from here; report a gap instead of working around
  it.
- No new slice notation: names, identifiers, `*`, `**` and lists only.
- English only, in code, YAML labels and the handbook.
- Add a `CHANGELOG.md` entry under `[Unreleased]`; hand back the file list,
  the test run and the open questions.
