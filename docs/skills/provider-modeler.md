---
title: Provider modeler — modelling a new provider plugin
status: current
date: 2026-10-13
last_synced: 2026-10-14
tracks:
  - plugins/README.md
  - plugins/_template/src/
  - plugins/_template/tests/unit/
  - plugins/_template/README.md
  - packages/plugin-sdk/src/index.ts
  - packages/plugin-sdk/src/plugin.ts
  - packages/plugin-sdk/src/define-plugin.ts
  - packages/plugin-sdk/src/catalog-loader.ts
  - packages/plugin-sdk/src/credential.ts
  - packages/plugin-sdk/src/testing/assertions.ts
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
catalog loader rejects a catalog without a preset.

**The procedure is [`plugins/README.md`](../../plugins/README.md)**, the
plugin kit: steps 0 to 11, each with the file to write, the rules and the
command that checks it. This file does not repeat it. It says what an agent
adds around it: what to ask, where to stop for a human, and what to hand
back. Where the two disagree, the kit wins; report the disagreement.

## Inputs — ask before starting

1. The provider id: a lowercase slug (`notion`, `cloudflare-dns`). The tool
   prefix turns `-` into `_` (`cloudflare_dns__`).
2. The API surface: the upstream documentation, the list of tools wanted, or
   an existing MCP server to rewrap.
3. The why: the operational use case, which bounds the risks worth modelling.
4. How the provider authenticates, if the human already knows: a pasted key,
   OAuth consent, an installed app, an SSH key.

## Read first

- [`plugins/README.md`](../../plugins/README.md), whole, and the scaffold
  [`plugins/_template`](../../plugins/_template/README.md).
- [`docs/handbook/plugin-sdk.md`](../handbook/plugin-sdk.md): the contract,
  the catalog loader, environment resolution, the test kit.
- [`docs/spec/gateway-risk-model.md`](../spec/gateway-risk-model.md) §2 (data
  model), §3 (slice DSL), §4 (risk catalog), §7 (plugin). Where the spec and
  the SDK disagree, the loader and the test kit are the rules that run.
- One existing plugin and its handbook under
  [`docs/handbook/providers/`](../handbook/providers/README.md), chosen for
  its resemblance: `cloudflare-dns` (`api-key`, one resource per zone,
  layered write risks), `vercel` (environment in the call), `supabase`
  (several planes, `api-key`), `github` (`api-key` with a guide, the git
  remote), `ssh` (`ssh-key`, shell commands classified from their text, an
  injectable transport), `miro` (rewrapped remote MCP server, `oauth2` with a
  client the gateway registers itself), `gmail` (`api-key` app password over
  IMAP, an injectable transport).

Provider documentation comes from Context7, not from memory and not from
ad-hoc web fetches. Context7 is reached through the gateway, like any other
provider: once the dogfood instance has a Context7 connection in the
mission behind the `vaubaan` server, the tools are
`mcp__vaubaan__context7__resolve-library-id`, then
`mcp__vaubaan__context7__query-docs` (plugin `context7`, handbook
[`providers/context7`](../handbook/providers/context7.md)). The key is that
connection only: never in an environment variable or in `.mcp.json`. Record which pages the
classifier was written from: the pull request states them.

## Phases

The numbers on the right are the steps of the kit.

