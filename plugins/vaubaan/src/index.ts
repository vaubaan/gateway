/**
 * `@vaubaan/plugin-vaubaan` — the gateway's own management tools, as a service.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §4.1 bis ; docs/spec/gateway-risk-model.md §7.
 * ADR      : docs/decisions/platform-management-is-a-plugin-on-the-execution-door.md.
 * Handbook : docs/handbook/services/vaubaan.md ; guide : plugins/README.md.
 *
 * An agent prepares missions the way it does everything else: a person connects
 * "Vaubaan" (one click, a `host` account with no secret), issues a mission on it,
 * and the agent calls the `vaubaan__*` tools on `/mcp` with that mission's key.
 * The risk catalog, the macro-actions and the Reference page are a service's like
 * any other.
 *
 * The plugin's declared `execute` refuses every call: the host composes the
 * real one from its own services with `createVaubaanExecute(ports)` and a plugin
 * declaring a `host` account is never loaded from a pin (bundled only).
 */

import { catalogPathNextTo, definePlugin, loadCatalogFile } from '@vaubaan/plugin-sdk';

import { classifyVaubaan } from './classify.ts';
import { vaubaanDataModel } from './data-model.ts';
import { vaubaanExamples } from './examples.ts';
import { discoverVaubaanResources, executeOutsideTheHost } from './execute.ts';
import { VAUBAAN_ICON, VAUBAAN_ICON_COLOR } from './icon.ts';
import { SERVICE_ID } from './identity.ts';
import { vaubaanToolTitles, vaubaanTools } from './tools.ts';

// `catalogPathNextTo` keeps the path a filesystem path the bundler leaves
// alone (docs/handbook/plugin-sdk.md).
export const vaubaanCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

export const vaubaanPlugin = definePlugin({
  id: SERVICE_ID,
  displayName: 'Vaubaan',
  icon: VAUBAAN_ICON,
  iconColor: VAUBAAN_ICON_COLOR,
  // Always equal to `version` in this plugin's package.json (a test checks it).
  version: '0.5.0',
  description:
    'Let an agent prepare missions for other agents: read your accounts and the catalogs, preview, issue, rename, change, rotate and revoke missions in your name.',
  summary:
    'One account is your own place on this gateway: it holds no secret, belongs to you and is never shared. It has no resource: a mission on it reaches your accounts, the catalogs and your missions, always within your authority. A mission prepared or changed here never carries a Vaubaan account, and a mission never renames, changes, rotates or revokes itself. There is no environment.',
  manualRevocation:
    'Nothing to remove anywhere else: disconnecting the Vaubaan account in Accounts stops every mission on it.',
  docsUrl: 'https://github.com/vaubaan/gateway/blob/main/docs/handbook/services/vaubaan.md',
  // The account lists none; the word is what a mission reaches on it.
  resourceNoun: { one: 'account', other: 'accounts' },
  tools: vaubaanTools,
  toolTitles: vaubaanToolTitles,
  examples: vaubaanExamples,
  dataModel: vaubaanDataModel,
  catalog: vaubaanCatalog.catalog,
  // A host account: one button, no secret, created by the host alone.
  credential: { kind: 'host' },
  classify: classifyVaubaan,
  execute: executeOutsideTheHost,
  discoverResources: discoverVaubaanResources,
});

// The gateway registers a plugin through its default export
// (apps/gateway/src/server/compose/shipped-plugins.ts).
export default vaubaanPlugin;

export {
  classifyVaubaan,
  MALFORMED_MISSION_ID,
  MALFORMED_SERVICE,
  MAX_ID_LENGTH,
} from './classify.ts';
export { vaubaanDataModel } from './data-model.ts';
export { EXAMPLE_DRAFT, EXAMPLE_MISSION_ID, vaubaanExamples } from './examples.ts';
export {
  createVaubaanExecute,
  discoverVaubaanResources,
  executeOutsideTheHost,
  HostOnlyPluginError,
  INTERNAL_ERROR_RESULT,
  toolResultOf,
} from './execute.ts';
export { ACT, actOf, SERVICE_ID, TOOL, TOOL_PREFIX, type VaubaanActName } from './identity.ts';
export {
  VAUBAAN_PORT_NAMES,
  type VaubaanAct,
  type VaubaanAnswer,
  type VaubaanCaller,
  type VaubaanExecuteContext,
  type VaubaanHostExecute,
  type VaubaanPorts,
  type VaubaanRefusal,
} from './ports.ts';
export { vaubaanToolTitles, vaubaanTools } from './tools.ts';
