/**
 * Shared fixtures of the `miro` tests : two boards, an execution context, and
 * one realistic sample per tool (the coverage kit and the identifier proof
 * both run on them). Ids follow the shapes of Miro's documentation.
 */
import type { ExecuteContext, Resource } from '@vaubaan/plugin-sdk';
import type { MockFetch, ToolSamples } from '@vaubaan/plugin-sdk/testing';

import { ACCESS_TOKEN_FIELD, PROVIDER_ID, TOOL } from '../../src/identity.ts';

/** Miro's documented example board id, and its ref. */
export const BOARD_ID = 'uXjVOD6LSME=';
export const BOARD = 'uXjVOD6LSME~';
export const BOARD_PATH = 'https://api.miro.com/v2/boards/uXjVOD6LSME%3D';
export const OTHER_BOARD = 'o9J_kzlUDmo~';
export const ITEM = '3458764517517819000';
export const FRAME = '3458764517517819001';
export const CONNECTOR = '3458764517517819002';
export const TAG = '3074457363306854000';
export const ITEM_2 = '3458764517517819003';

export const workshop: Resource = { provider: PROVIDER_ID, ref: BOARD, displayName: 'Workshop' };
export const retro: Resource = { provider: PROVIDER_ID, ref: OTHER_BOARD, displayName: 'Retro' };

export const TOKEN = 'eyJtaXJvLm9yaWdpbiI6ImV1MDEifQ_token-1234567890';

export function context(
  fetch: MockFetch | typeof globalThis.fetch,
  resources: readonly Resource[] = [workshop],
): ExecuteContext {
  return {
    credential: { kind: 'api-key', fields: { [ACCESS_TOKEN_FIELD]: TOKEN }, metadata: {} },
    appConfig: {},
    fetch,
    resources,
  };
}

const note = { data: { content: 'Idea' }, style: { fillColor: 'yellow' } };

/** One table for the catalog coverage and the identifier proof. */
export const SAMPLES: ToolSamples = {
  [TOOL.listBoards]: [{ args: {} }, { args: {}, resources: [workshop, retro] }],
  [TOOL.getBoard]: [
    { args: { board: BOARD } },
    { args: { board: OTHER_BOARD }, expectDenied: true },
  ],
  [TOOL.listItems]: [
    {
      args: {
        board: BOARD,
        type: 'sticky_note',
        limit: 50,
        cursor: 'MzQ1ODc2NDUyMjQ5MDA4Mjg5NX4=',
      },
    },
    { args: { parent_frame_id: FRAME } },
  ],
  [TOOL.getItem]: [{ args: { board: BOARD, item_id: ITEM } }],
  [TOOL.listConnectors]: [{ args: { board: BOARD, limit: 10 } }],
  [TOOL.getConnector]: [{ args: { board: BOARD, connector_id: CONNECTOR } }],
  [TOOL.listTags]: [{ args: { board: BOARD, limit: 20, offset: 0 } }],
  [TOOL.listItemTags]: [{ args: { board: BOARD, item_id: ITEM } }],
  [TOOL.createStickyNote]: [
    { args: { board: BOARD, ...note, position: { x: 0, y: 0 }, parent_frame_id: FRAME } },
  ],
  [TOOL.updateStickyNote]: [{ args: { board: BOARD, item_id: ITEM, ...note } }],
  [TOOL.deleteStickyNote]: [{ args: { board: BOARD, item_id: ITEM } }],
  [TOOL.createShape]: [
    { args: { board: BOARD, data: { shape: 'circle', content: 'Q' }, geometry: { width: 100 } } },
  ],
  [TOOL.updateShape]: [{ args: { board: BOARD, item_id: ITEM, style: { borderWidth: '2' } } }],
  [TOOL.deleteShape]: [{ args: { board: BOARD, item_id: ITEM } }],
  [TOOL.createText]: [{ args: { board: BOARD, data: { content: 'Title' } } }],
  [TOOL.updateText]: [{ args: { board: BOARD, item_id: ITEM, data: { content: 'New' } } }],
  [TOOL.deleteText]: [{ args: { board: BOARD, item_id: ITEM } }],
  [TOOL.createCard]: [
    { args: { board: BOARD, data: { title: 'Task', dueDate: '2026-11-01T00:00:00Z' } } },
  ],
  [TOOL.updateCard]: [{ args: { board: BOARD, item_id: ITEM, data: { title: 'Done' } } }],
  [TOOL.deleteCard]: [{ args: { board: BOARD, item_id: ITEM } }],
  [TOOL.createFrame]: [{ args: { board: BOARD, data: { title: 'Sprint' } } }],
  [TOOL.updateFrame]: [{ args: { board: BOARD, frame_id: FRAME, geometry: { width: 800 } } }],
  [TOOL.deleteFrame]: [{ args: { board: BOARD, frame_id: FRAME } }],
  [TOOL.createConnector]: [
    { args: { board: BOARD, start_item_id: ITEM, end_item_id: ITEM_2, shape: 'elbowed' } },
    { args: { board: BOARD, start_item_id: ITEM, end_item_id: ITEM }, expectDenied: true },
  ],
  [TOOL.updateConnector]: [
    { args: { board: BOARD, connector_id: CONNECTOR, style: { strokeColor: '#000000' } } },
  ],
  [TOOL.deleteConnector]: [{ args: { board: BOARD, connector_id: CONNECTOR } }],
  [TOOL.createTag]: [{ args: { board: BOARD, title: 'Urgent', fill_color: 'red' } }],
  [TOOL.attachTag]: [{ args: { board: BOARD, item_id: ITEM, tag_id: TAG } }],
  [TOOL.removeTag]: [{ args: { board: BOARD, item_id: ITEM, tag_id: TAG } }],
  [TOOL.createItems]: [
    {
      args: {
        board: BOARD,
        items: [
          { type: 'sticky_note', data: { content: 'One' } },
          { type: 'card', data: { title: 'Two' }, parent_frame_id: FRAME },
        ],
      },
    },
  ],
};
