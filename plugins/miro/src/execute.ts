/**
 * Upstream calls of the `miro` provider, and resource discovery.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §2.4 — the credential arrives
 *            decrypted in the context, is used for one call, and is never
 *            returned.
 * Handbook : docs/handbook/providers/miro.md §6.2, §6.3.
 * ADR      : docs/decisions/miro-rewraps-the-official-mcp-server.md.
 *
 * Rules :
 *   - the call is read by `readMiroCall`, the classifier's own reader : the
 *     upstream arguments are the ones it returned (with `miro_url` written by
 *     the gateway), never `args`, so the executor is safe when called alone ;
 *   - `list_boards` is answered from the mission's boards, without a request ;
 *   - every other tool is one `tools/call` to Miro's MCP server (`mcp.ts`),
 *     with the OAuth access token of the connection ; Miro's tool result is
 *     passed through (its `isError` included) — the agent reads Miro's words ;
 *   - what Miro answers is untrusted : discovery reads board ids through
 *     their grammar and keeps only what it recognises as a board.
 */

import {
  CredentialRefusal,
  UpstreamAuthError,
  expectCredentialKind,
  refusalResult,
  type ConnectionContext,
  type ExecuteContext,
  type McpToolContent,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { readMiroCall } from './call.ts';
import { boardIdOfUrl, boardRefOf, boardUrlOf, MIRO_BOARD_ID } from './identifiers.ts';
import { BOARD_LOCATOR, MIRO_BOARD_URL_BASE, PROVIDER_ID, UPSTREAM_TOOL } from './identity.ts';
import { mcpRequest } from './mcp.ts';
import { UPSTREAM_TOOL_LIST, type UpstreamTool } from './tools.ts';

/** Discovery keeps at most this many boards (a logger warning says so). */
export const MAX_DISCOVERED_BOARDS = 500;

/**
 * What a person reads when Miro refuses its MCP server to an account that
 * has just authorized it : a plugin-written sentence (`CredentialRefusal`),
 * shown on the connect page. ⚠ That Miro answers 403 in this case is
 * assumed, not observed.
 */
export const MCP_SERVER_REFUSED =
  "Miro refused its MCP server to this account. On a Miro Enterprise plan, an administrator first enables Miro's MCP server for the organisation (Miro admin guide, 'Miro MCP Server'); then reconnect the account.";

/** The OAuth access token of the connection. */
function tokenOf(ctx: ConnectionContext): string {
  return expectCredentialKind(PROVIDER_ID, ctx.credential, 'oauth2').accessToken;
}

export async function executeMiro(
  ctx: ExecuteContext,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<McpToolResult> {
  // Declined here, before any request : a result the agent reads, not an upstream failure.
  const read = readMiroCall(tool, args, ctx.resources);
  if ('denied' in read) return refusalResult(read.denied);
  const { call } = read;
  if (call.kind === 'list-boards') return listBoardsResult(call.boards);
  const result = await mcpRequest(ctx, tokenOf(ctx), 'tools/call', {
    name: call.upstream,
    arguments: call.arguments,
  });
  return toolResultOf(result);
}

/** `list_boards` : the mission's boards, as discovery described them. */
function listBoardsResult(boards: readonly Resource[]): McpToolResult {
  const listed = boards.map((board) => ({
    board: board.ref,
    name: board.displayName,
    url: typeof board.metadata?.url === 'string' ? board.metadata.url : boardUrlOf(board.ref, null),
  }));
  return { content: [{ type: 'text', text: JSON.stringify({ boards: listed }, null, 2) }] };
}

/** Miro's tool result, passed through ; a block of a type MCP clients may not know becomes its JSON. */
export function toolResultOf(result: unknown): McpToolResult {
  if (
    typeof result !== 'object' ||
    result === null ||
    !Array.isArray((result as Record<string, unknown>).content)
  ) {
    throw new Error(`${PROVIDER_ID}: the MCP server answered something that is not a tool result`);
  }
  const r = result as Record<string, unknown>;
  const content = (r.content as unknown[]).map(contentBlock);
  const structured = r.structuredContent;
  return {
    content,
    ...(typeof structured === 'object' && structured !== null && !Array.isArray(structured)
      ? { structuredContent: structured as Record<string, unknown> }
      : {}),
    ...(r.isError === true ? { isError: true } : {}),
  };
}

function contentBlock(block: unknown): McpToolContent {
  const b = (typeof block === 'object' && block !== null ? block : {}) as Record<string, unknown>;
  if (b.type === 'text' && typeof b.text === 'string') return { type: 'text', text: b.text };
  if (b.type === 'image' && typeof b.data === 'string' && typeof b.mimeType === 'string') {
    return { type: 'image', data: b.data, mimeType: b.mimeType };
  }
  const resource = b.resource as Record<string, unknown> | undefined;
  if (b.type === 'resource' && typeof resource?.uri === 'string') {
    return {
      type: 'resource',
      resource: {
        uri: resource.uri,
        ...(typeof resource.mimeType === 'string' ? { mimeType: resource.mimeType } : {}),
        ...(typeof resource.text === 'string' ? { text: resource.text } : {}),
      },
    };
  }
  return { type: 'text', text: JSON.stringify(block) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The boards of the team the person chose when they authorized the gateway,
 * from Miro's `board_search_boards` (no arguments : every board). The answer
 * is read leniently — its shape is not documented — and strictly at once :
 * a board is an object whose id passes the board grammar and whose link (or
 * `type`) says it is a board, or a board URL in the text ; nothing else.
 *
 * Also compares Miro's live `tools/list` with the plugin's model and logs
 * the differences (names only) : the signal to capture the tool list again.
 */
export async function discoverMiroResources(ctx: ConnectionContext): Promise<readonly Resource[]> {
  const token = tokenOf(ctx);
  let result: unknown;
  try {
    result = await mcpRequest(ctx, token, 'tools/call', {
      name: UPSTREAM_TOOL.boardSearchBoards,
      arguments: {},
    });
  } catch (err) {
    if (err instanceof UpstreamAuthError && err.upstreamStatus === 403) {
      throw new CredentialRefusal(MCP_SERVER_REFUSED, 403);
    }
    throw err;
  }
  const answer = toolResultOf(result);
  if (answer.isError === true) {
    throw new Error(`${PROVIDER_ID}: ${UPSTREAM_TOOL.boardSearchBoards} failed: ${textOf(answer)}`);
  }
  const boards = boardsIn(answer);
  if (boards.length > MAX_DISCOVERED_BOARDS) {
    ctx.logger?.warn('discovery stopped at the board ceiling', {
      found: boards.length,
      kept: MAX_DISCOVERED_BOARDS,
    });
  }
  await reportDrift(ctx, token);
  return boards.slice(0, MAX_DISCOVERED_BOARDS);
}

function textOf(result: McpToolResult): string {
  return result.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join(' ')
    .slice(0, 300);
}

interface FoundBoard {
  readonly id: string;
  readonly name: string | null;
}

const BOARD_LINK = /https:\/\/miro\.com\/app\/board\/([A-Za-z0-9_-]{1,62}={0,2})\//g;
const ALL_DIGITS = /^[0-9]+$/;

/** The boards an answer of `board_search_boards` names, deduplicated, in order. */
export function boardsIn(result: McpToolResult): Resource[] {
  const found = new Map<string, FoundBoard>();
  const add = (board: FoundBoard): void => {
    const known = found.get(board.id);
    if (!known || (known.name === null && board.name !== null)) found.set(board.id, board);
  };
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || typeof value !== 'object' || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v) => visit(v, depth + 1));
      return;
    }
    const board = boardObject(value as Record<string, unknown>);
    if (board) add(board);
    Object.values(value).forEach((v) => visit(v, depth + 1));
  };
  if (result.structuredContent) visit(result.structuredContent, 0);
  for (const block of result.content) {
    if (block.type !== 'text') continue;
    try {
      visit(JSON.parse(block.text), 0);
      // JSON : the board objects are the answer ; a link elsewhere in it may name any board.
      continue;
    } catch {
      // Not JSON : the board links in the text are what there is.
    }
    for (const match of block.text.matchAll(BOARD_LINK)) {
      const id = match[1];
      if (id !== undefined) add({ id, name: null });
    }
  }
  const resources: Resource[] = [];
  for (const board of found.values()) {
    const ref = boardRefOf(board.id);
    if (ref === null) continue;
    resources.push({
      provider: PROVIDER_ID,
      ref,
      displayName: board.name ?? board.id,
      metadata: { url: `${MIRO_BOARD_URL_BASE}${board.id}/` },
    });
  }
  return resources;
}

