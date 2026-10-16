/**
 * The identifiers of the `miro` plugin, on both sides : the board ref and
 * its Miro spelling (ADR miro-board-ref-tilde-spelling), the item-like ids in
 * the request path, the tag id and the cursor in the query. A refused value
 * sends nothing ; an accepted one names exactly the classified board and item.
 */
import { describe, expect, test } from 'vitest';

import type { Resource } from '@vaubaan/plugin-sdk';
import { mockFetch, refusalText } from '@vaubaan/plugin-sdk/testing';

import { classifyMiro } from '../../src/classify.ts';
import { executeMiro } from '../../src/execute.ts';
import { boardRefOf, cursorOf, itemId, miroIdOf } from '../../src/identifiers.ts';
import { PROVIDER_ID, TOOL } from '../../src/identity.ts';
import { BOARD, BOARD_ID, BOARD_PATH, ITEM, TAG, context, workshop } from './fixtures.ts';

const HOSTILE = ['..', '.', 'a/../b', '%2e%2e', '..%2f', '%2f', '../x', '', 'x\ny', 'r1?x=1#y'];

describe('the board ref : the Miro id with its trailing = written ~', () => {
  test('round trip, one to one', () => {
    expect(boardRefOf('uXjVOD6LSME=')).toBe('uXjVOD6LSME~');
    expect(miroIdOf('uXjVOD6LSME~')).toBe('uXjVOD6LSME=');
    expect(boardRefOf('o9J_kzlUDmo=')).toBe('o9J_kzlUDmo~');
    expect(boardRefOf('abc_DEF-12==')).toBe('abc_DEF-12~~');
    expect(miroIdOf(boardRefOf('abc_DEF-12=='))).toBe('abc_DEF-12==');
    expect(boardRefOf('plain')).toBe('plain');
  });

  test('outside its grammar, neither direction answers', () => {
    for (const value of [
      'a+b=',
      'a/b=',
      'a~b=',
      'a=b',
      'abc===',
      '..',
      '',
      'x'.repeat(63),
      7,
      null,
    ]) {
      expect(boardRefOf(value), String(value)).toBeNull();
    }
    for (const value of ['a=b~', 'a~b', 'abc~~~', 'uXjVOD6LSME=', '..', '', 7]) {
      expect(miroIdOf(value), String(value)).toBeNull();
    }
  });

  test('the URL carries the Miro id, percent-encoded, of the board the slice names', async () => {
    const out = classifyMiro(TOOL.getBoard, { board: BOARD }, [workshop]);
    expect(out).toMatchObject({ slices: [{ path: [{}, { kind: 'ident', value: BOARD }] }] });
    const fetch = mockFetch([{ method: 'GET', url: BOARD_PATH, body: { id: BOARD_ID } }]);
    await executeMiro(context(fetch), TOOL.getBoard, { board: BOARD });
    expect(fetch.calls.map((c) => c.url)).toEqual([BOARD_PATH]);
  });

  test("a board given in Miro's spelling is refused with the ref to use, never converted", async () => {
    const expected = {
      denied: `board: '${BOARD_ID}' is Miro's spelling of a board id; name the board '${BOARD}' (as list_boards shows it)`,
    };
    expect(classifyMiro(TOOL.getBoard, { board: BOARD_ID }, [workshop])).toEqual(expected);
    const fetch = mockFetch([]);
    expect(await refusalText(executeMiro(context(fetch), TOOL.getBoard, { board: BOARD_ID }))).toBe(
      expected.denied,
    );
    expect(fetch.calls).toHaveLength(0);
  });

  test('a hostile board, as an argument or as a mission resource, sends nothing', async () => {
    for (const hostile of HOSTILE) {
      expect(classifyMiro(TOOL.getBoard, { board: hostile }, [workshop])).toEqual({
        denied: 'board: malformed board ref',
      });
      const odd: Resource = { provider: PROVIDER_ID, ref: hostile, displayName: 'Odd' };
      expect('denied' in classifyMiro(TOOL.getBoard, {}, [odd])).toBe(true);
      expect('denied' in classifyMiro(TOOL.listBoards, {}, [odd])).toBe(true);
      const fetch = mockFetch([]);
      const sent = await executeMiro(context(fetch), TOOL.getBoard, { board: hostile });
      expect(sent.isError).toBe(true);
      const alone = await executeMiro(context(fetch, [odd]), TOOL.listBoards, {});
      expect(alone.isError).toBe(true);
      expect(fetch.calls).toHaveLength(0);
    }
  });
});

