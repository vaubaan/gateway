/**
 * MCP tools of the `miro` provider — a rewrap of Miro's official MCP server
 * (https://mcp.miro.com/), plus `list_boards`, which the gateway answers
 * itself from the mission's boards.
 *
 * ADR      : docs/decisions/miro-rewraps-the-official-mcp-server.md ;
 *            docs/decisions/rewrap-official-mcps.md.
 * Handbook : docs/handbook/providers/miro.md §0, §2, §6.5.
 *
 * `upstream-tools.json` is Miro's `tools` array of `tools/list` — today
 * MODELLED from Miro's documentation (its `captured_at` is null: listing the
 * tools needs a Miro account), tomorrow captured verbatim by
 * `npm run capture-upstream-tools --workspace @vaubaan/plugin-miro`.
 *
 * The gateway's declaration of a tool is Miro's, with one change : the
 * locator. Miro's tools take the board as a URL (`miro_url`) ; the gateway's
 * take `board` (a board of the mission : its ref or its URL) and, where the
 * tool acts on one item, `item_id`, and the executor writes `miro_url`
 * itself from what was classified. Every other argument is Miro's own,
 * forwarded as declared ; one the schema does not declare is refused.
 *
 * The module refuses to load when the upstream file
 *   - lists a tool that is neither offered (`LOCATOR`) nor left out
 *     (`LEFT_OUT_UPSTREAM_TOOLS`) — a new Miro tool waits for its model ;
 *   - gives an offered tool an argument whose name looks like a locator
 *     (`…url`, `…_id`, `board…`) the model does not know : it could aim the
 *     call at another board than the classified one.
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

import { MIRO_COMMENT_ID, MIRO_ITEM_ID } from './identifiers.ts';
import {
  BOARD_ARGUMENT,
  BOARD_LOCATOR,
  ITEM_ARGUMENT,
  LEFT_OUT_UPSTREAM_TOOLS,
  LOCATOR,
  MODELLED_LOCATING_ARGUMENTS,
  PROVIDER_ID,
  TOOL,
  toolNameOf,
  type Locator,
} from './identity.ts';
import upstream from './upstream-tools.json' with { type: 'json' };

/** One tool as `tools/list` declares it, reduced to what the gateway reads. */
export interface UpstreamTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    readonly required?: readonly string[];
  };
}

/** Where the upstream list comes from, and when it was captured (`null` : modelled). */
export interface UpstreamToolList {
  readonly source: string;
  readonly capturedAt: string | null;
  readonly tools: readonly UpstreamTool[];
}

function isUpstreamTool(x: unknown): x is UpstreamTool {
  if (typeof x !== 'object' || x === null) return false;
  const t = x as Record<string, unknown>;
  const schema = t.inputSchema as Record<string, unknown> | null | undefined;
  return (
    typeof t.name === 'string' &&
    typeof t.description === 'string' &&
    typeof schema === 'object' &&
    schema !== null &&
    schema.type === 'object' &&
    typeof schema.properties === 'object' &&
    schema.properties !== null &&
    Object.values(schema.properties).every((p) => typeof p === 'object' && p !== null) &&
    (schema.required === undefined ||
      (Array.isArray(schema.required) && schema.required.every((r) => typeof r === 'string')))
  );
}

/** The upstream file, checked. */
export function readUpstreamToolList(raw: unknown): UpstreamToolList {
  const file = raw as Record<string, unknown> | null;
  if (
    typeof file !== 'object' ||
    file === null ||
    typeof file.source !== 'string' ||
    !(file.captured_at === null || typeof file.captured_at === 'string') ||
    !Array.isArray(file.tools) ||
    !file.tools.every(isUpstreamTool)
  ) {
    throw new Error(`${PROVIDER_ID}: upstream-tools.json is not a list of MCP tool declarations`);
  }
  return { source: file.source, capturedAt: file.captured_at, tools: file.tools };
}

/** A name that may carry a location : a URL, an id, a board. */
const LOOKS_LOCATING = /(url|urls|_id|_ids)$|board/i;

/** The arguments of an offered tool that the model does not know and that look like locators. */
export function unmodelledLocators(tool: UpstreamTool): string[] {
  return Object.keys(tool.inputSchema.properties).filter(
    (name) =>
      name !== BOARD_LOCATOR && LOOKS_LOCATING.test(name) && !MODELLED_LOCATING_ARGUMENTS.has(name),
  );
}

const BOARD_PROPERTY = {
  type: 'string',
  description:
    'The board, one of the mission: its ref (uXjVOD6LSME~, the Miro id with each trailing = written ~) or its URL (https://miro.com/app/board/uXjVOD6LSME=/). list_boards names them.',
} as const;

