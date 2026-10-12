# Plugin template

Copy this folder to `plugins/<provider>`, rename `template` to your provider
id everywhere (folder, `package.json` name, `src/index.ts` id, catalog
`provider:`, tool prefix, data-model provider), then fill in the six files:

| File                    | What goes in it                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `src/risk-catalog.yaml` | The risks of the provider, their slice patterns, the 6-D vector, and at least one preset.        |
| `src/data-model.ts`     | The entities a slice path can name, per plane, with containment and cardinalities.               |
| `src/tools.ts`          | The MCP tools, named `<provider>__<verb>_<noun>`, with their JSON input schema.                  |
| `src/classify.ts`       | `(tool, args, resources) → slices` — the security-critical part; pure, unit-tested exhaustively. |
| `src/execute.ts`        | Calls to the provider with the credential the gateway hands you; `fetch` comes from the context. |
| `src/index.ts`          | `definePlugin({...})` wiring the above plus the `CredentialSpec` and `discoverResources`.        |

Keep `tests/unit/plugin.test.ts`: it runs the mandatory kit
(`assertPluginWellFormed`, `assertCatalogCoverage`, `assertNoWildcard`,
`assertPresetsValid`) and shows how to exercise `execute` with `mockFetch`.
Add classifier cases until every branch of `classify.ts` is covered.

The full guide is [`plugins/README.md`](../README.md); the contract is
documented in [`docs/handbook/plugin-sdk.md`](../../docs/handbook/plugin-sdk.md).