describe('item-like ids : one path segment, digits only', () => {
  test('the grammar', () => {
    expect(itemId(ITEM)).toBe(ITEM);
    for (const value of [...HOSTILE, '12a', '1'.repeat(25), 3458764517517819000, null]) {
      expect(itemId(value), String(value)).toBeNull();
    }
  });

  test('`item_id` — a segment of the request path, refused before any request', async () => {
    for (const hostile of HOSTILE) {
      for (const tool of [TOOL.getItem, TOOL.deleteStickyNote, TOOL.listItemTags]) {
        const out = classifyMiro(tool, { board: BOARD, item_id: hostile }, [workshop]);
        expect('denied' in out, `${tool} ${JSON.stringify(hostile)}`).toBe(true);
        const fetch = mockFetch([]);
        const result = await executeMiro(context(fetch), tool, { board: BOARD, item_id: hostile });
        expect(result.isError).toBe(true);
        expect(fetch.calls).toHaveLength(0);
      }
    }
  });

  test('an accepted id names exactly the classified item', async () => {
    const fetch = mockFetch([{ method: 'GET', url: () => true, body: { id: ITEM, type: 'text' } }]);
    await executeMiro(context(fetch), TOOL.getItem, { board: BOARD, item_id: ITEM });
    expect(fetch.calls.map((c) => c.url)).toEqual([`${BOARD_PATH}/items/${ITEM}`]);
  });

  test('`tag_id` — the query string, refused when hostile', async () => {
    for (const hostile of HOSTILE) {
      const args = { board: BOARD, item_id: ITEM, tag_id: hostile };
      expect('denied' in classifyMiro(TOOL.attachTag, args, [workshop])).toBe(true);
      const fetch = mockFetch([]);
      expect((await executeMiro(context(fetch), TOOL.attachTag, args)).isError).toBe(true);
      expect(fetch.calls).toHaveLength(0);
    }
    const fetch = mockFetch([{ method: 'POST', url: () => true, status: 204 }]);
    await executeMiro(context(fetch), TOOL.attachTag, { board: BOARD, item_id: ITEM, tag_id: TAG });
    expect(fetch.calls[0]?.url).toBe(`${BOARD_PATH}/items/${ITEM}?tag_id=${TAG}`);
  });

  test('ids in a body (connector ends, parent frame) follow the same grammar', async () => {
    for (const hostile of HOSTILE) {
      const cases: [string, Record<string, unknown>][] = [
        [TOOL.createConnector, { board: BOARD, start_item_id: hostile, end_item_id: ITEM }],
        [TOOL.createStickyNote, { board: BOARD, parent_frame_id: hostile }],
        [
          TOOL.createItems,
          {
            board: BOARD,
            items: [{ type: 'text', data: { content: 'x' }, parent_frame_id: hostile }],
          },
        ],
      ];
      for (const [tool, args] of cases) {
        expect('denied' in classifyMiro(tool, args, [workshop]), tool).toBe(true);
        const fetch = mockFetch([]);
        expect((await executeMiro(context(fetch), tool, args)).isError).toBe(true);
        expect(fetch.calls).toHaveLength(0);
      }
    }
  });
});

describe('the cursor : query string only', () => {
  test('a delimiter, a line break or an escape is refused', async () => {
    for (const hostile of ['r1?x=1#y', 'x\ny', '%2f', 'a b', '', 'x'.repeat(513)]) {
      expect(cursorOf(hostile), JSON.stringify(hostile)).toBeNull();
      const args = { board: BOARD, cursor: hostile };
      expect('denied' in classifyMiro(TOOL.listItems, args, [workshop])).toBe(true);
      const fetch = mockFetch([]);
      expect((await executeMiro(context(fetch), TOOL.listItems, args)).isError).toBe(true);
      expect(fetch.calls).toHaveLength(0);
    }
  });

  test('an accepted cursor is encoded in the query, never in the path', async () => {
    const fetch = mockFetch([{ method: 'GET', url: () => true, body: { data: [] } }]);
    await executeMiro(context(fetch), TOOL.listItems, { board: BOARD, cursor: 'a/../b+=' });
    const url = new URL(fetch.calls[0]!.url);
    expect(url.pathname).toBe('/v2/boards/uXjVOD6LSME%3D/items');
    expect(url.searchParams.get('cursor')).toBe('a/../b+=');
  });
});

describe('review cases of 2026-10-16', () => {
  test('the ~ and = of a board spelling never pass on another id', async () => {
    const cases = (hostile: string): [string, Record<string, unknown>][] => [
      [TOOL.getItem, { board: BOARD, item_id: hostile }],
      [TOOL.deleteFrame, { board: BOARD, frame_id: hostile }],
      [TOOL.removeTag, { board: BOARD, item_id: ITEM, tag_id: hostile }],
    ];
    for (const hostile of ['123~', '123=', '~', '=', `${ITEM}~`]) {
      for (const [tool, args] of cases(hostile)) {
        expect('denied' in classifyMiro(tool, args, [workshop]), `${tool} ${hostile}`).toBe(true);
        const fetch = mockFetch([]);
        expect((await executeMiro(context(fetch), tool, args)).isError).toBe(true);
        expect(fetch.calls).toHaveLength(0);
      }
    }
  });

  test('a board mixing both spellings is refused', async () => {
    for (const hostile of ['abc~=', 'abc=~', 'a~b', 'abc~~~']) {
      expect(classifyMiro(TOOL.getBoard, { board: hostile }, [workshop])).toEqual({
        denied: 'board: malformed board ref',
      });
      const fetch = mockFetch([]);
      expect((await executeMiro(context(fetch), TOOL.getBoard, { board: hostile })).isError).toBe(
        true,
      );
      expect(fetch.calls).toHaveLength(0);
    }
  });

  test("a board in Miro's spelling the mission does not hold gets no hint", () => {
    expect(classifyMiro(TOOL.getBoard, { board: 'o9J_kzlUDmo=' }, [workshop])).toEqual({
      denied: 'board: malformed board ref',
    });
  });
});
