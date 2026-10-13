# `@vaubaan/plugin-template`

The scaffold a provider plugin starts from: a complete, working plugin for an
imaginary provider (`template`: workspaces that hold widgets), written the way
the shipped plugins are. It loads, it passes the SDK test kit, and it is
never registered in the gateway.

**Starting a plugin?** Follow [`plugins/README.md`](../README.md) step by
step; it tells you when to copy this folder and what to change in each file.
After the copy, rewrite this README for your provider, keeping the sections
below: they are the ones every shipped plugin documents (compare
[`plugins/cloudflare-dns/README.md`](../cloudflare-dns/README.md)).

Contract: [`plugin-contract-and-credential-spec`](../../docs/decisions/plugin-contract-and-credential-spec.md).
SDK handbook: [`docs/handbook/plugin-sdk.md`](../../docs/handbook/plugin-sdk.md).

## Files

| File                        | What goes in it                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `package.json`              | `@vaubaan/plugin-<id>`, the version (equal to `version` in `src/index.ts`), the SDK as the only dependency.       |
| `src/identity.ts`           | `PROVIDER_ID`, the tool names derived from it (`TOOL`), the credential field name. The one place ids are written. |
| `src/data-model.ts`         | The entities a slice path can name, per plane, with containment and cardinalities.                                |
| `src/risk-catalog.yaml`     | The risks, their slice patterns, the six-axis vector, the `fallback: true` entry, and at least one preset.        |
| `src/tools.ts`              | The MCP tools, named `<prefix>__<verb>_<noun>`, with their JSON input schema.                                     |
| `src/classify.ts`           | `(tool, args, resources) → slices`. The security-critical part: pure, fails closed, tested branch by branch.      |
| `src/execute.ts`            | The calls to the provider with the credential the gateway hands over, and `discoverResources`.                    |
| `src/index.ts`              | `definePlugin({...})`: the wiring, the `CredentialSpec`, the default export the gateway registers.                |
| `tests/unit/plugin.test.ts` | The SDK kit (well-formed, coverage, presets, no wildcard), the classifier cases, `execute` against `mockFetch`.   |

## Data model

One plane, `workspace`:

```
workspace[<workspace id>]      the resource; labelled staging / prod by its owner (envScopable)
  └─ widget[<widget id>]
```

## Credential and resources

Kind `api-key`, one required secret field:

| Field     | Pattern               | Purpose                                              |
| --------- | --------------------- | ---------------------------------------------------- |
| `api_key` | `^[A-Za-z0-9_-]{8,}$` | An API key with read and write access to workspaces. |

`discoverResources` calls `GET /workspaces` and returns **one resource per
workspace**: `ref` is the workspace id every tool takes as `workspace`,
`displayName` its name. The answer is checked with a type guard, and a
workspace id that is not a path-safe identifier fails the discovery.

## Tools

Three tools named `template__<verb>_<noun>`. Each takes `workspace`, which
must be one of the mission's workspaces (it may be omitted when the mission
holds exactly one).

| Tool                      | Slice                                         |
| ------------------------- | --------------------------------------------- |
| `template__list_widgets`  | `template.workspace[<ws>].widget[*].R`        |
| `template__get_widget`    | `template.workspace[<ws>].widget[<widget>].R` |
| `template__update_widget` | `template.workspace[<ws>].widget[<widget>].W` |

`workspace` and `widget_id` end up in the request path, so both must be one
path-safe segment, `^[A-Za-z0-9_-]{1,64}$` (`pathIdent` in `src/classify.ts`,
applied by `classify` and by `execute`). `.`, `..`, a `/` or any other
character is refused before classification and before any call.

## Catalog

`src/risk-catalog.yaml`, version 1: two named risks and the fallback.

| Risk                           | Action | Notes                                                                        |
| ------------------------------ | ------ | ---------------------------------------------------------------------------- |
| `template.read-widgets`        | R      | Every widget read.                                                           |
| `template.widget-write`        | W      | Env-scoped (`staging`, `prod`); the vector is harsher on `prod`.             |
| `template.uncategorized-write` | W      | Fallback (`fallback: true`); touched by no tool of the plugin, in no preset. |

## Presets

| Preset      | Scope                                                                            |
| ----------- | -------------------------------------------------------------------------------- |
| `reader`    | `read-widgets`, `auto`.                                                          |
| `developer` | Reads, `widget-write` on staging `auto`, `widget-write` on prod with `approval`. |

Presets are a shortcut of the issuance form: the mission that is saved holds
the explicit list of risks, never a reference to the preset.

## Tests

`npx vitest run plugins/_template` — 23 tests: the SDK kit
(`assertPluginWellFormed`, `assertCatalogCoverage`, `assertNoWildcard`,
`assertPresetsValid`), the version and default-export check, the classifier
branch by branch (refusals and path-safe identifiers included), `execute` and
`discoverResources` against `mockFetch`. No test calls a provider.
