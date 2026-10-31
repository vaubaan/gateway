/**
 * `@vaubaan/plugin-miro` — Miro boards, through Miro's official MCP server.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7.
 * ADR      : docs/decisions/oauth-client-registered-by-the-gateway.md.
 * Handbook : docs/handbook/providers/miro.md ; guide : plugins/miro/README.md.
 *
 * Credential : `oauth2` against Miro's MCP authorization server, with a
 * client the gateway registers itself. Discovery yields one resource per
 * board of the team the person chose at Miro. The YAML catalog is loaded
 * here, once, at import.
 */

import { catalogPathNextTo, definePlugin, loadCatalogFile } from '@vaubaan/plugin-sdk';

import { classifyMiro } from './classify.ts';
import { miroCredential } from './credential.ts';
import { miroDataModel } from './data-model.ts';
import { createdMiroResources } from './created.ts';
import { discoverMiroResources, executeMiro } from './execute.ts';
import { MIRO_ICON, MIRO_ICON_COLOR } from './icon.ts';
import { PROVIDER_ID, TOOL } from './identity.ts';
import { miroToolTitles } from './tool-titles.ts';
import { miroTools } from './tools.ts';

// `catalogPathNextTo` keeps the path a filesystem path the bundler leaves alone
// (docs/handbook/plugin-sdk.md).
export const miroCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

export const miroPlugin = definePlugin({
  id: PROVIDER_ID,
  displayName: 'Miro',
  icon: MIRO_ICON,
  iconColor: MIRO_ICON_COLOR,
  // Always equal to `version` in this plugin's package.json (a test checks it).
  version: '0.4.3',
  description:
    "Miro boards through Miro's own MCP server: read and draw on boards, tables, comments, prototypes — one resource per board.",
  summary:
    'One account is one Miro team: you sign in at Miro, choose the team and allow this gateway, with nothing to create or paste. One resource is one board of that team; a mission touches only the boards it was given. Miro boards have no environment: adding content, updating what is drawn (which may delete), deleting, creating a board and sharing one are separate permissions instead.',
  manualRevocation:
    "In Miro, open your profile settings, then the apps you allowed, and remove 'Vaubaan Gateway'; its tokens stop working.",
  docsUrl: 'https://github.com/vaubaan/gateway/blob/main/docs/handbook/providers/miro.md',
  tools: miroTools,
  toolTitles: miroToolTitles,
  dataModel: miroDataModel,
  catalog: miroCatalog.catalog,
  credential: miroCredential,
  classify: classifyMiro,
  execute: executeMiro,
  discoverResources: discoverMiroResources,
  // A new board is a new resource of the account (ADR created-resources-join-the-mission),
  // read from Miro's answer and reached by the mission that created it (ADR
  // created-resources-join-the-mission).
  resourceCreatingTools: [TOOL.boardCreate],
  createdResources: createdMiroResources,
});

// The gateway registers a plugin through its default export.
export default miroPlugin;

export { classifyMiro, miroDataModel, miroTools, miroToolTitles };
export {
  NO_MIRO_BOARD,
  readMiroCall,
  resolveBoard,
  undeclaredArgument,
  type MiroCall,
} from './call.ts';
export { slicesOf } from './classify.ts';
export { createdMiroResources } from './created.ts';
export { REQUIRED_SCOPES, miroCredential } from './credential.ts';
export {
  DISCOVERY_PAGE_SIZE,
  MAX_DISCOVERED_BOARDS,
  MCP_SERVER_REFUSED,
  boardsIn,
  discoverMiroResources,
  executeMiro,
  hasMore,
  toolDrift,
  toolResultOf,
  type ToolDrift,
} from './execute.ts';
export {
  BOARD_REF,
  MIRO_BOARD_ID,
  MIRO_COMMENT_ID,
  MIRO_ITEM_ID,
  boardIdOfUrl,
  boardOf,
  boardRef,
  boardRefOf,
  boardUrlOf,
  commentId,
  itemId,
  miroIdOf,
} from './identifiers.ts';
export {
  BOARD_ARGUMENT,
  BOARD_LOCATOR,
  ITEM_ARGUMENT,
  LEFT_OUT_UPSTREAM_TOOLS,
  LOCATOR,
  MIRO_MCP_URL,
  REQUIRED_BY_THE_GATEWAY,
  TELEMETRY_ARGUMENTS,
  WITHHELD_ARGUMENTS,
  locatorArgumentOf,
  MIRO_OAUTH,
  PROVIDER_ID,
  TOOL,
  UPSTREAM_TOOL,
} from './identity.ts';
export { MCP_PROTOCOL_VERSION, firstJsonRpcFrame, mcpRequest } from './mcp.ts';
export {
  UPSTREAM_TOOL_LIST,
  declarationsOf,
  isOfferedArgument,
  readUpstreamToolList,
  unmodelledLocators,
  upstreamToolOf,
} from './tools.ts';
