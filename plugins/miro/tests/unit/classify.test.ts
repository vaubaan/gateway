/**
 * The classifier of the `miro` provider : the slices of every tool, and
 * every refusal `readMiroCall` makes before a slice is written.
 */
import { describe, expect, test } from 'vitest';

import { serializeSlice } from '@vaubaan/plugin-sdk';

import { classifyMiro } from '../../src/classify.ts';
import { TOOL } from '../../src/identity.ts';
import {
  BOARD,
  BOARD_URL,
  COMMENT,
  ITEM,
  OTHER_BOARD,
  SAMPLES,
  retro,
  workshop,
} from './fixtures.ts';

function slicesOf(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources = [workshop],
): string[] {
  const out = classifyMiro(tool, args, resources);
  if ('denied' in out) throw new Error(out.denied);
  return out.slices.map(serializeSlice);
}

function denial(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources = [workshop],
): string {
  const out = classifyMiro(tool, args, resources);
  if (!('denied' in out)) throw new Error(`expected a denial, got ${JSON.stringify(out)}`);
  return out.denied;
}

describe('slices, tool by tool', () => {
  test('list_boards names the boards of the mission, as a list when there are several', () => {
    expect(slicesOf(TOOL.listBoards, {})).toEqual([`miro.board[${BOARD}].R`]);
    expect(slicesOf(TOOL.listBoards, {}, [workshop, retro])).toEqual([
      `miro.board[${BOARD},${OTHER_BOARD}].R`,
    ]);
  });

  test('reads under the board, on the item when one is named', () => {
    expect(slicesOf(TOOL.canvasSearch, { board: BOARD, query: 'x' })).toEqual([
      `miro.board[${BOARD}].item[*].R`,
    ]);
    expect(slicesOf(TOOL.canvasReadAsSvg, { board: BOARD, item_id: ITEM })).toEqual([
      `miro.board[${BOARD}].item[${ITEM}].R`,
    ]);
    for (const tool of [
      TOOL.imageGetData,
      TOOL.imageGetUrl,
      TOOL.tableListRows,
      TOOL.tableUpdateHistory,
    ]) {
      expect(slicesOf(tool, { board: BOARD, item_id: ITEM }), tool).toEqual([
        `miro.board[${BOARD}].item[${ITEM}].R`,
      ]);
    }
    expect(slicesOf(TOOL.commentListComments, { board: BOARD })).toEqual([
      `miro.board[${BOARD}].comment[*].R`,
    ]);
  });

  test('a board named by its URL is the same board', () => {
    expect(slicesOf(TOOL.prototypeRead, { board: BOARD_URL })).toEqual(
      slicesOf(TOOL.prototypeRead, { board: BOARD }),
    );
    expect(
      slicesOf(TOOL.prototypeRead, { board: `${BOARD_URL}?moveToWidget=${ITEM}&cot=14` }),
    ).toEqual([`miro.board[${BOARD}].item[*].R`]);
  });

  test('creating many items at once is a write and a bulk creation', () => {
    for (const tool of [TOOL.canvasCreateFromSvg, TOOL.prototypeCreate]) {
      const [sample] = SAMPLES[tool] ?? [];
      expect(slicesOf(tool, sample?.args ?? {}), tool).toEqual([
        `miro.board[${BOARD}].item.W`,
        `miro.board[${BOARD}].item.bulk-create.W`,
      ]);
    }
  });

  test('an update of the canvas may delete items and frames : both, on every call', () => {
    expect(slicesOf(TOOL.canvasUpdateFromSvg, { board: BOARD, svg: '<svg/>' })).toEqual([
      `miro.board[${BOARD}].item[*].W`,
      `miro.board[${BOARD}].item[*].delete.W`,
      `miro.board[${BOARD}].frame[*].delete.W`,
    ]);
    expect(
      slicesOf(TOOL.canvasUpdateFromSvg, { board: BOARD, item_id: ITEM, svg: '<svg/>' })[0],
    ).toBe(`miro.board[${BOARD}].item[${ITEM}].W`);
  });

  test('single creations, table edits and comments', () => {
    expect(slicesOf(TOOL.imageCreate, { board: BOARD, image_url: 'https://e.com/a.png' })).toEqual([
      `miro.board[${BOARD}].item.W`,
    ]);
    expect(slicesOf(TOOL.tableCreate, { board: BOARD, columns: [] })).toEqual([
      `miro.board[${BOARD}].item.W`,
    ]);
    expect(slicesOf(TOOL.tableSyncRows, { board: BOARD, item_id: ITEM, rows: [] })).toEqual([
      `miro.board[${BOARD}].item[${ITEM}].W`,
    ]);
    expect(slicesOf(TOOL.commentCreate, { board: BOARD, content: 'Hi' })).toEqual([
      `miro.board[${BOARD}].comment.W`,
    ]);
    expect(slicesOf(TOOL.commentResolve, { board: BOARD, comment_id: COMMENT })).toEqual([
      `miro.board[${BOARD}].comment[${COMMENT}].W`,
    ]);
  });

  test('a new board and the format guides name no board', () => {
    expect(slicesOf(TOOL.boardCreate, { name: 'New' }, [])).toEqual(['miro.board.W']);
    expect(slicesOf(TOOL.canvasComposerSkill, {}, [])).toEqual(['miro.format-guide.R']);
    expect(slicesOf(TOOL.canvasFormatSkill, { format: 'kanban' }, [])).toEqual([
      'miro.format-guide.R',
    ]);
  });
});

