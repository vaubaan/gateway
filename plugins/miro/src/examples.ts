/**
 * Representative calls of every tool of the `miro` service
 * (`ServicePlugin.examples`) : the samples the plugin's tests run through the
 * kit (catalog coverage, identifier proof) and the site classifies when it
 * builds (ADR plugin-contract-and-credential-spec, amendment 2026-11-05). Ids
 * follow the shapes of Miro's documentation.
 */
import { samplesOn, type Resource, type ToolSamples } from '@vaubaan/plugin-sdk';

import { SERVICE_ID, TOOL } from './identity.ts';

/** Miro's documented example board id, and its ref. */
export const BOARD_ID = 'uXjVOD6LSME=';
export const BOARD = 'uXjVOD6LSME~';
export const BOARD_URL = 'https://miro.com/app/board/uXjVOD6LSME=/';
export const OTHER_BOARD = 'o9J_kzlUDmo~';
export const ITEM = '3458764517517819000';
export const COMMENT = '3458764517517819777';

/** The board the samples run on unless they name others. */
export const EXAMPLE_BOARD: Resource = {
  service: SERVICE_ID,
  ref: BOARD,
  displayName: 'Workshop',
  metadata: { url: BOARD_URL },
};
export const EXAMPLE_OTHER_BOARD: Resource = {
  service: SERVICE_ID,
  ref: OTHER_BOARD,
  displayName: 'Retro',
};

const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';

export const miroExamples: ToolSamples = samplesOn([EXAMPLE_BOARD], {
  [TOOL.listBoards]: [{ args: {} }, { args: {}, resources: [EXAMPLE_BOARD, EXAMPLE_OTHER_BOARD] }],
  [TOOL.boardCreate]: [{ args: { name: 'Retro 2026-11', description: 'Sprint retro' } }],
  [TOOL.canvasSearch]: [
    { args: { board: BOARD, result_mode: 'matches', patterns: ['pricing'] } },
    { args: { board: OTHER_BOARD, result_mode: 'overview' }, expectDenied: true },
  ],
  [TOOL.canvasReadAsSvg]: [{ args: { board: BOARD_URL, item_id: ITEM, widget_ids: [ITEM] } }],
  [TOOL.canvasCreateFromSvg]: [{ args: { board: BOARD, svg } }],
  [TOOL.canvasUpdateFromSvg]: [{ args: { board: BOARD, item_id: ITEM, svg } }],
  [TOOL.canvasComposerSkill]: [{ args: {} }],
  [TOOL.canvasFormatSkill]: [{ args: { format_name: 'diagramming', notation: 'flowchart' } }],
  [TOOL.commentListComments]: [{ args: { board: BOARD, resolved: false, limit: 20 } }],
  [TOOL.commentCreate]: [
    { args: { board: BOARD, item_id: ITEM, content: 'Looks good', x: 0, y: 0 } },
  ],
  [TOOL.commentReply]: [{ args: { board: BOARD, comment_id: COMMENT, content: 'Agreed' } }],
  [TOOL.commentResolve]: [{ args: { board: BOARD, comment_id: COMMENT, resolved: true } }],
  [TOOL.imageGetData]: [{ args: { board: BOARD, item_id: ITEM } }],
  [TOOL.imageGetUrl]: [{ args: { board: BOARD, item_id: ITEM } }],
  [TOOL.imageCreate]: [
    { args: { board: BOARD, image_url: 'https://example.com/logo.png', title: 'Logo' } },
  ],
  [TOOL.prototypeRead]: [{ args: { board: BOARD } }],
  [TOOL.prototypeCreate]: [
    { args: { board: BOARD, html_contents: ['<p>Home</p>'], device_type: 'mobile' } },
  ],
  [TOOL.tableCreate]: [
    {
      args: {
        board: BOARD,
        table_title: 'Backlog',
        columns: [{ column_type: 'text', column_title: 'Task' }],
      },
    },
  ],
  [TOOL.tableListRows]: [
    { args: { board: BOARD, item_id: ITEM, filter_by: '{"Status": ["Open"]}', limit: 50 } },
  ],
  [TOOL.tableSyncRows]: [
    {
      args: {
        board: BOARD,
        item_id: ITEM,
        rows: [{ cells: [{ columnTitle: 'Task', value: 'Ship' }] }],
      },
    },
  ],
  [TOOL.tableUpdateHistory]: [{ args: { board: BOARD, item_id: ITEM, row_id: '3' } }],
  [TOOL.tableUpdateView]: [
    { args: { board: BOARD, item_id: ITEM, layout: 'kanban', group_by_column: 'Status' } },
  ],
  [TOOL.boardGetSpace]: [{ args: { board: BOARD } }],
  [TOOL.boardUpdateMetadata]: [{ args: { board: BOARD, title: 'Workshop — final' } }],
  [TOOL.contentItemListRoles]: [{ args: { board: BOARD, limit: 50 } }],
  [TOOL.boardShare]: [
    {
      args: {
        board: BOARD,
        subject_id: 'ada@example.com',
        subject_type: 'user',
        role: 'viewer',
      },
    },
  ],
  [TOOL.boardRoleUpdate]: [
    {
      args: {
        board: BOARD,
        subject_id: '3074457350000000000',
        subject_type: 'user',
        role: 'editor',
      },
    },
  ],
  [TOOL.createBoardcast]: [
    { args: { board: BOARD, screens: [{ x: 0, y: 0, text: 'Here is the plan.' }] } },
  ],
});
