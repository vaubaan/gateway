/**
 * Identity of the `onedrive` service — the one place its ids and Microsoft
 * Graph's own names are written.
 *
 * Handbook : docs/handbook/services/onedrive.md.
 * ADR      : docs/decisions/local-instance-carries-installed-oauth-clients.md.
 *
 * `SERVICE_ID` is also written as `service:` and as the prefix of every id in
 * `risk-catalog.yaml`, and in the package name. The tool prefix is the SDK's
 * rule (`toolPrefixFor`): `onedrive__`.
 */

import { toolPrefixFor } from '@vaubaan/plugin-sdk';

export const SERVICE_ID = 'onedrive';

/** `onedrive__` : prepended to the bare tool names. */
export const TOOL_PREFIX = toolPrefixFor(SERVICE_ID);

/**
 * Microsoft Graph v1.0 ("Working with files in Microsoft Graph", read
 * 2026-11-27): the signed-in person's drive is `/me/drive`. A Microsoft access
 * token authenticates as a Bearer.
 */
export const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';

/** The OAuth provider whose client the access token is issued to. */
export const BROKER_PROVIDER = 'microsoft';

/**
 * The scopes asked. `offline_access` makes Microsoft issue a refresh token;
 * `openid`, `email` and `profile` let the ID token name the account;
 * `User.Read` names the drive's owner; `Files.ReadWrite` is the person's own
 * files, delegated, no administrator's consent needed.
 */
export const SCOPES = {
  openid: 'openid',
  email: 'email',
  profile: 'profile',
  offlineAccess: 'offline_access',
  userRead: 'User.Read',
  filesReadWrite: 'Files.ReadWrite',
} as const;

/** The tool names without the prefix (5 tools). */
export const BARE_TOOL = {
  listFolder: 'list_folder',
  searchFiles: 'search_files',
  readFile: 'read_file',
  uploadFile: 'upload_file',
  createFolder: 'create_folder',
} as const;

/** The gateway's name of a bare tool name. */
export function toolNameOf(bare: string): string {
  return `${TOOL_PREFIX}${bare}`;
}

/** The MCP tool names of the plugin, in the order `tools/list` gives them. */
export const TOOL = {
  listFolder: toolNameOf(BARE_TOOL.listFolder),
  searchFiles: toolNameOf(BARE_TOOL.searchFiles),
  readFile: toolNameOf(BARE_TOOL.readFile),
  uploadFile: toolNameOf(BARE_TOOL.uploadFile),
  createFolder: toolNameOf(BARE_TOOL.createFolder),
} as const;

/** Tools of OneDrive this plugin does not offer, one sentence each (its public page shows them). */
export const EXCLUDED_TOOLS: Readonly<Record<string, string>> = {
  [toolNameOf('share_file')]:
    'Sharing, a link included, gives people outside the mission a file at once and for as long as nobody revokes it; a person shares by hand.',
  [toolNameOf('delete_file')]:
    'No deletion is offered, not even a move to the recycle bin: what an agent writes stays until a person removes it.',
  [toolNameOf('update_permissions')]:
    "Changing who may open a file is the person's decision, never an agent's.",
};

/** The argument that names the drive (a ref of the mission; the only one when omitted). */
export const DRIVE_ARGUMENT = 'drive';
/** Graph's alias of the drive's top folder. */
export const ROOT_FOLDER = 'root';

/**
 * The hosts a file's pre-authenticated download address may name: OneDrive
 * for work or school (SharePoint) and personal OneDrive. The address carries
 * its own short-lived token; the access token is never sent there.
 */
export const DOWNLOAD_HOST_SUFFIXES = [
  '.sharepoint.com',
  '.1drv.com',
  '.onedrive.com',
  '.livefilestore.com',
  '.microsoftpersonalcontent.com',
  '.svc.ms',
] as const;
