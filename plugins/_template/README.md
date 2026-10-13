# Plugin template

Copy this folder to `plugins/<provider>`, then give it its identity in **two
places**: `PROVIDER_ID` in `src/identity.ts` and `provider:` (with the risk
and preset ids) in `src/risk-catalog.yaml`. The plugin id, the data-model
provider, the tool names (`TOOL`), the discovered resources and the
credential field (`API_KEY_FIELD`) are all derived from `src/identity.ts` —
never write the provider id or a tool name as a literal anywhere else.
Rename the folder and the `package.json` name, then fill in the files:

| File                    | What goes in it                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `src/identity.ts`       | `PROVIDER_ID`, the tool names derived from it (`TOOL`), the credential field name.               |
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

Two rules the scaffold already applies and a copy must keep:

- **The resource ref is checked by the classifier.** `resolveWorkspace` in
  `src/classify.ts` accepts an explicit ref only when it is one of the
  mission's `resources`, and refuses the call otherwise (it never falls back
  to the single resource). `execute` calls the same function, so the slice
  always names the resource the call runs on.
- **Provider answers are untrusted.** `discoverResources` checks the payload
  with a type guard before building `Resource`s; no `as` on upstream JSON.

The full guide is [`plugins/README.md`](../README.md); the contract is
documented in [`docs/handbook/plugin-sdk.md`](../../docs/handbook/plugin-sdk.md).
