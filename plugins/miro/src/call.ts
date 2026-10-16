/**
 * The one reader of a `miro` call, for `classify` and `execute` alike.
 *
 * Handbook : docs/handbook/providers/miro.md §2, §6.3.
 * ADR      : docs/decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md ;
 *            docs/decisions/plugin-arguments-closed-surface-and-typed-refusals.md.
 *
 * `readMiroCall(tool, args, resources)` resolves the board, reads every
 * identifier through its grammar, builds the query and the body, and returns
 * them as a `MiroCall` — or the sentence refusing the call. `classify` turns
 * a `MiroCall` into slices, `execute` into requests ; neither reads `args`
 * past it, so what is classified is what is sent. Pure : no network, no
 * credential, no clock.
 */

import { declaredArgumentsOf, undeclaredArgumentDenial, type Resource } from '@vaubaan/plugin-sdk';

import {
  LIST_ITEM_TYPES,
  bulkBody,
  connectorBody,
  itemBody,
  tagBody,
  type Body,
  type WritableKind,
} from './bodies.ts';
import { MIRO_BOARD_ID, boardRef, boardRefOf, cursorOf, itemId } from './identifiers.ts';
import { PROVIDER_ID, TOOL } from './identity.ts';
import { miroTools } from './tools.ts';

/** At most this many boards are read by one `list_boards`. */
export const MAX_LISTED_BOARDS = 50;

type Query = Readonly<Record<string, string>>;

/** What a call does, read and checked. Board refs are resource refs ; ids passed their grammar. */
export type MiroCall =
  | { readonly op: 'list-boards'; readonly boards: readonly string[] }
  | { readonly op: 'get-board'; readonly board: string }
  | { readonly op: 'list-items'; readonly board: string; readonly query: Query }
  | { readonly op: 'get-item'; readonly board: string; readonly itemId: string }
  | { readonly op: 'list-connectors'; readonly board: string; readonly query: Query }
  | { readonly op: 'get-connector'; readonly board: string; readonly connectorId: string }
  | { readonly op: 'list-tags'; readonly board: string; readonly query: Query }
  | { readonly op: 'list-item-tags'; readonly board: string; readonly itemId: string }
  | {
      readonly op: 'create-item';
      readonly board: string;
      readonly kind: WritableKind;
      readonly body: Body;
    }
  | {
      readonly op: 'update-item';
      readonly board: string;
      readonly kind: WritableKind;
      readonly itemId: string;
      readonly body: Body;
    }
  | {
      readonly op: 'delete-item';
      readonly board: string;
      readonly kind: WritableKind;
      readonly itemId: string;
    }
  | { readonly op: 'create-connector'; readonly board: string; readonly body: Body }
  | {
      readonly op: 'update-connector';
      readonly board: string;
      readonly connectorId: string;
      readonly body: Body;
    }
  | { readonly op: 'delete-connector'; readonly board: string; readonly connectorId: string }
  | { readonly op: 'create-tag'; readonly board: string; readonly body: Body }
  | {
      readonly op: 'attach-tag' | 'remove-tag';
      readonly board: string;
      readonly itemId: string;
      readonly tagId: string;
    }
  | { readonly op: 'bulk-create'; readonly board: string; readonly items: readonly Body[] };

export type MiroCallOutcome = { readonly call: MiroCall } | { readonly denied: string };

type Args = Readonly<Record<string, unknown>>;

const KNOWN_TOOLS: ReadonlySet<string> = new Set(miroTools.map((t) => t.name));
/** `execute` forwards bodies built from the arguments : the surface is closed. */
const DECLARED_ARGUMENTS = declaredArgumentsOf(miroTools);

/**
 * The refusal for an argument `tool` does not declare, `null` when there is
 * none : the one rule `classify` and `execute` both apply.
 */
export function undeclaredArgument(tool: string, args: Args): string | null {
  return undeclaredArgumentDenial(DECLARED_ARGUMENTS, tool, args);
}

/** The typed item tools : what they write and the argument naming the item. */
const TYPED_TOOLS: Readonly<
  Record<
    string,
    {
      readonly verb: 'create' | 'update' | 'delete';
      readonly kind: WritableKind;
      readonly idArg: 'item_id' | 'frame_id';
    }
  >
