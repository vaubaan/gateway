/**
 * Upstream calls of the `google-drive` service, and resource discovery.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §2.4 — the credential arrives
 *            decrypted in the context, is used for one call, and is never
 *            returned.
 * Handbook : docs/handbook/services/google-drive.md.
 *
 * Rules:
 *   - the call is read by `readDriveCall`, the classifier's own reader: what
 *     is sent is built from what it returned, never from `args`;
 *   - JSON answers go through the SDK's `httpJson`; a file read as text goes
 *     through `readBoundedText` after `upstreamFailure` for a failed status,
 *     so the bound and the 401 / 403 rule are the transport's;
 *   - a token Google issued without the `drive` scope is refused before any
 *     request.
 */

import {
  CredentialRefusal,
  ExecutorRefusal,
  UpstreamAnswerTooLarge,
  UpstreamProtocolError,
  anyJson,
  declining,
  expectCredentialKind,
  httpJson,
  isRecord,
  jsonResult,
  queryString,
  readBoundedText,
  upstreamFailure,
  type AccountContext,
  type ExecuteContext,
  type Guard,
  type McpToolResult,
  type RawRequestBody,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { readDriveCall, type DriveCall } from './call.ts';
import { SCOPES_NOT_GRANTED, missingScopes } from './credential.ts';
import { accountAddress, driveRefOf, isTextType, pathSegment } from './identifiers.ts';
import {
  DRIVE_API_BASE,
  DRIVE_UPLOAD_BASE,
  EXPORT_AS,
  FOLDER_MIME_TYPE,
  SERVICE_ID,
  TOOL,
} from './identity.ts';
import { MAX_READ_BYTES } from './tools.ts';

/** The fields of a file Drive answers for a listing, a search or a read. */
export const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,webViewLink';
const LIST_FIELDS = `nextPageToken,files(${FILE_FIELDS})`;
const DEFAULT_PAGE_SIZE = 50;

/** Shared drives are listed with My Drive: the account sees what it can open. */
const ALL_DRIVES = { supportsAllDrives: true, includeItemsFromAllDrives: true } as const;

type Query = Readonly<Record<string, string | number | boolean | undefined>>;

function tokenOf(ctx: AccountContext): string {
  return expectCredentialKind(SERVICE_ID, ctx.credential, 'oauth2').accessToken;
}

function expectRequiredScopes(ctx: AccountContext): void {
  const { scopes } = expectCredentialKind(SERVICE_ID, ctx.credential, 'oauth2');
  if (missingScopes(scopes).length > 0) throw new CredentialRefusal(SCOPES_NOT_GRANTED, 403);
}

/** One JSON request to Drive. */
async function drive<T>(
  ctx: AccountContext,
  method: 'GET' | 'POST',
  url: string,
  guard: Guard<T>,
  body?: { readonly json: unknown } | { readonly raw: RawRequestBody; readonly type: string },
): Promise<T> {
  const what = `Google Drive ${method} ${new URL(url).pathname}`;
  const authorization = `Bearer ${tokenOf(ctx)}`;
  if (body && 'raw' in body) {
    return httpJson(
      ctx,
      {
        url,
        method,
        headers: { authorization, 'content-type': body.type },
        what,
        rawBody: body.raw,
      },
      guard,
    );
  }
  return httpJson(
    ctx,
    {
      url,
      method,
      headers: { authorization },
      what,
      ...(body ? { body: body.json } : {}),
    },
    guard,
  );
}

/** A file's bytes read as text, bounded: a failed status is the transport's failure. */
async function driveText(ctx: AccountContext, url: string): Promise<string> {
  const what = `Google Drive GET ${new URL(url).pathname}`;
  const res = await ctx.fetch(url, {
    method: 'GET',
    redirect: 'error',
    headers: { authorization: `Bearer ${tokenOf(ctx)}` },
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (!res.ok) throw await upstreamFailure(res, what);
  try {
    return await readBoundedText(res, MAX_READ_BYTES, what);
  } catch (err) {
    if (err instanceof UpstreamAnswerTooLarge) {
      throw new ExecutorRefusal(`The file is larger than ${MAX_READ_BYTES} bytes as text.`);
    }
    throw err;
  }
}

/** The request URL of a file, its id a path segment its grammar already accepted. */
function fileUrl(id: string, suffix = ''): string {
  const segment = pathSegment(id);
  if (segment === null) throw new ExecutorRefusal('fileId: not a path segment.');
  return `${DRIVE_API_BASE}/files/${segment}${suffix}`;
}

/** Drive's query literal: the text between single quotes, `\` and `'` escaped. */
export function queryLiteral(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

interface FileMeta {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size?: string;
}

const isFileMeta: Guard<FileMeta> = (x): x is FileMeta =>
  isRecord(x) &&
  typeof x.id === 'string' &&
  typeof x.name === 'string' &&
  typeof x.mimeType === 'string' &&
  (x.size === undefined || typeof x.size === 'string');

function pageQuery(call: DriveCall): Query {
  return {
    fields: LIST_FIELDS,
    pageSize: call.pageSize ?? DEFAULT_PAGE_SIZE,
    pageToken: call.pageToken ?? undefined,
    ...ALL_DRIVES,
  };
}

/** A multipart/related body: the file's metadata, then its text. */
export function multipartBody(
  metadata: unknown,
  content: string,
  mimeType: string,
): { readonly body: string; readonly boundary: string } {
  let boundary = `vaubaan-${globalThis.crypto.randomUUID()}`;
  while (content.includes(boundary)) boundary = `vaubaan-${globalThis.crypto.randomUUID()}`;
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${mimeType}; charset=UTF-8`,
    '',
    content,
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return { body, boundary };
}

async function run(ctx: ExecuteContext, call: DriveCall): Promise<McpToolResult> {
  switch (call.tool) {
    case TOOL.listFolder: {
      const q = `${queryLiteral(call.folder!)} in parents and trashed = false`;
      const url = `${DRIVE_API_BASE}/files${queryString({ q, orderBy: 'folder,name', ...pageQuery(call) })}`;
      return jsonResult(await drive(ctx, 'GET', url, anyJson));
    }
    case TOOL.searchFiles: {
      const text = queryLiteral(call.query!);
      const q = `(name contains ${text} or fullText contains ${text}) and trashed = false`;
      const url = `${DRIVE_API_BASE}/files${queryString({ q, ...pageQuery(call) })}`;
      return jsonResult(await drive(ctx, 'GET', url, anyJson));
    }
    case TOOL.readFile: {
      const meta = await drive(
        ctx,
        'GET',
        `${fileUrl(call.file!)}${queryString({ fields: FILE_FIELDS, supportsAllDrives: true })}`,
        isFileMeta,
      );
      if (meta.mimeType === FOLDER_MIME_TYPE) {
        throw new ExecutorRefusal(`'${meta.name}' is a folder: list it with ${TOOL.listFolder}.`);
      }
      const exportAs = EXPORT_AS[meta.mimeType];
      let content: string;
      if (exportAs !== undefined) {
        content = await driveText(
          ctx,
          fileUrl(meta.id, `/export${queryString({ mimeType: exportAs })}`),
        );
      } else if (isTextType(meta.mimeType)) {
        if (meta.size !== undefined && Number(meta.size) > MAX_READ_BYTES) {
          throw new ExecutorRefusal(`The file is larger than ${MAX_READ_BYTES} bytes.`);
        }
        content = await driveText(
          ctx,
          fileUrl(meta.id, queryString({ alt: 'media', supportsAllDrives: true })),
        );
      } else {
        throw new ExecutorRefusal(
          `'${meta.name}' (${meta.mimeType}) is not text: only Google Docs, Sheets, Slides and text files are read.`,
        );
      }
      return jsonResult({ ...meta, ...(exportAs ? { exportedAs: exportAs } : {}), content });
    }
    case TOOL.uploadFile: {
      const { body, boundary } = multipartBody(
        { name: call.name, mimeType: call.mimeType, parents: [call.folder] },
        call.content!,
        call.mimeType!,
      );
      const url = `${DRIVE_UPLOAD_BASE}/files${queryString({
        uploadType: 'multipart',
        fields: `${FILE_FIELDS},parents`,
        supportsAllDrives: true,
      })}`;
      return jsonResult(
        await drive(ctx, 'POST', url, anyJson, {
          raw: body,
          type: `multipart/related; boundary=${boundary}`,
        }),
      );
    }
    case TOOL.createFolder: {
      const url = `${DRIVE_API_BASE}/files${queryString({
        fields: `${FILE_FIELDS},parents`,
        supportsAllDrives: true,
      })}`;
      return jsonResult(
        await drive(ctx, 'POST', url, anyJson, {
          json: { name: call.name, mimeType: FOLDER_MIME_TYPE, parents: [call.folder] },
        }),
      );
    }
    default:
      throw new ExecutorRefusal(`unknown tool '${call.tool}'`);
  }
}

export function executeGoogleDrive(
  ctx: ExecuteContext,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<McpToolResult> {
  return declining(async () => {
    const read = readDriveCall(tool, args, ctx.resources);
    if ('denied' in read) throw new ExecutorRefusal(read.denied);
    expectRequiredScopes(ctx);
    return run(ctx, read.call);
  });
}

interface About {
  readonly user: { readonly emailAddress: string; readonly displayName?: string };
}

const isAbout: Guard<About> = (x): x is About =>
  isRecord(x) &&
  isRecord(x.user) &&
  typeof x.user.emailAddress === 'string' &&
  (x.user.displayName === undefined || typeof x.user.displayName === 'string');

// eslint-disable-next-line no-control-regex -- control characters are what this removes
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** One resource per account: its drive, named by the account's address. */
export async function discoverGoogleDriveResources(
  ctx: AccountContext,
): Promise<readonly Resource[]> {
  expectRequiredScopes(ctx);
  const about = await drive(
    ctx,
    'GET',
    `${DRIVE_API_BASE}/about${queryString({ fields: 'user(displayName,emailAddress)' })}`,
    isAbout,
  );
  const address = accountAddress(about.user.emailAddress);
  if (address === null) {
    throw new UpstreamProtocolError(`${SERVICE_ID}: Google names the account by no address`);
  }
  const name = about.user.displayName?.replace(CONTROL, '').trim() || null;
  return [
    {
      service: SERVICE_ID,
      ref: driveRefOf(address),
      displayName: name === null ? address : `${name} <${address}>`,
      metadata: { account_email: address },
    },
  ];
}
