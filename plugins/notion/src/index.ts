/**
 * `@vaubaan/plugin-notion` — the Notion provider plugin.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7.
 * ADR      : docs/decisions/plugin-contract-and-credential-spec.md.
 * Handbook : docs/handbook/providers/notion.md ; guide : plugins/README.md.
 *
 * The plugin imports `@vaubaan/plugin-sdk` only. The YAML catalog is loaded
 * here, once, when the module is first imported (at gateway boot).
 */

import { catalogPathNextTo, definePlugin, loadCatalogFile } from '@vaubaan/plugin-sdk';

import { classifyNotion } from './classify.ts';
import { notionCredential } from './credential.ts';
import { notionDataModel } from './data-model.ts';
import { discoverNotionResources } from './discovery.ts';
import { executeNotion } from './execute.ts';
import { NOTION_ICON, NOTION_ICON_COLOR } from './icon.ts';
import { PROVIDER_ID } from './identity.ts';
import { notionToolTitles, notionTools } from './tools.ts';

// A filesystem path next to this module (docs/handbook/plugin-sdk.md).
export const notionCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

export const notionPlugin = definePlugin({
  id: PROVIDER_ID,
  displayName: 'Notion',
  icon: NOTION_ICON,
  iconColor: NOTION_ICON_COLOR,
  // Always equal to `version` in this plugin's package.json (a test checks it).
  version: '0.2.0',
  description:
    'Read and edit the pages, page content, databases and comments of the Notion pages shared with an internal connection.',
  summary:
    'One account is one internal connection of a Notion workspace, connected with its token. One resource is one top-level page or database shared with that connection, with everything under it. Notion has no environments: moving a page to the trash and deleting a block are permissions of their own. Writes are sent silently, so Notion notifies nobody.',
  manualRevocation:
    "In Notion's Developer portal, open the connection and refresh its token on the Configuration tab, or remove the connection from the shared pages (••• menu, Connections).",
  docsUrl: 'https://github.com/vaubaan/gateway/blob/main/docs/handbook/providers/notion.md',
  tools: notionTools,
  toolTitles: notionToolTitles,
  dataModel: notionDataModel,
  catalog: notionCatalog.catalog,
  credential: notionCredential,
  classify: classifyNotion,
  // No environment : no `envOf` hook, no env-scoped risk.
  execute: executeNotion,
  discoverResources: discoverNotionResources,
});

export default notionPlugin;

export { classifyNotion, discoverNotionResources, executeNotion, notionDataModel, notionTools };
export { readCall, slicesOf, undeclaredArgument } from './classify.ts';
export { NOTION_API_BASE, NOTION_VERSION } from './api.ts';
export { MAX_ANCESTRY_DEPTH } from './ancestry.ts';
export { NOTION_CONNECTIONS_PAGE, verifyNotionToken } from './credential.ts';
export { MAX_DISCOVERED_ROOTS, MAX_SEARCH_PAGES } from './discovery.ts';
export {
  MAX_BLOCKS_PER_CALL,
  MAX_CHILD_REQUESTS,
  MAX_REPLY_LOOKUP_PAGES,
  MAX_SEARCH_VERIFY_REQUESTS,
} from './execute.ts';
export { notionId } from './ids.ts';
export { API_TOKEN_FIELD, PROVIDER_ID, TOOL } from './identity.ts';
