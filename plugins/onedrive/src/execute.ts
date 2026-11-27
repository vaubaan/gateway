/**
 * Upstream calls of the `onedrive` service, and resource discovery.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §2.4 — the credential arrives
 *            decrypted in the context, is used for one call, and is never
 *            returned.
 * Handbook : docs/handbook/services/onedrive.md.
 *
 * Rules:
 *   - the call is read by `readDriveCall`, the classifier's own reader: what
 *     is sent is built from what it returned, never from `args`;
 *   - JSON answers go through the SDK's `httpJson`; a file's text is read
 *     from its pre-authenticated download address (a OneDrive or SharePoint
 *     host, `downloadUrl`), without the access token, through
 *     `readBoundedText` after `upstreamFailure`;
 *   - a next page is Graph's own `@odata.nextLink`, followed only when it is
 *     the same listing of the same drive;
 *   - a token without `Files.ReadWrite` is refused before any request.
 */

import {
  CredentialRefusal,
  ExecutorRefusal,
  UpstreamAnswerTooLarge,
  UpstreamProtocolError,
  UpstreamAuthError,
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
  type Resource,
} from '@vaubaan/plugin-sdk';

import { readDriveCall, type DriveCall } from './call.ts';
import { SCOPES_NOT_GRANTED, missingScopes } from './credential.ts';
import {
  accountAddress,
  downloadUrl,
  driveRefOf,
  isTextType,
  odataString,
  pathSegment,
} from './identifiers.ts';
import { GRAPH_API_BASE, ROOT_FOLDER, SERVICE_ID, TOOL } from './identity.ts';
import { MAX_READ_BYTES } from './tools.ts';

/** The fields of an item Graph answers for a listing or a search. */
export const ITEM_FIELDS = 'id,name,size,lastModifiedDateTime,webUrl,folder,file';
const DEFAULT_PAGE_SIZE = 50;
const DOWNLOAD_URL = '@microsoft.graph.downloadUrl';

/** What a person reads when Graph refuses to read the account at discovery. */
export const PROFILE_REFUSED =
  'Microsoft refused to read this account (User.Read). An administrator of the organisation may have to consent to the app, or its policy blocks it; then refresh the account.';

function tokenOf(ctx: AccountContext): string {
  return expectCredentialKind(SERVICE_ID, ctx.credential, 'oauth2').accessToken;
}

function expectRequiredScopes(ctx: AccountContext): void {
  const { scopes } = expectCredentialKind(SERVICE_ID, ctx.credential, 'oauth2');
  if (missingScopes(scopes).length > 0) throw new CredentialRefusal(SCOPES_NOT_GRANTED, 403);
}

type Body = { readonly json: unknown } | { readonly raw: string; readonly type: string };

/** One Graph request, the access token as a Bearer. */
async function graph<T>(
  ctx: AccountContext,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  guard: Guard<T>,
  body?: Body,
): Promise<T> {
  const what = `Microsoft Graph ${method} ${new URL(url).pathname}`;
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
    { url, method, headers: { authorization }, what, ...(body ? { body: body.json } : {}) },
    guard,
  );
}

/** A segment of a request path from a value its grammar already accepted. */
function segment(value: string, what: string): string {
  const s = pathSegment(value);
  if (s === null) throw new ExecutorRefusal(`${what}: not a path segment.`);
  return s;
}

/** The path of an item: the drive's root, or an item by its id. */
function itemPath(id: string): string {
  return id === ROOT_FOLDER ? '/me/drive/root' : `/me/drive/items/${segment(id, 'item id')}`;
}

/**
 * The URL of a listing's page: the first one built here, a next one Graph's
 * `@odata.nextLink` as the agent passed it back — refused unless it is the
 * same path on Graph.
 */
function pageUrl(call: DriveCall, path: string, query: Record<string, string | number>): string {
  const first = `${GRAPH_API_BASE}${path}`;
  if (call.pageToken === null) {
    return `${first}${queryString({ ...query, $top: call.pageSize ?? DEFAULT_PAGE_SIZE })}`;
  }
  let next: URL;
  try {
    next = new URL(call.pageToken);
  } catch {
    throw new ExecutorRefusal('pageToken: the nextPageToken of the previous page, as it is.');
  }
  const expected = new URL(first);
  if (next.origin !== expected.origin || next.pathname !== expected.pathname) {
    throw new ExecutorRefusal('pageToken: not a next page of this listing.');
  }
  return next.toString();
}

/** A listing as the agent reads it: the items, and the token of the next page. */
function page(answer: unknown): unknown {
  if (!isRecord(answer)) return answer;
  const next = answer['@odata.nextLink'];
  return {
    items: Array.isArray(answer.value) ? answer.value : [],
    ...(typeof next === 'string' ? { nextPageToken: next } : {}),
  };
}

interface ItemMeta {
  readonly id: string;
  readonly name: string;
  readonly size?: number;
  readonly webUrl?: string;
  readonly folder?: unknown;
  readonly file?: { readonly mimeType?: string };
  readonly [DOWNLOAD_URL]?: string;
}

const isItemMeta: Guard<ItemMeta> = (x): x is ItemMeta =>
  isRecord(x) &&
  typeof x.id === 'string' &&
  typeof x.name === 'string' &&
  (x.size === undefined || typeof x.size === 'number') &&
  (x.file === undefined || isRecord(x.file));

