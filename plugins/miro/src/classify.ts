/**
 * Classifier of the `miro` provider : `(tool, args, resources) → slices`.
 *
 * Spec     : docs/spec/gateway-risk-model.md §3, §7 ; docs/spec/vaubaan-gateway.md
 *            §10 ("a classification error is a security hole").
 * Handbook : docs/handbook/providers/miro.md §2, §5.
 *
 * Pure. The call is read once by `readMiroCall` (board resolved against the
 * mission, every identifier through its grammar, the closed bodies) ; this
 * file only places what it read on the data model. Every slice is rooted at
 * `miro.board[<ref>]`, the ref of the mission resource, so the gateway reads
 * the board back from the slice (audit, approval requests).
 *
 * Conventions :
 *   1. **Layered writes.** A deletion emits `…[id].delete.W` (risk
 *      `item-delete` or `frame-delete`), the bulk call `item.bulk-create.W`
 *      (risk `bulk-create`) ; the recursive patterns of `content-write`
 *      match both, so a mission needs `content-write` too.
 *   2. **A frame is its own entity** for the typed frame tools ; `get_item`
 *      and `list_items` read any item, frames included, as `item`.
 *   3. **Moving into a frame emits no frame slice** (handbook §5.3).
 */

import type { ClassifyOutcome, Resource, Slice, SliceSegment } from '@vaubaan/plugin-sdk';

import { readMiroCall, type MiroCall } from './call.ts';
import { PROVIDER_ID } from './identity.ts';

const name = (value: string): SliceSegment => ({ kind: 'name', value });
const ident = (value: string): SliceSegment => ({ kind: 'ident', value });
const ANY: SliceSegment = { kind: 'ident', value: '*' };

function slice(action: 'R' | 'W', path: readonly SliceSegment[]): Slice {
  return { provider: PROVIDER_ID, path, action };
}

/** The slices of a call that `readMiroCall` accepted. */
export function slicesOf(call: MiroCall): Slice[] {
  if (call.op === 'list-boards') {
    return call.boards.map((ref) => slice('R', [name('board'), ident(ref)]));
  }
  const root: readonly SliceSegment[] = [name('board'), ident(call.board)];
  const entityOf = (kind: string): string => (kind === 'frame' ? 'frame' : 'item');
  switch (call.op) {
    case 'get-board':
      return [slice('R', root)];
    case 'list-items':
      return [slice('R', [...root, name('item'), ANY])];
    case 'get-item':
      return [slice('R', [...root, name('item'), ident(call.itemId)])];
    case 'list-connectors':
      return [slice('R', [...root, name('connector'), ANY])];
    case 'get-connector':
      return [slice('R', [...root, name('connector'), ident(call.connectorId)])];
    case 'list-tags':
      return [slice('R', [...root, name('tag'), ANY])];
    case 'list-item-tags':
      return [slice('R', [...root, name('item'), ident(call.itemId), name('tag-link'), ANY])];
    case 'create-item':
      return [slice('W', [...root, name(entityOf(call.kind))])];
    case 'update-item':
      return [slice('W', [...root, name(entityOf(call.kind)), ident(call.itemId)])];
    case 'delete-item':
      return [slice('W', [...root, name(entityOf(call.kind)), ident(call.itemId), name('delete')])];
    case 'create-connector':
      return [slice('W', [...root, name('connector')])];
    case 'update-connector':
      return [slice('W', [...root, name('connector'), ident(call.connectorId)])];
    case 'delete-connector':
      return [slice('W', [...root, name('connector'), ident(call.connectorId), name('delete')])];
    case 'create-tag':
      return [slice('W', [...root, name('tag')])];
    case 'attach-tag':
    case 'remove-tag':
      return [
        slice('W', [
          ...root,
          name('item'),
          ident(call.itemId),
          name('tag-link'),
          ident(call.tagId),
        ]),
      ];
    case 'bulk-create':
      return [slice('W', [...root, name('item'), name('bulk-create')])];
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