/** An object that describes a board : an id of the board grammar, and a board link or `type: board`. */
function boardObject(o: Record<string, unknown>): FoundBoard | null {
  const id = o.id;
  if (typeof id !== 'string' || !MIRO_BOARD_ID.test(id) || ALL_DIGITS.test(id)) return null;
  const links = [o.viewLink, o.url, o.link, o.boardUrl, o.miro_url].filter(
    (v): v is string => typeof v === 'string',
  );
  const linked = links.some((link) => boardIdOfUrl(link.split(/[?#]/)[0]) === id);
  if (!linked && o.type !== 'board') return null;
  const name = [o.name, o.title].find((v): v is string => typeof v === 'string' && v.trim() !== '');
  return { id, name: name?.trim().slice(0, 200) ?? null };
}

/** What differs between Miro's live tool list and the plugin's model : names only. */
export interface ToolDrift {
  /** Upstream tools the model has and Miro no longer lists. */
  readonly gone: readonly string[];
  /** Tools Miro lists that the model does not know. */
  readonly unmodelled: readonly string[];
  /** Per modelled tool, the argument names that differ (`+` Miro only, `-` model only). */
  readonly arguments: Readonly<Record<string, readonly string[]>>;
}

/** The drift between a live `tools/list` answer and the model. */
export function toolDrift(
  live: unknown,
  model: readonly UpstreamTool[] = UPSTREAM_TOOL_LIST.tools,
): ToolDrift {
  const listed = Array.isArray((live as { tools?: unknown } | null)?.tools)
    ? ((live as { tools: unknown[] }).tools.filter(
        (t) =>
          typeof t === 'object' && t !== null && typeof (t as { name?: unknown }).name === 'string',
      ) as { name: string; inputSchema?: { properties?: Record<string, unknown> } }[])
    : [];
  const liveByName = new Map(listed.map((t) => [t.name, t] as const));
  const modelByName = new Map(model.map((t) => [t.name, t] as const));
  const args: Record<string, string[]> = {};
  for (const tool of model) {
    const other = liveByName.get(tool.name);
    if (!other) continue;
    const mine = new Set(Object.keys(tool.inputSchema.properties));
    const theirs = new Set(Object.keys(other.inputSchema?.properties ?? {}));
    const diff = [
      ...[...theirs].filter((n) => !mine.has(n)).map((n) => `+${n}`),
      ...[...mine].filter((n) => !theirs.has(n)).map((n) => `-${n}`),
    ];
    if (diff.length > 0) args[tool.name] = diff;
  }
  return {
    gone: model.map((t) => t.name).filter((n) => !liveByName.has(n)),
    unmodelled: listed.map((t) => t.name).filter((n) => !modelByName.has(n)),
    arguments: args,
  };
}

/** Logs the drift of the live tool list ; never fails a discovery. */
async function reportDrift(ctx: ConnectionContext, token: string): Promise<void> {
  try {
    const drift = toolDrift(await mcpRequest(ctx, token, 'tools/list', {}));
    if (drift.gone.length + drift.unmodelled.length + Object.keys(drift.arguments).length > 0) {
      ctx.logger?.warn(
        "Miro's MCP tools differ from the plugin's model; capture them again (handbook providers/miro §6.5)",
        {
          locator: BOARD_LOCATOR,
          gone: drift.gone,
          unmodelled: drift.unmodelled,
          arguments: drift.arguments,
        },
      );
    }
  } catch (err) {
    ctx.logger?.debug('tools/list of the Miro MCP server not compared', {
      error_class: err instanceof Error ? err.name : typeof err,
    });
  }
}
