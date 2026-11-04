/**
 * `@vaubaan/plugin-fly` — Fly.io apps, machines, volumes, secrets, addresses
 * and certificates through the Machines API.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7.
 * ADR  : docs/decisions/plugin-contract-and-credential-spec.md.
 * Handbook : docs/handbook/providers/fly.md ; guide : plugins/fly/README.md.
 */

import { catalogPathNextTo, definePlugin, loadCatalogFile } from '@vaubaan/plugin-sdk';

import { classifyFly } from './classify.ts';
import { flyDataModel } from './data-model.ts';
import { createdFlyResources } from './created.ts';
import { discoverFlyResources, executeFly } from './execute.ts';
import { FLY_ICON, FLY_ICON_COLOR } from './icon.ts';
import { PROVIDER_ID, TOOL } from './identity.ts';
import { flyCredential } from './token.ts';
import { flyToolTitles, flyTools } from './tools.ts';

// The YAML sits next to this module ; `catalogPathNextTo` keeps the path a
// filesystem path the bundler leaves alone (docs/handbook/plugin-sdk.md).
export const flyCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

export const flyPlugin = definePlugin({
  id: PROVIDER_ID,
  displayName: 'Fly.io',
  icon: FLY_ICON,
  iconColor: FLY_ICON_COLOR,
  resourceNoun: { one: 'app', other: 'apps' },
  version: '0.4.0',
  description:
    'Apps on Fly.io: machines, images, volumes and snapshots, secrets, IP addresses and ' +
    'certificates — one resource per app.',
  summary:
    'One account is one Fly organization token; one resource is one app of that organization. The owner labels each app staging or prod, and writes are held per label. Machines only run images pinned by digest under the allowed prefixes of the account, secret values are never read back, and running a command inside a machine is its own permission.',
  manualRevocation:
    'Revoke the token in the Fly dashboard (organization, Tokens) or with fly tokens revoke <id>.',
  docsUrl: 'https://github.com/vaubaan/gateway/blob/main/docs/handbook/providers/fly.md',
  tools: flyTools,
  toolTitles: flyToolTitles,
  secretArguments: { [TOOL.setSecrets]: ['values'] },
  // An app is what a Fly connection lists : a created app is discovered at once
  // (ADR created-resources-join-the-mission).
  resourceCreatingTools: [TOOL.createApp],
  // Read from the call's answer: the mission that created it reaches it at once
  // (ADR created-resources-join-the-mission).
  createdResources: createdFlyResources,
  dataModel: flyDataModel,
  catalog: flyCatalog.catalog,
  credential: flyCredential,
  classify: classifyFly,
  // The environment of a call is the owner's label on the app : no `envOf`.
  execute: executeFly,
  discoverResources: discoverFlyResources,
});

export default flyPlugin;

export { classifyFly, flyDataModel, flyTools };
export { readFlyCall, resolveApp } from './call.ts';
export { createdFlyResources } from './created.ts';
export {
  EXEC_OUTPUT_MAX,
  MAX_DISCOVERED_APPS,
  REDACTED,
  SNAPSHOT_FRESH_MINUTES,
  discoverFlyResources,
  executeFly,
} from './execute.ts';
export { imageRefusal } from './identifiers.ts';
export {
  API_TOKEN_FIELD,
  DEFAULT_IMAGE_PREFIXES,
  IMAGE_PREFIXES_FIELD,
  ORG_SLUG_FIELD,
  PROVIDER_ID,
  TOOL,
} from './identity.ts';
export { FLY_API_BASE, FLY_LOGS_BASE, verifyFlyToken } from './token.ts';
