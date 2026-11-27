/**
 * `@vaubaan/plugin-google-drive` — Google Drive, through Google's public
 * Drive REST API v3, with an access token the instance obtains at Google.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7.
 * ADR      : docs/decisions/local-instance-carries-installed-oauth-clients.md.
 * Handbook : docs/handbook/services/google-drive.md ; guide : plugins/google-drive/README.md.
 *
 * Credential : `oauth2` whose client is the instance's source for `google`
 * (`broker: { provider: 'google' }`). Discovery yields one resource per
 * account: its drive. The YAML catalog is loaded here, once, at import.
 */

import { catalogPathNextTo, definePlugin, loadCatalogFile } from '@vaubaan/plugin-sdk';

import { classifyGoogleDrive } from './classify.ts';
import { googleDriveCredential } from './credential.ts';
import { googleDriveDataModel } from './data-model.ts';
import { googleDriveExamples } from './examples.ts';
import { discoverGoogleDriveResources, executeGoogleDrive } from './execute.ts';
import { GOOGLE_DRIVE_ICON, GOOGLE_DRIVE_ICON_COLOR } from './icon.ts';
import { EXCLUDED_TOOLS, SERVICE_ID } from './identity.ts';
import { googleDriveToolTitles, googleDriveTools } from './tools.ts';

// `catalogPathNextTo` keeps the path a filesystem path the bundler leaves alone
// (docs/handbook/plugin-sdk.md).
export const googleDriveCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

export const googleDrivePlugin = definePlugin({
  id: SERVICE_ID,
  displayName: 'Google Drive',
  icon: GOOGLE_DRIVE_ICON,
  iconColor: GOOGLE_DRIVE_ICON_COLOR,
  resourceNoun: { one: 'drive', other: 'drives' },
  // Always equal to `version` in this plugin's package.json (a test checks it).
  version: '0.1.0',
  description:
    "Google Drive through Google's Drive API: list folders, search and read files (Docs, Sheets and Slides as text), upload new files and create folders. No sharing, no deletion.",
  summary:
    "One account is one Google account, signed in at Google with nothing to create or paste; one resource is its drive: everything the account can open. A mission reads what files are called and what they hold as two permissions, and creating folders and uploading files as two more; nothing is shared or deleted. Until Google reviews Vaubaan's access to Drive, Google's consent screen warns that the app is unverified.",
  manualRevocation:
    "In your Google account, open Security, then 'Third-party apps with account access', and remove the app this gateway signed you in with.",
  docsUrl: 'https://github.com/vaubaan/gateway/blob/main/docs/handbook/services/google-drive.md',
  tools: googleDriveTools,
  toolTitles: googleDriveToolTitles,
  excludedTools: EXCLUDED_TOOLS,
  examples: googleDriveExamples,
  dataModel: googleDriveDataModel,
  catalog: googleDriveCatalog.catalog,
  credential: googleDriveCredential,
  classify: classifyGoogleDrive,
  execute: executeGoogleDrive,
  discoverResources: discoverGoogleDriveResources,
});

// The gateway registers a plugin through its default export.
export default googleDrivePlugin;

export { classifyGoogleDrive, googleDriveDataModel, googleDriveTools, googleDriveToolTitles };
export { NO_DRIVE, readDriveCall, resolveDrive, type DriveCall } from './call.ts';
export { REQUIRED_SCOPES, googleDriveCredential, missingScopes } from './credential.ts';
export { EXAMPLE_DRIVE, EXAMPLE_OTHER_DRIVE, googleDriveExamples } from './examples.ts';
export {
  FILE_FIELDS,
  discoverGoogleDriveResources,
  executeGoogleDrive,
  multipartBody,
  queryLiteral,
} from './execute.ts';
export {
  accountAddress,
  driveRefFromArgument,
  driveRefOf,
  fileId,
  itemName,
  pathSegment,
  textMimeType,
} from './identifiers.ts';
export {
  BROKER_PROVIDER,
  DRIVE_API_BASE,
  DRIVE_UPLOAD_BASE,
  SCOPES,
  SERVICE_ID,
  TOOL,
} from './identity.ts';
export { MAX_PAGE_SIZE, MAX_READ_BYTES, MAX_UPLOAD_BYTES } from './tools.ts';
