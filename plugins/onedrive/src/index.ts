/**
 * `@vaubaan/plugin-onedrive` — OneDrive, personal or for work or school,
 * through Microsoft Graph v1.0, with an access token the instance obtains at
 * Microsoft.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7.
 * ADR      : docs/decisions/local-instance-carries-installed-oauth-clients.md.
 * Handbook : docs/handbook/services/onedrive.md ; guide : plugins/onedrive/README.md.
 *
 * Credential : `oauth2` whose client is the instance's source for
 * `microsoft` (`broker: { provider: 'microsoft' }`). Discovery yields one
 * resource per account: its drive. The YAML catalog is loaded here, once.
 */

import { catalogPathNextTo, definePlugin, loadCatalogFile } from '@vaubaan/plugin-sdk';

import { classifyOneDrive } from './classify.ts';
import { oneDriveCredential } from './credential.ts';
import { oneDriveDataModel } from './data-model.ts';
import { oneDriveExamples } from './examples.ts';
import { discoverOneDriveResources, executeOneDrive } from './execute.ts';
import { ONEDRIVE_ICON, ONEDRIVE_ICON_COLOR } from './icon.ts';
import { EXCLUDED_TOOLS, SERVICE_ID } from './identity.ts';
import { oneDriveToolTitles, oneDriveTools } from './tools.ts';

// `catalogPathNextTo` keeps the path a filesystem path the bundler leaves alone
// (docs/handbook/plugin-sdk.md).
export const oneDriveCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

export const oneDrivePlugin = definePlugin({
  id: SERVICE_ID,
  displayName: 'OneDrive',
  icon: ONEDRIVE_ICON,
  iconColor: ONEDRIVE_ICON_COLOR,
  resourceNoun: { one: 'drive', other: 'drives' },
  // Always equal to `version` in this plugin's package.json (a test checks it).
  version: '0.1.0',
  description:
    'OneDrive through Microsoft Graph: list folders, search and read text files, upload new files and create folders. No sharing, no deletion.',
  summary:
    "One account is one Microsoft account, personal or for work or school, signed in at Microsoft with nothing to create or paste; one resource is its OneDrive. A mission reads what files are called and what they hold as two permissions, and creating folders and uploading files as two more; nothing is shared or deleted. An organisation's policy may ask an administrator to consent to the app first.",
  manualRevocation:
    'At account.microsoft.com (personal) or myapps.microsoft.com (work or school), open the apps you gave access to and remove the app this gateway signed you in with.',
  docsUrl: 'https://github.com/vaubaan/gateway/blob/main/docs/handbook/services/onedrive.md',
  tools: oneDriveTools,
  toolTitles: oneDriveToolTitles,
  excludedTools: EXCLUDED_TOOLS,
  examples: oneDriveExamples,
  dataModel: oneDriveDataModel,
  catalog: oneDriveCatalog.catalog,
  credential: oneDriveCredential,
  classify: classifyOneDrive,
  execute: executeOneDrive,
  discoverResources: discoverOneDriveResources,
});

// The gateway registers a plugin through its default export.
export default oneDrivePlugin;

export { classifyOneDrive, oneDriveDataModel, oneDriveTools, oneDriveToolTitles };
export { NO_DRIVE, readDriveCall, resolveDrive, type DriveCall } from './call.ts';
export {
  REQUESTED_SCOPES,
  REQUIRED_PERMISSIONS,
  missingScopes,
  oneDriveCredential,
} from './credential.ts';
export { EXAMPLE_DRIVE, EXAMPLE_OTHER_DRIVE, oneDriveExamples } from './examples.ts';
export {
  ITEM_FIELDS,
  NO_ADDRESS,
  PROFILE_REFUSED,
  discoverOneDriveResources,
  executeOneDrive,
} from './execute.ts';
export {
  accountAddress,
  downloadUrl,
  driveRefFromArgument,
  driveRefOf,
  itemId,
  itemName,
  odataString,
  pathSegment,
  textMimeType,
} from './identifiers.ts';
export { BROKER_PROVIDER, GRAPH_API_BASE, SCOPES, SERVICE_ID, TOOL } from './identity.ts';
export { MAX_PAGE_SIZE, MAX_READ_BYTES, MAX_UPLOAD_BYTES } from './tools.ts';
