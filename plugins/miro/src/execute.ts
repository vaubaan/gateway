/**
 * Upstream calls of the `miro` provider, and resource discovery.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §2.4 — the credential arrives
 *            decrypted in the context, is used for one call, and is never
 *            returned.
 * Handbook : docs/handbook/providers/miro.md §5.2, §5.10, §6.2, §6.3.
 *
 * Rules :
 *   - the call is read by `readMiroCall`, the classifier's own reader :
 *     requests are built from what it returned, never from `args`, so the
 *     executor is safe when called alone ;
 *   - `fetch` comes from the context ;
 *   - a provider failure is thrown (401 / 403 → `UpstreamAuthError`, any
 *     other failed status → `UpstreamHttpError`) ; what the executor declines
 *     itself is an `ExecutorRefusal`, turned into an `isError` result by
 *     `declining` ;
 *   - before an update or a deletion of a typed item, the item's type is read
 *     and must be the tool's : `delete_sticky_note` never deletes a frame ;
 *   - what Miro answers is untrusted : discovery checks it with type guards
 *     and passes every board id through its grammar.
 */

import {
  ExecutorRefusal,
  UpstreamAuthError,
  UpstreamHttpError,
  declining,
  expectCredentialKind,
  type ConnectionContext,
  type ExecuteContext,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import type { WritableKind } from './bodies.ts';
import { readMiroCall, type MiroCall } from './call.ts';
import { boardRefOf, itemId, miroIdOf } from './identifiers.ts';
import { ACCESS_TOKEN_FIELD, PROVIDER_ID } from './identity.ts';

/** Miro's REST API, version 2. */
export const MIRO_API_BASE = 'https://api.miro.com/v2';
/** The token context (team, scopes) : version 1 of the API. */
export const MIRO_TOKEN_CONTEXT_URL = 'https://api.miro.com/v1/oauth-token';

/** Discovery stops after this many boards (a logger warning says so). */
export const MAX_DISCOVERED_BOARDS = 500;
const BOARDS_PAGE = 50;

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NO_CONTENT = 204;
const HTTP_TOO_MANY = 429;
const QUOTED_ERROR_LENGTH = 300;

/** The endpoint segment of each writable type. */
const TYPED_ENDPOINT: Readonly<Record<WritableKind, string>> = {
  sticky_note: 'sticky_notes',
  shape: 'shapes',
  text: 'texts',
  card: 'cards',
  frame: 'frames',
};

const VIEW_LINK_PREFIX = 'https://miro.com/app/board/';

// ─────────────────────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────────────────────

/** The access token of the connection. */
function tokenOf(ctx: ConnectionContext): string {
  const secret = expectCredentialKind(PROVIDER_ID, ctx.credential, 'api-key');
  const token = secret.fields[ACCESS_TOKEN_FIELD];
  if (!token)
    throw new Error(`${PROVIDER_ID}: the credential has no '${ACCESS_TOKEN_FIELD}' field`);
  return token;
}

/** Miro's own words of a failure, bounded ; empty when the body says nothing readable. */
async function failureText(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (typeof body === 'object' && body !== null && 'message' in body) {
      const message = (body as { message?: unknown }).message;
      if (typeof message === 'string' && message.length > 0) {
        return `: ${message.slice(0, QUOTED_ERROR_LENGTH)}`;
      }
    }
  } catch {
    // Not JSON : the status says it.
  }
  return '';
}

function rateLimitReset(res: Response): string {
  const reset = res.headers.get('x-ratelimit-reset');
  return reset !== null && /^[0-9]{1,20}$/.test(reset)
    ? ` (Miro's rate limit resets at X-RateLimit-Reset ${reset})`
    : '';
}

/**
 * One request to Miro. `url` is absolute ; the caller built it from checked
 * identifiers. A failed status is thrown ; a 204 answers `null`.
 */
