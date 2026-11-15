# `@vaubaan/plugin-template`

The scaffold a plugin starts from: a complete, working plugin for an
imaginary service (`template`: workspaces that hold widgets), written the way
the shipped plugins are. It loads, it passes the SDK test kit, and it is
never registered in the gateway.

**Starting a plugin?** Follow [`plugins/README.md`](../README.md) step by
step; it tells you when to copy this folder and what to change in each file.
After the copy, rewrite this README for your service, keeping the sections
below: they are the ones every shipped plugin documents (compare
[`plugins/cloudflare-dns/README.md`](../cloudflare-dns/README.md)).

Contract: [`plugin-contract-and-credential-spec`](../../docs/decisions/plugin-contract-and-credential-spec.md).
SDK handbook: [`docs/handbook/plugin-sdk.md`](../../docs/handbook/plugin-sdk.md).

## Files

| File                        | What goes in it                                                                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`              | `@vaubaan/plugin-<id>`, the version (equal to `version` in `src/index.ts`), the SDK as the only runtime dependency.                                            |
| `src/identity.ts`           | `SERVICE_ID`, the tool names derived from it (`TOOL`), the credential field name. The one place ids are written.                                               |
| `src/data-model.ts`         | The entities a slice path can name, per plane, with containment and cardinalities.                                                                             |
| `src/risk-catalog.yaml`     | The risks, their slice patterns, the six-axis vector, the `fallback: true` entry, and the macro-actions.                                                       |
| `src/tools.ts`              | The MCP tools, named `<prefix><verb>_<noun>` (`template__list_widgets`), with their JSON input schema.                                                         |
| `src/classify.ts`           | `(tool, args, resources) → slices`. The security-critical part: pure, fails closed, tested branch by branch.                                                   |
| `src/credential.ts`         | The `CredentialSpec`: the token page, the guide (steps, how wide to grant and why, permissions, expiry) and `verify`, the check at paste.                      |
| `src/execute.ts`            | The calls to the service through the SDK's `httpJson`, with the credential the gateway hands over, and `discoverResources`.                                    |
| `src/index.ts`              | `definePlugin({...})`: the wiring, the default export the gateway registers.                                                                                   |
| `tests/unit/plugin.test.ts` | The SDK kit (well-formed, coverage, slices on the data model, no wildcard), a mission from macro-actions, the classifier cases, `execute` against `mockFetch`. |

## Data model

One plane, `workspace`:

```
workspace[<workspace id>]      the resource; labelled staging / prod by its owner (envScopable)
  └─ widget[<widget id>]
       └─ delete               verb leaf: the deletion, a write with its own risk
```

## Credential and resources

Kind `api-key`, one required secret field:

| Field     | Pattern               | Purpose                                                |
| --------- | --------------------- | ------------------------------------------------------ |
| `api_key` | `^[A-Za-z0-9_-]{8,}$` | An API key over all workspaces, with every permission. |

The connect page shows the guide of `src/credential.ts`: the key page, the
steps, the grant (all workspaces, every permission: each mission narrows it)
and the permissions with the tools they serve. `verify` asks `GET /me` who the
key acts as before anything is stored.

`discoverResources` calls `GET /workspaces` and returns **one resource per
workspace**: `ref` is the workspace id every tool takes as `workspace`,
`displayName` its name. The answer is read through a type guard, and a
payload the guard refuses, or a workspace id that is not a path-safe
identifier, fails the discovery as the service's failure
(`UpstreamProtocolError`).

## Tools

Four tools named `template__<verb>_<noun>`. Each takes `workspace`, which
must be one of the mission's workspaces (it may be omitted when the mission
holds exactly one).

| Tool                      | Slice                                                |
| ------------------------- | ---------------------------------------------------- |
| `template__list_widgets`  | `template.workspace[<ws>].widget[*].R`               |
| `template__get_widget`    | `template.workspace[<ws>].widget[<widget>].R`        |
| `template__update_widget` | `template.workspace[<ws>].widget[<widget>].W`        |
| `template__delete_widget` | `template.workspace[<ws>].widget[<widget>].delete.W` |

`workspace` and `widget_id` end up in the request path, so both must be one
path-safe segment, `^[A-Za-z0-9_-]{1,64}$` (`pathIdent` in `src/classify.ts`,
applied by `classify` and by `execute`). `.`, `..`, a `/` or any other
character is refused before classification and before any call.

## Catalog

`src/risk-catalog.yaml`: three named risks and the fallback.

| Risk                           | Action | Notes                                                                                    |
| ------------------------------ | ------ | ---------------------------------------------------------------------------------------- |
| `template.read-widgets`        | R      | Every widget read.                                                                       |
| `template.widget-write`        | W      | Every widget write, deletions included (`widget[**].W`). Env-scoped (`staging`, `prod`). |
| `template.widget-delete`       | W      | The `delete` leaf. Env-scoped. Irreversible.                                             |
| `template.uncategorized-write` | W      | Fallback (`fallback: true`); touched by no tool of the plugin, in no macro-action.       |

Writes are layered: a deletion touches `widget-write` and `widget-delete`,
and a mission needs both.

## Macro-actions

A creator ticks macro-actions at a trust level (Careful / Trusting / Autonomous),
risk model §4.6: the trust level sets each risk's gate from its vector and scales its
base budget; the mission stores the explicit lines.

| Macro-action | What it covers                     | Its risks                                         |
| ------------ | ---------------------------------- | ------------------------------------------------- |
| `read`       | Read widgets.                      | `template.read-widgets`                           |
| `write`      | Create, modify and delete widgets. | `template.widget-write`, `template.widget-delete` |

The gateway adds "Anything else", holding the fallback.

## Tests

`npx vitest run plugins/_template` — 26 tests: the SDK kit
(`assertPluginWellFormed`, `assertCatalogCoverage`, `assertNoWildcard`, and
`assertIdentifiersRefused` on the plugin's `examples`, `src/examples.ts`), a mission written from the
macro-actions (`policyFromMacroActions`),
the version and default-export check, the classifier
branch by branch (refusals, path-safe identifiers and the risks a deletion
touches included), `execute` and
`discoverResources` against `mockFetch`. No test calls a service.
