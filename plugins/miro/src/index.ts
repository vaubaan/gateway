/**
 * `@vaubaan/plugin-miro` — Miro boards : items, frames, connectors and tags.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7.
 * ADR      : docs/decisions/plugin-contract-and-credential-spec.md ;
 *            docs/decisions/miro-board-ref-tilde-spelling.md.
 * Handbook : docs/handbook/providers/miro.md ; guide : plugins/miro/README.md.
 *
 * Credential : `api-key`, the non-expiring access token of a Miro app.
 * Discovery yields one resource per board of the team the app was installed
 * on. The YAML catalog is loaded here, once, at import.
 */

import { catalogPathNextTo, definePlugin, loadCatalogFile } from '@vaubaan/plugin-sdk';

import { classifyMiro } from './classify.ts';
import { miroCredential } from './credential.ts';
import { miroDataModel } from './data-model.ts';
import { discoverMiroResources, executeMiro } from './execute.ts';
import { PROVIDER_ID } from './identity.ts';
import { miroToolTitles } from './tool-titles.ts';
import { miroTools } from './tools.ts';

// `catalogPathNextTo` keeps the path a filesystem path the bundler leaves alone
// (ADR plugin-catalog-path-and-standalone-tracing).
export const miroCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

export const miroPlugin = definePlugin({
  id: PROVIDER_ID,
  displayName: 'Miro',
  // Always equal to `version` in this plugin's package.json (a test checks it).
  version: '0.1.0',
  description:
    'Miro boards: sticky notes, shapes, texts, cards, frames, connectors and tags — one resource per board.',
  summary:
    'One account is the access token of a Miro app installed on one team; one resource is one board of that team. A mission touches only the boards it was given. Miro boards have no environment: adding and editing, adding many items at once, deleting an item and deleting a frame are separate permissions instead.',
  manualRevocation: miroCredential.manualRevocation,
  docsUrl: 'https://github.com/vaubaan/gateway/blob/main/docs/handbook/providers/miro.md',
  tools: miroTools,
  toolTitles: miroToolTitles,
  dataModel: miroDataModel,
  catalog: miroCatalog.catalog,
  credential: miroCredential,
  classify: classifyMiro,
  execute: executeMiro,
  discoverResources: discoverMiroResources,
});

// The gateway registers a plugin through its default export.
export default miroPlugin;

export { classifyMiro, miroDataModel, miroTools, miroToolTitles };
export {
  MAX_LISTED_BOARDS,
  readMiroCall,
  resolveBoard,
  undeclaredArgument,
  type MiroCall,
} from './call.ts';
export { slicesOf } from './classify.ts';
export { MIRO_APPS_PAGE, REQUIRED_SCOPES, miroCredential, verifyMiroToken } from './credential.ts';
export {
  MAX_DISCOVERED_BOARDS,
  MIRO_API_BASE,
  MIRO_TOKEN_CONTEXT_URL,
  discoverMiroResources,
  executeMiro,
  readTokenContext,
} from './execute.ts';
export {
  BOARD_REF,
  MIRO_BOARD_ID,
  MIRO_CURSOR,
  MIRO_ITEM_ID,
  boardRef,
  boardRefOf,
  cursorOf,
  itemId,
  miroIdOf,
} from './identifiers.ts';
export { ACCESS_TOKEN_FIELD, PROVIDER_ID, TOOL } from './identity.ts';
