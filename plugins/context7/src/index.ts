/**
 * `@vaubaan/plugin-context7` — the Context7 provider plugin.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7.
 * ADRs     : docs/decisions/railway-rewrap-remote-mcp.md (the rewrap shape) ;
 *            docs/decisions/plugin-contract-and-credential-spec.md.
 * Handbook : docs/handbook/providers/context7.md ; guide : plugins/README.md.
 *
 * Why : "everything goes through our gateway, zero env". The Context7 key is
 * a gateway connection only, and agents reach Context7's two documentation
 * tools through the execution door under a mission token.
 *
 * The plugin imports `@vaubaan/plugin-sdk` only. `definePlugin` validates the
 * definition at import time ; the YAML catalog is loaded here, once, when the
 * module is first imported (that is, at gateway boot).
 */

import { catalogPathNextTo, definePlugin, loadCatalogFile } from '@vaubaan/plugin-sdk';

import { classifyContext7 } from './classify.ts';
import { CONTEXT7_MANUAL_REVOCATION, context7CredentialSpec } from './credential.ts';
import { context7DataModel } from './data-model.ts';
import { discoverContext7Resources, executeContext7 } from './execute.ts';
import { PROVIDER_ID } from './identity.ts';
import { context7ToolTitles, context7Tools } from './tools.ts';

// `catalogPathNextTo` keeps the path a filesystem path the bundler leaves
// alone (ADR plugin-catalog-path-and-standalone-tracing).
export const context7Catalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

export const context7Plugin = definePlugin({
  id: PROVIDER_ID,
  displayName: 'Context7',
  // Always equal to `version` in this plugin's package.json (a test checks it).
  version: '0.1.0',
  description:
    'Look up current library documentation with Context7, through the official Context7 MCP server.',
  summary:
    'One account is a Context7 API key of a teamspace. It has one resource, the library index the key can query: the public libraries its teamspace policies allow and its private sources. The documentation questions an agent asks are sent to Context7. There is no environment.',
  manualRevocation: CONTEXT7_MANUAL_REVOCATION,
  docsUrl: 'https://github.com/vaubaan/gateway/blob/main/docs/handbook/providers/context7.md',
  tools: context7Tools,
  toolTitles: context7ToolTitles,
  dataModel: context7DataModel,
  catalog: context7Catalog.catalog,
  credential: context7CredentialSpec,
  classify: classifyContext7,
  // No `envOf` : Context7 has no environment, and no risk is env-scoped.
  execute: executeContext7,
  discoverResources: discoverContext7Resources,
});

// The gateway registers a plugin through its default export
// (apps/gateway/src/server/compose/shipped-plugins.ts).
export default context7Plugin;

export { classifyContext7, context7DataModel, context7Tools };
export {
  MALFORMED_LIBRARY_ID,
  MAX_TEXT_LENGTH,
  NO_CONTEXT7_INDEX,
  NOT_A_CONTEXT7_INDEX,
  freeText,
  libraryId,
  malformedText,
  readCall,
  resolveIndex,
} from './classify.ts';
export { CONTEXT7_DASHBOARD, context7CredentialSpec, verifyContext7Key } from './credential.ts';
export {
  CONTEXT7_MCP_URL,
  INDEX_DISPLAY_NAME,
  discoverContext7Resources,
  executeContext7,
  firstJsonRpcFrame,
} from './execute.ts';
export { API_KEY_FIELD, INDEX_REF, PROVIDER_ID, TOOL, TOOL_PREFIX } from './identity.ts';
export { CONTEXT7_API_BASE, CONTEXT7_PLANS, CONTEXT7_USAGE_URL } from './usage.ts';
