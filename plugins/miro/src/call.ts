/**
 * The one reader of a `miro` call, for `classify` and `execute` alike.
 *
 * Handbook : docs/handbook/providers/miro.md.
 * ADR      : docs/decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md.
 *
 * `readMiroCall(tool, args, resources)` checks the tool, the closed argument
 * surface, the board (a board of the mission), the item and the comment
 * through their grammars, the type of every other argument, and returns
 * what to send — the upstream tool and its arguments, the board URL
 * (`miro_url`) written by the gateway from the classified board and item —
 * or the sentence refusing
 * the call. `classify` turns a `MiroCall` into slices, `execute` into the
 * upstream request ; neither reads `args` past it, so what is classified is
 * what is sent. Pure : no network, no credential, no clock.
 */

import { declaredArgumentsOf, undeclaredArgumentDenial, type Resource } from '@vaubaan/plugin-sdk';

import { boardOf, boardUrlOf, commentId, itemId } from './identifiers.ts';
import {
  BOARD_ARGUMENT,
  ITEM_ARGUMENT,
  LOCATOR,
  PROVIDER_ID,
  TOOL,
  TOOL_PREFIX,
  locatorArgumentOf,
} from './identity.ts';
import { miroTools, upstreamToolOf } from './tools.ts';

type Args = Readonly<Record<string, unknown>>;

/** What a call does, read and checked. Board refs are resource refs ; ids passed their grammar. */
export type MiroCall =
  /** Answered by the gateway from the mission's boards. */
  | { readonly kind: 'list-boards'; readonly boards: readonly Resource[] }
  | {
      readonly kind: 'forward';
      /** The gateway's tool name (`miro__canvas_search`). */
      readonly tool: string;
      /** Miro's tool name (`canvas_search`). */
      readonly upstream: string;
      /** The board ref, `null` for a tool that names no board. */
      readonly board: string | null;
      /** The item the call is scoped to, `null` for the whole board. */
      readonly item: string | null;
      /** The comment thread a reply or a resolution names. */
      readonly comment: string | null;
      /** What leaves for Miro : the declared arguments, `miro_url` written by the gateway. */
      readonly arguments: Readonly<Record<string, unknown>>;
    };

export type MiroCallOutcome = { readonly call: MiroCall } | { readonly denied: string };

const KNOWN_TOOLS: ReadonlySet<string> = new Set(miroTools.map((t) => t.name));
/** The gateway's declaration of each tool : what an agent may send. */
const DECLARATION_OF = new Map(miroTools.map((t) => [t.name, t] as const));
/** The gateway's own locating arguments, never forwarded as such. */
const GATEWAY_LOCATORS: ReadonlySet<string> = new Set([BOARD_ARGUMENT, ITEM_ARGUMENT]);
/** `execute` forwards the declared arguments : the surface is closed. */
const DECLARED_ARGUMENTS = declaredArgumentsOf(miroTools);

/**
 * The refusal for an argument `tool` does not declare, `null` when there is
 * none : the one rule `classify` and `execute` both apply.
 */
export function undeclaredArgument(tool: string, args: Args): string | null {
  return undeclaredArgumentDenial(DECLARED_ARGUMENTS, tool, args);
}

export const NO_MIRO_BOARD = 'no Miro board in this mission';

/** The mission's Miro boards, in mission order. */
function boardsOf(resources: readonly Resource[]): Resource[] {
  return resources.filter((r) => r.provider === PROVIDER_ID);
}

/** The board a `board` argument names, when it is one of the mission's ; the refusal otherwise. */
export function resolveBoard(
  value: unknown,
  resources: readonly Resource[],
): { readonly board: string } | { readonly denied: string } {
  const ref = boardOf(value);
  if (ref === null) {
    return {
      denied: `${BOARD_ARGUMENT}: expected a board ref (uXjVOD6LSME~) or a board URL (https://miro.com/app/board/uXjVOD6LSME=/).`,
    };
  }
  if (!boardsOf(resources).some((r) => r.ref === ref)) {
    return {
      denied: `${BOARD_ARGUMENT}: board '${ref}' is not a board of this mission. A board this mission creates through the gateway is reached right after its creation; one created elsewhere must be added to the mission by its creator.`,
    };
  }
  return { board: ref };
}