function itemProperty(required: boolean): Readonly<Record<string, unknown>> {
  return {
    type: 'string',
    pattern: MIRO_ITEM_ID.source,
    description: required
      ? 'The item the call acts on: its numeric Miro id (the moveToWidget value of its link).'
      : 'An item to scope the call to: its numeric Miro id (the moveToWidget value of its link). Omit for the whole board.',
  };
}

/** The gateway's schema of an offered tool : Miro's, with `board` / `item_id` for `miro_url`. */
function gatewaySchema(tool: UpstreamTool, locator: Locator): McpToolDeclaration['inputSchema'] {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  if (locator !== 'none') {
    properties[BOARD_ARGUMENT] = BOARD_PROPERTY;
    required.push(BOARD_ARGUMENT);
  }
  if (locator === 'board-item' || locator === 'board-item-required') {
    properties[ITEM_ARGUMENT] = itemProperty(locator === 'board-item-required');
    if (locator === 'board-item-required') required.push(ITEM_ARGUMENT);
  }
  for (const [name, schema] of Object.entries(tool.inputSchema.properties)) {
    if (name === BOARD_LOCATOR) continue;
    if (name in properties) {
      throw new Error(`${PROVIDER_ID}: upstream tool '${tool.name}' declares '${name}' itself`);
    }
    properties[name] =
      name === 'comment_id' ? { ...schema, pattern: MIRO_COMMENT_ID.source } : { ...schema };
  }
  for (const name of tool.inputSchema.required ?? []) {
    if (name !== BOARD_LOCATOR) required.push(name);
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/** The declarations the gateway offers, built from the upstream list (and refused when it is not modelled). */
export function declarationsOf(list: UpstreamToolList): {
  readonly offered: readonly McpToolDeclaration[];
  readonly upstreamOf: ReadonlyMap<string, UpstreamTool>;
} {
  const byName = new Map(list.tools.map((tool) => [tool.name, tool] as const));
  for (const tool of list.tools) {
    if (LOCATOR[tool.name] === undefined && LEFT_OUT_UPSTREAM_TOOLS[tool.name] === undefined) {
      throw new Error(`${PROVIDER_ID}: upstream tool '${tool.name}' is not modelled`);
    }
    if (LOCATOR[tool.name] !== undefined) {
      const unknown = unmodelledLocators(tool);
      if (unknown.length > 0) {
        throw new Error(
          `${PROVIDER_ID}: upstream tool '${tool.name}' takes ${unknown.join(', ')}, which may name another board: model it first`,
        );
      }
      if (LOCATOR[tool.name] !== 'none' && !(BOARD_LOCATOR in tool.inputSchema.properties)) {
        throw new Error(
          `${PROVIDER_ID}: upstream tool '${tool.name}' has no '${BOARD_LOCATOR}' argument: model its locator first`,
        );
      }
    }
  }
  const offered: McpToolDeclaration[] = [LIST_BOARDS_DECLARATION];
  const upstreamOf = new Map<string, UpstreamTool>();
  for (const name of Object.values(TOOL)) {
    if (name === TOOL.listBoards) continue;
    const upstreamName = name.slice(toolNameOf('').length);
    const tool = byName.get(upstreamName);
    const locator = LOCATOR[upstreamName];
    if (!tool || !locator) {
      throw new Error(`${PROVIDER_ID}: upstream tool '${upstreamName}' is missing from the list`);
    }
    offered.push({
      name,
      description: tool.description,
      inputSchema: gatewaySchema(tool, locator),
    });
    upstreamOf.set(name, tool);
  }
  return { offered, upstreamOf };
}

const LIST_BOARDS_DECLARATION: McpToolDeclaration = {
  name: TOOL.listBoards,
  description:
    'List the Miro boards of this mission: for each, its ref (what the board argument of the other tools takes), its name and its URL. Answered by the gateway, without a call to Miro.',
  inputSchema: { type: 'object', properties: {} },
};

export const UPSTREAM_TOOL_LIST: UpstreamToolList = readUpstreamToolList(upstream);

const declared = declarationsOf(UPSTREAM_TOOL_LIST);

/** Every tool the plugin declares, `list_boards` first. */
export const miroTools: readonly McpToolDeclaration[] = declared.offered;

/** The upstream declaration behind a gateway tool name, or `undefined` (`list_boards`, an unknown name). */
export function upstreamToolOf(name: string): UpstreamTool | undefined {
  return declared.upstreamOf.get(name);
}