describe('refusals', () => {
  test('an unknown tool, and the tools left out of the plugin', () => {
    expect(denial('miro__delete_board', {})).toMatch(/unknown tool/);
    expect(denial('miro__board_search_boards', {})).toMatch(/unknown tool/);
    expect(denial('miro__image_get_upload_url', {})).toMatch(/unknown tool/);
    expect(denial('miro__user_who_am_i', {})).toMatch(/unknown tool/);
  });

  test('an argument the schema does not declare — miro_url above all : the gateway writes it', () => {
    expect(
      denial(TOOL.canvasReadAsSvg, {
        board: BOARD,
        miro_url: 'https://miro.com/app/board/o9J_kzlUDmo=/',
      }),
    ).toMatch(/miro_url: not an argument/);
    expect(denial(TOOL.canvasSearch, { board: BOARD, team_id: '1' })).toMatch(/team_id/);
  });

  test('a board outside the mission, or not a board at all', () => {
    expect(denial(TOOL.canvasSearch, { board: OTHER_BOARD })).toMatch(
      /not a board of this mission/,
    );
    expect(denial(TOOL.canvasSearch, {})).toMatch(/expected a board ref/);
    for (const hostile of [
      'uXjVOD6LSME=',
      'https://miro.com.evil.example/app/board/uXjVOD6LSME=/',
      'http://miro.com/app/board/uXjVOD6LSME=/',
      'https://user@miro.com/app/board/uXjVOD6LSME=/',
      'https://miro.com:444/app/board/uXjVOD6LSME=/',
      'https://miro.com/app/board/uXjVOD6LSME=/extra',
      'https://miro.com/app/board/../uXjVOD6LSME=/',
      '*',
      42,
    ]) {
      expect(denial(TOOL.canvasSearch, { board: hostile }), String(hostile)).toMatch(
        /expected a board ref/,
      );
    }
  });

  test('item and comment ids pass their grammar ; a required item is required', () => {
    expect(denial(TOOL.imageGetUrl, { board: BOARD })).toMatch(/item_id: required/);
    expect(denial(TOOL.imageGetUrl, { board: BOARD, item_id: 3458764517517819000 })).toMatch(
      /numeric Miro item id/,
    );
    expect(denial(TOOL.imageGetUrl, { board: BOARD, item_id: '1&focusWidget=2' })).toMatch(
      /numeric Miro item id/,
    );
    expect(denial(TOOL.commentReply, { board: BOARD, comment_id: '../x', content: 'a' })).toMatch(
      /comment_id/,
    );
  });

  test("Miro's own arguments : required ones, and their JSON type", () => {
    expect(denial(TOOL.canvasCreateFromSvg, { board: BOARD })).toMatch(/svg: required/);
    expect(denial(TOOL.canvasCreateFromSvg, { board: BOARD, svg: 3 })).toMatch(
      /svg: expected string/,
    );
    expect(denial(TOOL.tableSyncRows, { board: BOARD, item_id: ITEM, rows: {} })).toMatch(
      /rows: expected array/,
    );
    expect(
      denial(TOOL.commentResolve, { board: BOARD, comment_id: COMMENT, resolved: 'yes' }),
    ).toMatch(/resolved: expected boolean/);
  });

  test('list_boards with no board in the mission', () => {
    expect(denial(TOOL.listBoards, {}, [])).toMatch(/no Miro board/);
  });
});