/**
 * The JSON type an argument's schema names, checked loosely (the value itself
 * is Miro's to read). `null` passes where Miro's schema says `nullable`.
 */
function typeIssue(name: string, schema: unknown, value: unknown): string | null {
  const declared = schema as { readonly type?: unknown; readonly nullable?: unknown } | null;
  const type = declared?.type;
  if (value === null && declared?.nullable === true) return null;
  const ok = (() => {
    switch (type) {
      case 'string':
        return typeof value === 'string';
      case 'integer':
        return typeof value === 'number' && Number.isInteger(value);
      case 'number':
        return typeof value === 'number' && Number.isFinite(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'array':
        return Array.isArray(value);
      case 'object':
        return typeof value === 'object' && value !== null && !Array.isArray(value);
      default:
        return true;
    }
  })();
  return ok ? null : `${name}: expected ${String(type)}.`;
}

/**
 * The one reader of a call : the tool, the closed surface, the locator, the
 * identifiers, then each forwarded argument's type. Every refusal is a
 * sentence the agent can act on.
 */
export function readMiroCall(
  tool: string,
  args: Args,
  resources: readonly Resource[],
): MiroCallOutcome {
  if (!KNOWN_TOOLS.has(tool)) return { denied: `unknown tool '${tool}'` };
  const undeclared = undeclaredArgument(tool, args);
  if (undeclared !== null) return { denied: undeclared };

  if (tool === TOOL.listBoards) {
    const boards = boardsOf(resources);
    if (boards.length === 0) return { denied: NO_MIRO_BOARD };
    return { call: { kind: 'list-boards', boards } };
  }

  const upstream = tool.slice(TOOL_PREFIX.length);
  const declaration = DECLARATION_OF.get(tool);
  const locator = LOCATOR[upstream];
  if (!declaration || !upstreamToolOf(tool) || !locator) {
    return { denied: `unknown tool '${tool}'` };
  }

  let board: string | null = null;
  let item: string | null = null;
  if (locator !== 'none') {
    const resolved = resolveBoard(args[BOARD_ARGUMENT], resources);
    if ('denied' in resolved) return resolved;
    board = resolved.board;
  }
  if (locator === 'board-item' || locator === 'board-item-required') {
    const raw = args[ITEM_ARGUMENT];
    if (raw !== undefined) {
      item = itemId(raw);
      if (item === null) return { denied: `${ITEM_ARGUMENT}: expected a numeric Miro item id.` };
    } else if (locator === 'board-item-required') {
      return { denied: `${ITEM_ARGUMENT}: required — the item this tool acts on.` };
    }
  }

  let comment: string | null = null;
  const forwarded: Record<string, unknown> = {};
  // The gateway's declaration : Miro's offered arguments, without the
  // locator, the telemetry and the withheld ones (tools.ts).
  for (const [name, schema] of Object.entries(declaration.inputSchema.properties ?? {})) {
    if (GATEWAY_LOCATORS.has(name)) continue;
    const value = args[name];
    if (value === undefined) {
      if (declaration.inputSchema.required?.includes(name)) {
        return { denied: `${name}: required by '${tool}'.` };
      }
      continue;
    }
    if (name === 'comment_id') {
      comment = commentId(value);
      if (comment === null) return { denied: 'comment_id: expected a Miro comment id.' };
    }
    const issue = typeIssue(name, schema, value);
    if (issue !== null) return { denied: issue };
    forwarded[name] = value;
  }
  if (board !== null) forwarded[locatorArgumentOf(upstream)] = boardUrlOf(board, item);

  return { call: { kind: 'forward', tool, upstream, board, item, comment, arguments: forwarded } };
}