> = {
  [TOOL.createStickyNote]: { verb: 'create', kind: 'sticky_note', idArg: 'item_id' },
  [TOOL.updateStickyNote]: { verb: 'update', kind: 'sticky_note', idArg: 'item_id' },
  [TOOL.deleteStickyNote]: { verb: 'delete', kind: 'sticky_note', idArg: 'item_id' },
  [TOOL.createShape]: { verb: 'create', kind: 'shape', idArg: 'item_id' },
  [TOOL.updateShape]: { verb: 'update', kind: 'shape', idArg: 'item_id' },
  [TOOL.deleteShape]: { verb: 'delete', kind: 'shape', idArg: 'item_id' },
  [TOOL.createText]: { verb: 'create', kind: 'text', idArg: 'item_id' },
  [TOOL.updateText]: { verb: 'update', kind: 'text', idArg: 'item_id' },
  [TOOL.deleteText]: { verb: 'delete', kind: 'text', idArg: 'item_id' },
  [TOOL.createCard]: { verb: 'create', kind: 'card', idArg: 'item_id' },
  [TOOL.updateCard]: { verb: 'update', kind: 'card', idArg: 'item_id' },
  [TOOL.deleteCard]: { verb: 'delete', kind: 'card', idArg: 'item_id' },
  [TOOL.createFrame]: { verb: 'create', kind: 'frame', idArg: 'frame_id' },
  [TOOL.updateFrame]: { verb: 'update', kind: 'frame', idArg: 'frame_id' },
  [TOOL.deleteFrame]: { verb: 'delete', kind: 'frame', idArg: 'frame_id' },
};

/** The board refs of the mission on this provider. */
function ownBoards(resources: readonly Resource[]): string[] {
  return resources.filter((r) => r.provider === PROVIDER_ID).map((r) => r.ref);
}

/**
 * The board a call targets :
 *
 *   - `args.board` given : a well-formed ref AND one of the mission's Miro
 *     boards, or a refusal (never the single board as a silent substitute).
 *     A board in Miro's own spelling (`uXjVOD6LSME=`) is refused with the ref
 *     to use : it is not converted ;
 *   - absent : the mission's single Miro board, or a refusal when it holds
 *     none or several.
 */
export function resolveBoard(
  args: Args,
  resources: readonly Resource[],
): { readonly ref: string } | { readonly denied: string } {
  const own = ownBoards(resources);
  if (args.board !== undefined) {
    const given = args.board;
    if (typeof given === 'string' && given.includes('=') && MIRO_BOARD_ID.test(given)) {
      // The hint names a board the mission holds, never one it does not.
      const spelled = boardRefOf(given);
      return spelled !== null && own.includes(spelled)
        ? {
            denied: `board: '${given}' is Miro's spelling of a board id; name the board '${spelled}' (as list_boards shows it)`,
          }
        : { denied: 'board: malformed board ref' };
    }
    const ref = boardRef(given);
    if (ref === null) return { denied: 'board: malformed board ref' };
    return own.includes(ref)
      ? { ref }
      : { denied: `board '${ref}' is not selected in this mission` };
  }
  if (own.length === 1) {
    const ref = boardRef(own[0]);
    return ref === null ? { denied: 'board: malformed board ref' } : { ref };
  }
  return {
    denied:
      own.length === 0
        ? 'board: argument missing and the mission touches no Miro board'
        : `board: argument missing and the mission touches ${own.length} Miro boards — name one`,
  };
}

function required(args: Args, name: string): { readonly id: string } | { readonly denied: string } {
  const value = args[name];
  if (value === undefined || value === null || value === '') return { denied: `${name}: missing` };
  const id = itemId(value);
  return id === null ? { denied: `${name}: malformed id` } : { id };
}

