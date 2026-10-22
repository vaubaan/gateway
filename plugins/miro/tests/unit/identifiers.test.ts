/**
 * The identifier grammars of the `miro` provider, and the proof that the
 * board URL sent to Miro is the gateway's : built from the classified ref and
 * item, whatever the agent wrote.
 */
import { describe, expect, test } from 'vitest';

import { mockFetch, refusalText } from '@vaubaan/plugin-sdk/testing';

import { classifyMiro } from '../../src/classify.ts';
import { executeMiro } from '../../src/execute.ts';
import {
  boardIdOfUrl,
  boardOf,
  boardRefOf,
  boardUrlOf,
  commentId,
  itemId,
  miroIdOf,
} from '../../src/identifiers.ts';
import { TOOL } from '../../src/identity.ts';
import {
  BOARD,
  BOARD_ID,
  BOARD_URL,
  ITEM,
  context,
  mcpRoute,
  rpcOf,
  textResult,
  workshop,
} from './fixtures.ts';

describe('grammars', () => {
  test('the ref spelling of a board id is one to one', () => {
    expect(boardRefOf(BOARD_ID)).toBe(BOARD);
    expect(miroIdOf(BOARD)).toBe(BOARD_ID);
    expect(boardRefOf('uXjV/OD6=')).toBeNull();
    expect(miroIdOf('uXjV~OD6')).toBeNull();
  });

  test('a board URL : https, miro.com, the path of a board, nothing else', () => {
    expect(boardIdOfUrl(BOARD_URL)).toBe(BOARD_ID);
    expect(boardIdOfUrl(`${BOARD_URL}?moveToWidget=${ITEM}`)).toBe(BOARD_ID);
    expect(boardIdOfUrl('https://miro.com/app/board/uXjVOD6LSME=')).toBe(BOARD_ID);
    expect(boardIdOfUrl('https://www.miro.com/app/board/uXjVOD6LSME=/')).toBeNull();
    expect(boardIdOfUrl('https://miro.com/app/board/uXjVOD6LSME%3D/')).toBeNull();
    expect(boardIdOfUrl('https://miro.com/app/board/')).toBeNull();
    expect(boardIdOfUrl('not a url')).toBeNull();
    expect(boardOf(BOARD)).toBe(BOARD);
    expect(boardOf(BOARD_URL)).toBe(BOARD);
  });

  test('items are numeric strings ; comments a closed set of characters', () => {
    expect(itemId(ITEM)).toBe(ITEM);
    expect(itemId(3458764517517819)).toBeNull();
    expect(itemId('12a')).toBeNull();
    expect(commentId('abc_DEF-1')).toBe('abc_DEF-1');
    expect(commentId('a b')).toBeNull();
    expect(commentId('a/b')).toBeNull();
  });

  test('the URL the gateway writes', () => {
    expect(boardUrlOf(BOARD, null)).toBe(BOARD_URL);
    expect(boardUrlOf(BOARD, ITEM)).toBe(`${BOARD_URL}?moveToWidget=${ITEM}`);
    expect(() => boardUrlOf('../x', null)).toThrow();
  });
});

describe('`board` and `item_id` — what classify refuses, execute does not send, and the URL sent is the gateway’s', () => {
  test('a refused board or item sends nothing', async () => {
    for (const args of [
      { board: 'https://miro.com.evil.example/app/board/uXjVOD6LSME=/' },
      { board: 'https://miro.com/app/board/%2e%2e/' },
      { board: 'https://miro.com/app/board/../uXjVOD6LSME=/' },
      { board: 'o9J_kzlUDmo~' },
      { board: '..' },
      { board: BOARD, item_id: `${ITEM}&focusWidget=1` },
      { board: BOARD, item_id: '..' },
      { board: BOARD, item_id: '%2f' },
    ]) {
      expect('denied' in classifyMiro(TOOL.canvasReadAsSvg, args, [workshop])).toBe(true);
      const fetch = mockFetch([mcpRoute(() => textResult('ok'))]);
      const text = await refusalText(executeMiro(context(fetch), TOOL.canvasReadAsSvg, args));
      expect(text.length, JSON.stringify(args)).toBeGreaterThan(0);
      expect(fetch.calls, JSON.stringify(args)).toHaveLength(0);
    }
  });

  test('a board given as a URL with its own query reaches Miro as the bare board URL and the classified item', async () => {
    const fetch = mockFetch([mcpRoute(() => textResult('ok'))]);
    await executeMiro(context(fetch), TOOL.canvasReadAsSvg, {
      board: `${BOARD_URL}?moveToWidget=999&share_link_id=x`,
      item_id: ITEM,
    });
    const [call] = fetch.calls;
    expect(rpcOf(call!).params?.arguments).toEqual({
      miro_url: `${BOARD_URL}?moveToWidget=${ITEM}`,
    });
  });
});