/** A file's text from its download address: no access token there; bounded. */
async function downloadText(ctx: AccountContext, address: URL): Promise<string> {
  const what = `OneDrive download ${address.hostname}`;
  const res = await ctx.fetch(address.toString(), {
    method: 'GET',
    redirect: 'error',
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (!res.ok) throw await upstreamFailure(res, what);
  try {
    return await readBoundedText(res, MAX_READ_BYTES, what);
  } catch (err) {
    if (err instanceof UpstreamAnswerTooLarge) {
      throw new ExecutorRefusal(`The file is larger than ${MAX_READ_BYTES} bytes.`);
    }
    throw err;
  }
}

async function run(ctx: ExecuteContext, call: DriveCall): Promise<McpToolResult> {
  switch (call.tool) {
    case TOOL.listFolder: {
      const url = pageUrl(call, `${itemPath(call.folder!)}/children`, { $select: ITEM_FIELDS });
      return jsonResult(page(await graph(ctx, 'GET', url, anyJson)));
    }
    case TOOL.searchFiles: {
      const path = `/me/drive/root/search(q=${encodeURIComponent(odataString(call.query!))})`;
      const url = pageUrl(call, path, { $select: ITEM_FIELDS });
      return jsonResult(page(await graph(ctx, 'GET', url, anyJson)));
    }
    case TOOL.readFile: {
      const meta = await graph(ctx, 'GET', `${GRAPH_API_BASE}${itemPath(call.file!)}`, isItemMeta);
      if (meta.folder !== undefined) {
        throw new ExecutorRefusal(`'${meta.name}' is a folder: list it with ${TOOL.listFolder}.`);
      }
      const mimeType = meta.file?.mimeType ?? 'application/octet-stream';
      if (!isTextType(mimeType)) {
        throw new ExecutorRefusal(
          `'${meta.name}' (${mimeType}) is not text: only text files (txt, md, csv, json, xml, html…) are read.`,
        );
      }
      if (meta.size !== undefined && meta.size > MAX_READ_BYTES) {
        throw new ExecutorRefusal(`The file is larger than ${MAX_READ_BYTES} bytes.`);
      }
      const address = downloadUrl(meta[DOWNLOAD_URL]);
      if (address === null) {
        throw new UpstreamProtocolError(
          `${SERVICE_ID}: Microsoft Graph gave no download address on a OneDrive host`,
        );
      }
      const content = await downloadText(ctx, address);
      return jsonResult({
        id: meta.id,
        name: meta.name,
        mimeType,
        ...(meta.webUrl !== undefined ? { webUrl: meta.webUrl } : {}),
        content,
      });
    }
    case TOOL.uploadFile: {
      const name = segment(call.name!, 'name');
      const target =
        call.folder === ROOT_FOLDER
          ? `/me/drive/root:/${name}:/content`
          : `${itemPath(call.folder!)}:/${name}:/content`;
      const url = `${GRAPH_API_BASE}${target}${queryString({ '@microsoft.graph.conflictBehavior': 'rename' })}`;
      return jsonResult(
        await graph(ctx, 'PUT', url, anyJson, {
          raw: call.content!,
          type: `${call.mimeType!}; charset=utf-8`,
        }),
      );
    }
    case TOOL.createFolder: {
      const url = `${GRAPH_API_BASE}${itemPath(call.folder!)}/children`;
      return jsonResult(
        await graph(ctx, 'POST', url, anyJson, {
          json: { name: call.name, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' },
        }),
      );
    }
    default:
      throw new ExecutorRefusal(`unknown tool '${call.tool}'`);
  }
}

export function executeOneDrive(
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

interface Me {
  readonly displayName?: string | null;
  readonly mail?: string | null;
  readonly userPrincipalName?: string | null;
}

const optionalText = (x: unknown): boolean =>
  x === undefined || x === null || typeof x === 'string';
const isMe: Guard<Me> = (x): x is Me =>
  isRecord(x) &&
  optionalText(x.displayName) &&
  optionalText(x.mail) &&
  optionalText(x.userPrincipalName);

// eslint-disable-next-line no-control-regex -- control characters are what this removes
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** What a person reads when Microsoft names the account by no address. */
export const NO_ADDRESS =
  'Microsoft names this account by no e-mail address (neither mail nor userPrincipalName is one): its drive cannot be named.';

/** One resource per account: its OneDrive, named by the account's address. */
export async function discoverOneDriveResources(ctx: AccountContext): Promise<readonly Resource[]> {
  expectRequiredScopes(ctx);
  let me: Me;
  try {
    me = await graph(
      ctx,
      'GET',
      `${GRAPH_API_BASE}/me${queryString({ $select: 'displayName,mail,userPrincipalName' })}`,
      isMe,
    );
  } catch (err) {
    if (err instanceof UpstreamAuthError && err.upstreamStatus === 403) {
      throw new CredentialRefusal(PROFILE_REFUSED, 403);
    }
    throw err;
  }
  const address = accountAddress(me.mail) ?? accountAddress(me.userPrincipalName);
  if (address === null) throw new CredentialRefusal(NO_ADDRESS, 403);
  const name = me.displayName?.replace(CONTROL, '').trim() || null;
  return [
    {
      service: SERVICE_ID,
      ref: driveRefOf(address),
      displayName: name === null ? address : `${name} <${address}>`,
      metadata: { account_email: address },
    },
  ];
}
