/**
 * Classifier of the `miro` service : `(tool, args, resources) → slices`.
 *
 * Spec     : docs/spec/gateway-risk-model.md §3, §7 ; docs/spec/vaubaan-gateway.md
 *            §10 ("a classification error is a security hole").
 * Handbook : docs/handbook/services/miro.md.
 *
 * Pure. The call is read once by `readMiroCall` (board resolved against the
 * mission, identifiers through their grammars, the closed surface) ; this
 * file only places what it read on the data model. Every slice of a call that
 * names a board is rooted at `miro.board[<ref>]`, the ref of the mission
 * resource, so the gateway reads the board back from the slice (audit,
 * approval requests).
 *
 * Conventions :
 *   1. **Layered writes.** A deletion emits `…delete.W` (risk `item-delete`
 *      or `frame-delete`), a creation of many items at once
 *      `item.bulk-create.W` (risk `bulk-create`) ; the recursive patterns of
 *      `content-write` match both, so a mission needs `content-write` too.
 *   2. **An update of the canvas may delete.** `canvas_update_from_svg`
 *      applies an SVG as a diff : what the document no longer holds is
 *      deleted, frames included. It touches `item-delete` and `frame-delete`
 *      on every call (`*` : which items is not known before Miro applies it).
 *   3. **Creating into a frame emits no frame slice** : `item_id` names
 *      where the new items go, not an item that changes.
 *   4. **No board, no resource.** A new board (`board.W`) and the format
 *      guides of the canvas tools (`format-guide.R`, Miro's documentation,
 *      nothing of the customer's) name no board.
 *   5. **The board itself.** Its details (title, description, icon, the
 *      space it is in) are `board[<ref>].metadata`, who can open it and with
 *      which role `board[<ref>].access`, a narrated walkthrough
 *      `board[<ref>].boardcast` : each its own risk, never `content-write`.
 */

import {
  identSegment,
  type ClassifyOutcome,
  type Resource,
  type Slice,
  type SliceSegment,
} from '@vaubaan/plugin-sdk';

import { readMiroCall, type MiroCall } from './call.ts';
import { SERVICE_ID, UPSTREAM_TOOL } from './identity.ts';

const name = (value: string): SliceSegment => ({ kind: 'name', value });
// Every identifier passed its grammar in `readMiroCall`, and every grammar is
// slice-safe ; `identSegment` is the safety net should one ever widen (`[*]`).
const ident = (value: string): SliceSegment => identSegment(value);
const ANY: SliceSegment = { kind: 'ident', value: '*' };

function slice(action: 'R' | 'W', path: readonly SliceSegment[]): Slice {
  return { service: SERVICE_ID, path, action };
}

/** The slices of a call that `readMiroCall` accepted. */
export function slicesOf(call: MiroCall): Slice[] {
  if (call.kind === 'list-boards') {
    // One slice naming every board listed : a list when there are several, so
    // the audit keeps them all (the resource stage reads list values too).
    const refs = call.boards.map((b) => b.ref);
    const [only] = refs;
    const boards: SliceSegment =
      refs.length === 1 && only !== undefined ? ident(only) : { kind: 'list', values: refs };
    return [slice('R', [name('board'), boards])];
  }

  if (call.upstream === UPSTREAM_TOOL.boardCreate) return [slice('W', [name('board')])];
  if (
    call.upstream === UPSTREAM_TOOL.canvasComposerSkill ||
    call.upstream === UPSTREAM_TOOL.canvasFormatSkill
  ) {
    return [slice('R', [name('format-guide')])];
  }

  if (call.board === null) throw new Error(`${SERVICE_ID}: '${call.tool}' names no board`);
  const root: readonly SliceSegment[] = [name('board'), ident(call.board)];
  const item = call.item === null ? ANY : ident(call.item);
  const comment = call.comment === null ? ANY : ident(call.comment);

  switch (call.upstream) {
    case UPSTREAM_TOOL.canvasSearch:
    case UPSTREAM_TOOL.canvasReadAsSvg:
    case UPSTREAM_TOOL.prototypeRead:
    case UPSTREAM_TOOL.imageGetData:
    case UPSTREAM_TOOL.imageGetUrl:
    case UPSTREAM_TOOL.tableListRows:
    case UPSTREAM_TOOL.tableUpdateHistory:
      return [slice('R', [...root, name('item'), item])];

    case UPSTREAM_TOOL.commentListComments:
      return [slice('R', [...root, name('comment'), ANY])];

    case UPSTREAM_TOOL.canvasCreateFromSvg:
    case UPSTREAM_TOOL.prototypeCreate:
      return [
        slice('W', [...root, name('item')]),
        slice('W', [...root, name('item'), name('bulk-create')]),
      ];

    case UPSTREAM_TOOL.imageCreate:
    case UPSTREAM_TOOL.tableCreate:
      return [slice('W', [...root, name('item')])];

    case UPSTREAM_TOOL.canvasUpdateFromSvg:
      return [
        slice('W', [...root, name('item'), item]),
        slice('W', [...root, name('item'), ANY, name('delete')]),
        slice('W', [...root, name('frame'), ANY, name('delete')]),
      ];

    case UPSTREAM_TOOL.tableSyncRows:
    case UPSTREAM_TOOL.tableUpdateView:
      return [slice('W', [...root, name('item'), item])];

    case UPSTREAM_TOOL.commentCreate:
      return [slice('W', [...root, name('comment')])];

    case UPSTREAM_TOOL.commentReply:
    case UPSTREAM_TOOL.commentResolve:
      return [slice('W', [...root, name('comment'), comment])];

    case UPSTREAM_TOOL.boardGetSpace:
      return [slice('R', [...root, name('metadata')])];

    case UPSTREAM_TOOL.boardUpdateMetadata:
      return [slice('W', [...root, name('metadata')])];

    case UPSTREAM_TOOL.contentItemListRoles:
      return [slice('R', [...root, name('access')])];

    case UPSTREAM_TOOL.boardShare:
    case UPSTREAM_TOOL.boardRoleUpdate:
      return [slice('W', [...root, name('access')])];

    case UPSTREAM_TOOL.createBoardcast:
      return [slice('W', [...root, name('boardcast')])];

    default:
      throw new Error(`${SERVICE_ID}: '${call.tool}' has no slice mapping`);
  }
}

export function classifyMiro(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ClassifyOutcome {
  const read = readMiroCall(tool, args, resources);
  if ('denied' in read) return read;
  return { slices: slicesOf(read.call) };
}
