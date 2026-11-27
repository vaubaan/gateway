/**
 * The one reader of a `google-drive` call, shared by `classify` and
 * `execute`: what is sent is built from what it returned, never from `args`
 * (ADR plugin-identifiers-one-grammar-for-classify-and-execute).
 *
 * It refuses an argument the tool does not declare, a drive that is not one
 * of the mission's, and any value outside its grammar.
 */

import type { Resource } from '@vaubaan/plugin-sdk';

import { driveRefFromArgument, fileId, itemName, searchText, textMimeType } from './identifiers.ts';
import { DRIVE_ARGUMENT, ROOT_FOLDER, SERVICE_ID, TOOL } from './identity.ts';
import { MAX_PAGE_SIZE, MAX_UPLOAD_BYTES, googleDriveTools } from './tools.ts';

/** What a call asks, read once. */
export interface DriveCall {
  readonly tool: string;
  readonly drive: Resource;
  /** The folder listed, uploaded into, or created in (`root` by default). */
  readonly folder: string | null;
  /** The file read. */
  readonly file: string | null;
  readonly query: string | null;
  readonly name: string | null;
  readonly content: string | null;
  readonly mimeType: string | null;
  readonly pageSize: number | null;
  readonly pageToken: string | null;
}

export const NO_DRIVE = 'The mission holds no Google Drive.';

const DEFAULT_MIME_TYPE = 'text/plain';
// eslint-disable-next-line no-control-regex -- control characters are what this refuses
const CONTROL = /[\u0000-\u001f\u007f]/;

/** The drive a call targets: the one named, or the mission's only one. */
export function resolveDrive(
  value: unknown,
  resources: readonly Resource[],
): { readonly drive: Resource } | { readonly denied: string } {
  const drives = resources.filter((r) => r.service === SERVICE_ID);
  if (drives.length === 0) return { denied: NO_DRIVE };
  if (value === undefined) {
    return drives.length === 1
      ? { drive: drives[0]! }
      : {
          denied: `${DRIVE_ARGUMENT}: the mission holds ${drives.length} drives; name one (alice~acme.com).`,
        };
  }
  const ref = driveRefFromArgument(value);
  if (ref === null) {
    return { denied: `${DRIVE_ARGUMENT}: expected a drive ref (alice~acme.com) or an address.` };
  }
  const drive = drives.find((d) => d.ref === ref);
  return drive
    ? { drive }
    : { denied: `${DRIVE_ARGUMENT}: drive '${ref}' is not a drive of this mission.` };
}

export function readDriveCall(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): { readonly call: DriveCall } | { readonly denied: string } {
  const declaration = googleDriveTools.find((t) => t.name === tool);
  if (!declaration) return { denied: `unknown tool '${tool}'` };
  const properties = declaration.inputSchema.properties ?? {};
  for (const name of Object.keys(args)) {
    if (!(name in properties)) return { denied: `${name}: not an argument of '${tool}'.` };
  }
  for (const name of declaration.inputSchema.required ?? []) {
    if (args[name] === undefined) return { denied: `${name}: required by '${tool}'.` };
  }
  const resolved = resolveDrive(args[DRIVE_ARGUMENT], resources);
  if ('denied' in resolved) return resolved;

  const folderArg = tool === TOOL.createFolder ? 'parentId' : 'folderId';
  let folder: string | null = null;
  if (tool === TOOL.listFolder || tool === TOOL.uploadFile || tool === TOOL.createFolder) {
    const raw = args[folderArg];
    folder = raw === undefined ? ROOT_FOLDER : fileId(raw);
    if (folder === null) return { denied: `${folderArg}: expected a folder id or 'root'.` };
  }
  let file: string | null = null;
  if (tool === TOOL.readFile) {
    file = fileId(args.fileId);
    if (file === null) return { denied: 'fileId: expected a Drive file id.' };
  }
  let query: string | null = null;
  if (tool === TOOL.searchFiles) {
    query = searchText(args.query);
    if (query === null) return { denied: 'query: 1 to 200 characters, no control character.' };
  }
  let name: string | null = null;
  if (tool === TOOL.uploadFile || tool === TOOL.createFolder) {
    name = itemName(args.name);
    if (name === null) return { denied: 'name: 1 to 255 characters, no control character.' };
  }
  let content: string | null = null;
  let mimeType: string | null = null;
  if (tool === TOOL.uploadFile) {
    if (typeof args.content !== 'string') return { denied: 'content: expected text.' };
    if (new TextEncoder().encode(args.content).byteLength > MAX_UPLOAD_BYTES) {
      return { denied: `content: larger than ${MAX_UPLOAD_BYTES} bytes.` };
    }
    content = args.content;
    mimeType = args.mimeType === undefined ? DEFAULT_MIME_TYPE : textMimeType(args.mimeType);
    if (mimeType === null) {
      return { denied: 'mimeType: a text type (text/plain, text/markdown, application/json…).' };
    }
  }
  let pageSize: number | null = null;
  if (args.pageSize !== undefined) {
    const n = args.pageSize;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_PAGE_SIZE) {
      return { denied: `pageSize: an integer from 1 to ${MAX_PAGE_SIZE}.` };
    }
    pageSize = n;
  }
  let pageToken: string | null = null;
  if (args.pageToken !== undefined) {
    const t = args.pageToken;
    if (typeof t !== 'string' || t === '' || t.length > 2048 || CONTROL.test(t)) {
      return { denied: 'pageToken: the nextPageToken of the previous page.' };
    }
    pageToken = t;
  }
  return {
    call: {
      tool,
      drive: resolved.drive,
      folder,
      file,
      query,
      name,
      content,
      mimeType,
      pageSize,
      pageToken,
    },
  };
}
