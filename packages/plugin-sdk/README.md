# @vaubaan/plugin-sdk

The contract a plugin of [Vaubaan Gateway](https://github.com/vaubaan/gateway)
implements, the test kit it runs, and the helpers it calls its service with.

Vaubaan Gateway is an open-source MCP gateway: a coding agent works under a
**mission** (resources, accepted risks, a budget) instead of holding a cloud
credential. A plugin teaches the gateway one service. It does two things the
gateway cannot: it **classifies** a tool call into the **slices** of the
service's data model it touches, which the gateway matches against the
**risks** of the plugin's catalog; and it **executes** an allowed call with
the credential the gateway hands it. It never sees the mission, the accepted
risks or the budget.

## Install

```bash
npm install @vaubaan/plugin-sdk
```

## The shape of a plugin

<!-- prettier-ignore -->
```ts
import { catalogPathNextTo, definePlugin, loadCatalogFile } from '@vaubaan/plugin-sdk';
const { catalog } = loadCatalogFile(catalogPathNextTo(import.meta.url)); // ./risk-catalog.yaml
export default definePlugin({ id: 'acme', displayName: 'Acme', version: '0.1.0', catalog, dataModel, tools, credential, classify, execute, discoverResources });
```

`definePlugin` checks the whole definition when the module loads and lists
every problem at once. Three entry points:

| Import                        | What it holds                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@vaubaan/plugin-sdk`         | `ServicePlugin` and its types, `definePlugin`, the catalog loader, identifier grammars, and the one way to call a service: `httpJson`, `readBounded`, `readShape`, the upstream MCP client. |
| `@vaubaan/plugin-sdk/testing` | The assertions every plugin test runs (`assertCatalogCoverage`, `assertIdentifiersRefused`, `assertSlicesOnDataModel`…), `mockFetch`, `policyFromMacroActions`, `decideCall`.               |
| `@vaubaan/plugin-sdk/git`     | The git wire code and `GitRemoteCapability`, for a plugin that is its agents' git remote.                                                                                                   |

## Write one

Start a project with the command line, `npx @vaubaan/plugin-cli init` (a
complete plugin for an imaginary service, its tests passing), then follow the
author's guide,
[vaubaan.com/docs/plugins-guide](https://vaubaan.com/docs/plugins-guide): the
data model, the risk catalog, the classifier, the credential, execution, the
test kit, signing, deploying and submitting to the catalog. The contract's
rules and traps, for the SDK's own maintainers, are in the
[plugin SDK handbook](https://github.com/vaubaan/gateway/blob/main/docs/handbook/plugin-sdk.md).

## Versions

Semantic versioning, below `1.0.0` while the contract settles: a minor version
may break a plugin, and every breaking change is listed under "Plugin SDK" in
the [changelog](https://github.com/vaubaan/gateway/blob/main/CHANGELOG.md).

## License

Apache-2.0.
