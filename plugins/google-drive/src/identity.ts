/**
 * Identity of the `google-drive` service — the one place its ids and Google's
 * own names are written.
 *
 * Handbook : docs/handbook/services/google-drive.md.
 * ADR      : docs/decisions/local-instance-carries-installed-oauth-clients.md.
 *
 * `SERVICE_ID` is also written as `service:` and as the prefix of every id in
 * `risk-catalog.yaml`, and in the package name. The tool prefix is the SDK's
 * rule (`toolPrefixFor`): `google_drive__`.
 */

import { toolPrefixFor } from '@vaubaan/plugin-sdk';

export const SERVICE_ID = 'google-drive';

/** `google_drive__` : prepended to the bare tool names. */
export const TOOL_PREFIX = toolPrefixFor(SERVICE_ID);

/**
 * Google's Drive REST API v3 ("Drive API reference", developers.google.com,
 * read 2026-11-27): metadata and downloads under the first base, the bodies
 * of new files under the second. A Google access token authenticates as a
 * Bearer.
 */
export const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

/** The OAuth provider whose client the access token is issued to. */
export const BROKER_PROVIDER = 'google';

/**
 * The one scope asked. `drive` is "restricted" at Google: until Vaubaan's
 * client passes Google's review, the consent screen warns of an unverified
 * app and at most 100 people may grant it. `drive.file` would see only the
 * files this app created or a picker opened, which an agent cannot use.
 */
export const SCOPES = {
  drive: 'https://www.googleapis.com/auth/drive',
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

/** Tools of Drive this plugin does not offer, one sentence each (its public page shows them). */
export const EXCLUDED_TOOLS: Readonly<Record<string, string>> = {
  [toolNameOf('share_file')]:
    'Sharing gives people outside the mission a file at once and for as long as nobody revokes it; a person shares by hand.',
  [toolNameOf('delete_file')]:
    'No deletion is offered, not even a move to the trash: what an agent writes stays until a person removes it.',
  [toolNameOf('update_permissions')]:
    "Changing who may open a file is the person's decision, never an agent's.",
};

/** The argument that names the drive (a ref of the mission; the only one when omitted). */
export const DRIVE_ARGUMENT = 'drive';
/** Drive's alias of the account's own top folder. */
export const ROOT_FOLDER = 'root';
/** Drive's type of a folder. */
export const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

/**
 * How a Google document is read as text (`files.export`): Docs as Markdown,
 * Sheets as CSV (the first sheet), Slides as plain text. Other Google types
 * (forms, drawings, sites) are not read.
 */
export const EXPORT_AS: Readonly<Record<string, string>> = {
  'application/vnd.google-apps.document': 'text/markdown',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};