function integerIn(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** `limit` and `cursor` of a cursor-paged list, as Miro's query. */
function cursorPage(
  args: Args,
): { readonly query: Record<string, string> } | { readonly denied: string } {
  const query: Record<string, string> = {};
  if (args.limit !== undefined) {
    if (!integerIn(args.limit, 10, 50))
      return { denied: 'limit: expected an integer from 10 to 50' };
    query.limit = String(args.limit);
  }
  if (args.cursor !== undefined) {
    const cursor = cursorOf(args.cursor);
    if (cursor === null) return { denied: 'cursor: malformed cursor' };
    query.cursor = cursor;
  }
  return { query };
}

/** Reads a call of the `miro` provider ; see the module comment. */
export function readMiroCall(
  tool: string,
  args: Args,
  resources: readonly Resource[],
): MiroCallOutcome {
  if (!KNOWN_TOOLS.has(tool)) return { denied: `unknown miro tool '${tool}'` };
  const undeclared = undeclaredArgument(tool, args);
  if (undeclared !== null) return { denied: undeclared };

  if (tool === TOOL.listBoards) {
    const own = ownBoards(resources);
    if (own.length === 0) return { denied: 'the mission touches no Miro board' };
    if (own.length > MAX_LISTED_BOARDS) {
      return {
        denied: `the mission touches ${own.length} Miro boards; list_boards reads at most ${MAX_LISTED_BOARDS}`,
      };
    }
    const boards: string[] = [];
    for (const ref of own) {
      const checked = boardRef(ref);
      if (checked === null) return { denied: 'board: malformed board ref' };
      boards.push(checked);
    }
    return { call: { op: 'list-boards', boards } };
  }

  const resolved = resolveBoard(args, resources);
  if ('denied' in resolved) return resolved;
  const board = resolved.ref;

  const typed = TYPED_TOOLS[tool];
  if (typed !== undefined) {
    if (typed.verb === 'create') {
      const read = itemBody(typed.kind, args, 'create');
      if ('denied' in read) return read;
      return { call: { op: 'create-item', board, kind: typed.kind, body: read.body } };
    }
    const target = required(args, typed.idArg);
    if ('denied' in target) return target;
    if (typed.verb === 'delete') {
      return { call: { op: 'delete-item', board, kind: typed.kind, itemId: target.id } };
    }
    const read = itemBody(typed.kind, args, 'update');
    if ('denied' in read) return read;
    return {
      call: { op: 'update-item', board, kind: typed.kind, itemId: target.id, body: read.body },
    };
  }

  switch (tool) {
    case TOOL.getBoard:
      return { call: { op: 'get-board', board } };
    case TOOL.listItems: {
      const page = cursorPage(args);
      if ('denied' in page) return page;
      const query = { ...page.query };
      if (args.type !== undefined) {
        if (
          typeof args.type !== 'string' ||
          !(LIST_ITEM_TYPES as readonly string[]).includes(args.type)
        ) {
          return { denied: `type: expected one of ${LIST_ITEM_TYPES.join(', ')}` };
        }
        query.type = args.type;
      }
      if (args.parent_frame_id !== undefined) {
        const frame = itemId(args.parent_frame_id);
        if (frame === null) return { denied: 'parent_frame_id: malformed id' };
        query.parent_item_id = frame;
      }
      return { call: { op: 'list-items', board, query } };
    }
    case TOOL.getItem:
    case TOOL.listItemTags: {
      const item = required(args, 'item_id');
      if ('denied' in item) return item;
      const op = tool === TOOL.getItem ? 'get-item' : 'list-item-tags';
      return { call: { op, board, itemId: item.id } };
    }
    case TOOL.listConnectors: {
      const page = cursorPage(args);
      if ('denied' in page) return page;
      return { call: { op: 'list-connectors', board, query: page.query } };
    }
    case TOOL.getConnector:
    case TOOL.deleteConnector: {
      const connector = required(args, 'connector_id');
      if ('denied' in connector) return connector;
      const op = tool === TOOL.getConnector ? 'get-connector' : 'delete-connector';
      return { call: { op, board, connectorId: connector.id } };
    }
    case TOOL.listTags: {
      const query: Record<string, string> = {};
      if (args.limit !== undefined) {
        if (!integerIn(args.limit, 1, 50))
          return { denied: 'limit: expected an integer from 1 to 50' };
        query.limit = String(args.limit);
      }
      if (args.offset !== undefined) {
        if (!integerIn(args.offset, 0, 10000)) {
          return { denied: 'offset: expected an integer from 0 to 10000' };
        }
        query.offset = String(args.offset);
      }
      return { call: { op: 'list-tags', board, query } };
    }
    case TOOL.createConnector: {
      const read = connectorBody(args, 'create');
      if ('denied' in read) return read;
      return { call: { op: 'create-connector', board, body: read.body } };
    }
    case TOOL.updateConnector: {
      const connector = required(args, 'connector_id');
      if ('denied' in connector) return connector;
      const read = connectorBody(args, 'update');
      if ('denied' in read) return read;
      return {
        call: { op: 'update-connector', board, connectorId: connector.id, body: read.body },
      };
    }
    case TOOL.createTag: {
      const read = tagBody(args);
      if ('denied' in read) return read;
      return { call: { op: 'create-tag', board, body: read.body } };
    }
    case TOOL.attachTag:
    case TOOL.removeTag: {
      const item = required(args, 'item_id');
      if ('denied' in item) return item;
      const tag = required(args, 'tag_id');
      if ('denied' in tag) return tag;
      const op = tool === TOOL.attachTag ? 'attach-tag' : 'remove-tag';
      return { call: { op, board, itemId: item.id, tagId: tag.id } };
    }
    case TOOL.createItems: {
      const read = bulkBody(args.items);
      if ('denied' in read) return read;
      return { call: { op: 'bulk-create', board, items: read.items } };
    }
    default:
      return { denied: `unknown miro tool '${tool}'` };
  }
}