1. **Research — validated by a human before any code** (step 0). Draft the
   handbook `docs/handbook/providers/<vendor>.md` with its six sections
   (data model; tool → slice mapping; catalog and presets; coverage; edge
   cases; credential, discovery, execution, tests) and a list of open
   questions. It must already answer:
   - what a **resource** is, and where the environment comes from (the
     owner's label, a mode of the provider, a segment of the call);
   - the **risks**, each with its six-axis vector and the reason it deserves
     its own decision, and which are env-scoped;
   - the **presets**: at least a read-only one and one for daily work, each
     entry with a quota, a rate limit and a gate, and which risks are
     deliberately in no preset;
   - the **credential kind**, the narrowest key or scopes that work, and for
     an installed app how the installation is bound to the user who made it.

   **Stop and submit it.** Do not scaffold before the human has answered.

2. **Scaffold** (step 1). Copy `plugins/_template`, set the identity in its
   three places, rename the exported symbols, run `npm install`, and check
   that the copied tests pass under the new id.
3. **Data model** (step 2).
4. **Risk catalog and presets** (step 3). The rules that are refused when
   broken, in one place:
   - explicit ids `<vendor>.<name>`, never renamed, never deleted
     (`deprecated: true` with `replaced_by`);
   - exactly one `<vendor>.uncategorized-write` entry matching
     `<vendor>.**.W` and flagged `fallback: true`; reads need their own
     entries;
   - a destructive operation gets its own risk through a verb leaf of the
     data model (`…record[<id>].delete.W`); a slice matching several risks
     touches all of them, the mission needs each one, and one gated
     `approval` gates the call;
   - an environment-dependent risk is one entry with `acceptable_in_envs`,
     never two ids;
   - `label`, `reason` and a preset's `description` are shown verbatim in
     Reference and in the dialogs of a mission, where a risk is called a
     permission, a gate "runs freely" or "ask me first" and a budget
     "limits": a sentence that addresses the reader about the product uses
     those words, a sentence about the provider keeps the provider's; ids,
     keys and structure keep the contract's names;
   - `presets:` is mandatory. Every entry is an explicit risk id of this
     catalog (env-qualified where the risk is env-scoped) with a numeric
     `quota`, a `rate_limit` and a `gate`. **Never a wildcard or a sentinel,
     never the fallback, never a deprecated id**: a preset that allows
     everything enumerates everything.
5. **Tools and classifier** (step 4). Pure and fail closed: an unknown tool,
   a resource that is ambiguous or outside the mission, a missing or
   malformed identifier is `{ denied }`, never a broader slice. An identifier
   that reaches a URL path is one path segment (`pathIdent`). A call touching
   several entities returns several slices; a call that hands out a
   credential is a write.
6. **Credential** (step 5). One `CredentialSpec`: `api-key` (with its
   `label`, `createUrl`, `guide` and `verify`) whenever a person can make a
   key at the provider, `oauth2` only where none exists — and then with
   `clientRegistration`: the gateway registers its own client, no
   administrator declares one (ADR gmail-over-imap-with-an-app-password) —,
   or `ssh-key`. The host runs the flow and the standard `refresh_token`
   grant; declare `refresh()` only for a non-standard one. The plugin never
   sees a client secret and never reads the environment.
7. **Resources** (step 6). `discoverResources(ctx)` returns the refs the
   owner will label and a mission will select; the classifier compares with
   the same refs. The provider's answer goes through a type guard.
8. **Execution** (step 7). `ctx.fetch` only; the secret narrowed with
   `expectCredentialKind`; the target resolved with the classifier's
   functions. A provider failure is thrown (`UpstreamAuthError` on 401 / 403,
   `UpstreamHttpError` otherwise); `isError: true` is returned only for what
   the executor declines itself. `ctx.emitPart` with `streamToolResult` only
   for a provider that answers progressively.
9. **Wire and test** (step 8). The default export; the kit of
   `@vaubaan/plugin-sdk/testing` (`assertPluginWellFormed`,
   `assertPresetsValid`, `assertNoWildcard`, `assertCatalogCoverage` with at
   least one sample per tool), asserting no `fallbackHits` and an explained
   `risksUntouched`; one classifier case per branch, refusals included;
   `execute` and `discoverResources` against `mockFetch`. No test calls a
   real provider.
10. **README and handbook** (step 9). The plugin's `README.md` in the
    template's sections; the handbook of phase 1 aligned with the code as
    written, with its `tracks:` frontmatter, and its row in the index of
    `docs/handbook/providers/README.md`.
11. **Registration** (step 10). The dependency in
    `apps/gateway/package.json`, then one import and one array entry in
    `apps/gateway/src/server/compose/shipped-plugins.ts`. That registry is
    the single provider list; add the provider to no other list, and nothing
    to the configuration examples.
12. **Version and changelog** (step 11). A new plugin starts at `0.1.0`, the
    same in `src/index.ts` and `package.json`; `catalog_version: 1`; one
    entry in the root `CHANGELOG.md` under `[Unreleased]`.

## Commands

- `npx vitest run plugins/<vendor>` — the plugin's tests (plugin packages
  have no `test` script).
- `npm run type-check` — every workspace.
- `npm run ci` — type-check, lint, format check, build, tests; must be green.

## Guard rails

- The specs are read-only from here; report a gap instead of working around
  it.
- No new slice notation: names, identifiers, `*`, `**` and lists only.
- Never a hard-coded instance URL or secret; the provider's public API base
  is a constant of the plugin.
- English only, in code, YAML labels and the handbook.
- Do not open the pull request and do not commit unless asked. Hand back the
  file list, the output of the test run, the provider documentation used,
  what you decided alone, and the open questions.