export async function miroRequest(
  ctx: ConnectionContext,
  method: string,
  url: string,
  body?: unknown,
): Promise<unknown> {
  const res = await ctx.fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${tokenOf(ctx)}`,
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  const where = `${PROVIDER_ID} ${method} ${new URL(url).pathname}`;
  if (res.status === HTTP_UNAUTHORIZED || res.status === HTTP_FORBIDDEN) {
    throw new UpstreamAuthError(
      `${where}: Miro refused the token (HTTP ${res.status})${await failureText(res)}`,
      res.status,
    );
  }
  if (!res.ok) {
    const reset = res.status === HTTP_TOO_MANY ? rateLimitReset(res) : '';
    throw new UpstreamHttpError(
      `${where} failed with HTTP ${res.status}${reset}${await failureText(res)}`,
      res.status,
    );
  }
  if (res.status === HTTP_NO_CONTENT) return null;
  const text = await res.text();
  return text === '' ? null : (JSON.parse(text) as unknown);
}

// ─────────────────────────────────────────────────────────────────────────────
// Execute
// ─────────────────────────────────────────────────────────────────────────────

/** The board's path, from a ref the reader resolved. */
function boardPath(ref: string): string {
  const miroId = miroIdOf(ref);
  if (miroId === null) throw new ExecutorRefusal('board: malformed board ref');
  return `${MIRO_API_BASE}/boards/${encodeURIComponent(miroId)}`;
}

function withQuery(url: string, query: Readonly<Record<string, string>>): string {
  const search = new URLSearchParams(query).toString();
  return search === '' ? url : `${url}?${search}`;
}

function text(payload: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

const ITEM_TYPE_WORD = /^[a-z_]{1,32}$/;

/** Declines unless the item `id` of the board is of `kind`. */
async function expectItemType(
  ctx: ExecuteContext,
  board: string,
  id: string,
  kind: WritableKind,
): Promise<void> {
  const item = await miroRequest(ctx, 'GET', `${board}/items/${id}`);
  const type =
    typeof item === 'object' && item !== null ? (item as { type?: unknown }).type : undefined;
  if (type === kind) return;
  const shown =
    typeof type === 'string' && ITEM_TYPE_WORD.test(type) ? `a ${type}` : 'of no known type';
  const argument = kind === 'frame' ? 'frame_id' : 'item_id';
  throw new ExecutorRefusal(
    `${argument}: item '${id}' is ${shown}, not a ${kind}; nothing was changed. Use the tool for its type.`,
  );
}

async function run(ctx: ExecuteContext, call: MiroCall): Promise<McpToolResult> {
  if (call.op === 'list-boards') {
    const boards: unknown[] = [];
    for (const ref of call.boards) {
      const details = await miroRequest(ctx, 'GET', boardPath(ref));
      boards.push({ ref, board: details });
    }
    return text(boards);
  }
  const board = boardPath(call.board);
  switch (call.op) {
    case 'get-board':
      return text(await miroRequest(ctx, 'GET', board));
    case 'list-items':
      return text(await miroRequest(ctx, 'GET', withQuery(`${board}/items`, call.query)));
    case 'get-item':
      return text(await miroRequest(ctx, 'GET', `${board}/items/${call.itemId}`));
    case 'list-connectors':
      return text(await miroRequest(ctx, 'GET', withQuery(`${board}/connectors`, call.query)));
    case 'get-connector':
      return text(await miroRequest(ctx, 'GET', `${board}/connectors/${call.connectorId}`));
    case 'list-tags':
      return text(await miroRequest(ctx, 'GET', withQuery(`${board}/tags`, call.query)));
    case 'list-item-tags':
      return text(await miroRequest(ctx, 'GET', `${board}/items/${call.itemId}/tags`));
    case 'create-item':
      return text(
        await miroRequest(ctx, 'POST', `${board}/${TYPED_ENDPOINT[call.kind]}`, call.body),
      );
    case 'update-item':
      await expectItemType(ctx, board, call.itemId, call.kind);
      return text(
        await miroRequest(
          ctx,
          'PATCH',
          `${board}/${TYPED_ENDPOINT[call.kind]}/${call.itemId}`,
          call.body,
        ),
      );
    case 'delete-item':
      await expectItemType(ctx, board, call.itemId, call.kind);
      await miroRequest(ctx, 'DELETE', `${board}/${TYPED_ENDPOINT[call.kind]}/${call.itemId}`);
      return text({ deleted: call.itemId, type: call.kind });
    case 'create-connector':
      return text(await miroRequest(ctx, 'POST', `${board}/connectors`, call.body));
    case 'update-connector':
      return text(
        await miroRequest(ctx, 'PATCH', `${board}/connectors/${call.connectorId}`, call.body),
      );
    case 'delete-connector':
      await miroRequest(ctx, 'DELETE', `${board}/connectors/${call.connectorId}`);
      return text({ deleted: call.connectorId, type: 'connector' });
    case 'create-tag':
      return text(await miroRequest(ctx, 'POST', `${board}/tags`, call.body));
    case 'attach-tag':
      await miroRequest(
        ctx,
        'POST',
        withQuery(`${board}/items/${call.itemId}`, { tag_id: call.tagId }),
      );
      return text({ attached: call.tagId, item: call.itemId });
    case 'remove-tag':
      await miroRequest(
        ctx,
        'DELETE',
        withQuery(`${board}/items/${call.itemId}`, { tag_id: call.tagId }),
      );
      return text({ removed: call.tagId, item: call.itemId });
    case 'bulk-create':
      return text(await miroRequest(ctx, 'POST', `${board}/items/bulk`, call.items));
  }
}

export function executeMiro(
  ctx: ExecuteContext,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<McpToolResult> {
  return declining(async () => {
    const read = readMiroCall(tool, args, ctx.resources);
    if ('denied' in read) throw new ExecutorRefusal(read.denied);
    return run(ctx, read.call);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────────────────────────────────────

interface Named {
  readonly id: string;
  readonly name: string;
}

function isNamed(x: unknown): x is Named {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { id?: unknown }).id === 'string' &&
    typeof (x as { name?: unknown }).name === 'string'
  );
}

/** The token context : the team the app was installed on, and the scopes. */
export interface TokenContext {
  readonly team: Named;
  readonly scopes: readonly string[];
}

/** `GET /v1/oauth-token`, checked. A 400 is Miro's "invalid token" : a rejected credential. */
export async function readTokenContext(ctx: ConnectionContext): Promise<TokenContext> {
  let answer: unknown;
  try {
    answer = await miroRequest(ctx, 'GET', MIRO_TOKEN_CONTEXT_URL);
  } catch (err) {
    if (err instanceof UpstreamHttpError && err.status === 400) {
      throw new UpstreamAuthError(
        `${PROVIDER_ID}: Miro answered "invalid token" (HTTP 400)`,
        HTTP_UNAUTHORIZED,
      );
    }
    throw err;
  }
  if (typeof answer !== 'object' || answer === null) {
    throw new Error(`${PROVIDER_ID}: unexpected token context (expected an object)`);
  }
  const { team, scopes } = answer as { team?: unknown; scopes?: unknown };
  if (!isNamed(team) || !Array.isArray(scopes) || !scopes.every((s) => typeof s === 'string')) {
    throw new Error(
      `${PROVIDER_ID}: unexpected token context (expected team { id, name } and scopes)`,
    );
  }
  return { team: { id: team.id, name: team.name }, scopes };
}

interface BoardsPage {
  readonly data: readonly Named[];
  readonly total?: number;
}

function isBoardsPage(x: unknown): x is BoardsPage {
  if (typeof x !== 'object' || x === null) return false;
  const { data, total } = x as { data?: unknown; total?: unknown };
  return (
    Array.isArray(data) && data.every(isNamed) && (total === undefined || typeof total === 'number')
  );
}

function viewLinkOf(board: unknown): string | null {
  const link = (board as { viewLink?: unknown }).viewLink;
  return typeof link === 'string' && link.startsWith(VIEW_LINK_PREFIX) && !/[\s]/.test(link)
    ? link
    : null;
}

/**
 * The boards of the team the token was installed on, one resource each.
 * `ref` is the board id with its trailing `=` written `~` ; a board id
 * outside Miro's grammar is left out, with a warning.
 */
export async function discoverMiroResources(ctx: ConnectionContext): Promise<readonly Resource[]> {
  const context = await readTokenContext(ctx);
  const teamId = itemId(context.team.id);
  if (teamId === null)
    throw new Error(`${PROVIDER_ID}: the token context names a malformed team id`);

  const resources: Resource[] = [];
  let skipped = 0;
  let offset = 0;
  let seen = 0;
  for (;;) {
    const query = new URLSearchParams({
      team_id: teamId,
      limit: String(BOARDS_PAGE),
      offset: String(offset),
    });
    const page = await miroRequest(ctx, 'GET', `${MIRO_API_BASE}/boards?${query.toString()}`);
    if (!isBoardsPage(page)) {
      throw new Error(`${PROVIDER_ID}: unexpected board list (expected { data: [{ id, name }] })`);
    }
    for (const board of page.data) {
      if (seen >= MAX_DISCOVERED_BOARDS) break;
      seen += 1;
      const ref = boardRefOf(board.id);
      if (ref === null) {
        skipped += 1;
        continue;
      }
      const viewLink = viewLinkOf(board);
      resources.push({
        provider: PROVIDER_ID,
        ref,
        displayName: board.name,
        metadata: { team_id: teamId, ...(viewLink !== null ? { view_link: viewLink } : {}) },
      });
    }
    offset += page.data.length;
    const done =
      page.data.length < BOARDS_PAGE || (page.total !== undefined && offset >= page.total);
    if (seen >= MAX_DISCOVERED_BOARDS) {
      if (!done) {
        ctx.logger?.warn(`${PROVIDER_ID}: discovery stopped at ${MAX_DISCOVERED_BOARDS} boards`, {
          ceiling: MAX_DISCOVERED_BOARDS,
        });
      }
      break;
    }
    if (done) break;
  }
  if (skipped > 0) {
    ctx.logger?.warn(
      `${PROVIDER_ID}: ${skipped} board(s) left out, their id is outside the board grammar`,
      {
        skipped,
      },
    );
  }
  return resources;
}
