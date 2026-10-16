/**
 * `executeMiro`, `discoverMiroResources` and `verifyMiroToken` against
 * `mockFetch` : the requests sent (method, URL, headers, body), the type
 * check before an update or a deletion, the thrown failures, the declined
 * calls with nothing sent, the discovery's paging, ceiling and refusals.
 */
import { describe, expect, test, vi } from 'vitest';

import type { ConnectionContext, PluginLogger } from '@vaubaan/plugin-sdk';
import { mockFetch, refusalText, type MockRoute } from '@vaubaan/plugin-sdk/testing';

import { verifyMiroToken } from '../../src/credential.ts';
import {
  MAX_DISCOVERED_BOARDS,
  MIRO_API_BASE,
  MIRO_TOKEN_CONTEXT_URL,
  discoverMiroResources,
  executeMiro,
} from '../../src/execute.ts';
import { PROVIDER_ID, TOOL } from '../../src/identity.ts';
import miroPlugin from '../../src/index.ts';
import {
  BOARD,
  BOARD_ID,
  BOARD_PATH,
  CONNECTOR,
  FRAME,
  ITEM,
  ITEM_2,
  OTHER_BOARD,
  TAG,
  TOKEN,
  context,
  retro,
  workshop,
} from './fixtures.ts';

const itemIs = (type: string, id = ITEM): MockRoute => ({
  method: 'GET',
  url: `${BOARD_PATH}/items/${id}`,
  body: { id, type },
});

describe('requests', () => {
  test('a read sends the bearer and returns what Miro answered', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: BOARD_PATH, body: { id: BOARD_ID, name: 'W' } },
    ]);
    const result = await executeMiro(context(fetch), TOOL.getBoard, { board: BOARD });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      id: BOARD_ID,
      name: 'W',
    });
    expect(fetch.calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  test('list_boards reads each mission board, never the account listing', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: BOARD_PATH, body: { id: BOARD_ID } },
      {
        method: 'GET',
        url: `${MIRO_API_BASE}/boards/o9J_kzlUDmo%3D`,
        body: { id: 'o9J_kzlUDmo=' },
      },
    ]);
    const result = await executeMiro(context(fetch, [workshop, retro]), TOOL.listBoards, {});
    expect(fetch.calls.map((c) => c.url)).toEqual([
      BOARD_PATH,
      `${MIRO_API_BASE}/boards/o9J_kzlUDmo%3D`,
    ]);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual([
      { ref: BOARD, board: { id: BOARD_ID } },
      { ref: OTHER_BOARD, board: { id: 'o9J_kzlUDmo=' } },
    ]);
  });

  test('list_items : the query from the checked arguments, a frame as parent_item_id', async () => {
    const fetch = mockFetch([{ method: 'GET', url: () => true, body: { data: [] } }]);
    await executeMiro(context(fetch), TOOL.listItems, {
      board: BOARD,
      type: 'card',
      limit: 20,
      cursor: 'abc=',
      parent_frame_id: FRAME,
    });
    const url = new URL(fetch.calls[0]!.url);
    expect(url.pathname).toBe('/v2/boards/uXjVOD6LSME%3D/items');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: '20',
      cursor: 'abc=',
      type: 'card',
      parent_item_id: FRAME,
    });
  });

  test('create : the body built field by field, the parent written { id }', async () => {
    const fetch = mockFetch([
      { method: 'POST', url: `${BOARD_PATH}/sticky_notes`, status: 201, body: { id: ITEM } },
    ]);
    await executeMiro(context(fetch), TOOL.createStickyNote, {
      board: BOARD,
      data: { content: 'Idea', shape: 'square' },
      style: { fillColor: 'yellow' },
      position: { x: 10, y: -5 },
      geometry: { width: 200 },
      parent_frame_id: FRAME,
    });
    expect(fetch.calls[0]!.json).toEqual({
      data: { content: 'Idea', shape: 'square' },
      style: { fillColor: 'yellow' },
      position: { x: 10, y: -5 },
      geometry: { width: 200 },
      parent: { id: FRAME },
    });
    expect(fetch.calls[0]!.headers['content-type']).toBe('application/json');
  });

  test('each type has its endpoint', async () => {
    const cases: [string, string, Record<string, unknown>][] = [
      [TOOL.createShape, 'shapes', { data: { shape: 'circle' } }],
      [TOOL.createText, 'texts', { data: { content: 'T' } }],
      [TOOL.createCard, 'cards', { data: { title: 'C' } }],
      [TOOL.createFrame, 'frames', { data: { title: 'F' } }],
    ];
    for (const [tool, endpoint, args] of cases) {
      const fetch = mockFetch([{ method: 'POST', url: `${BOARD_PATH}/${endpoint}`, body: {} }]);
      await executeMiro(context(fetch), tool, { board: BOARD, ...args });
      expect(fetch.calls).toHaveLength(1);
    }
  });

  test('update : the type is read first, then the PATCH on the typed endpoint', async () => {
    const fetch = mockFetch([
      itemIs('card'),
      { method: 'PATCH', url: `${BOARD_PATH}/cards/${ITEM}`, respond: (c) => c.json },
    ]);
    await executeMiro(context(fetch), TOOL.updateCard, {
      board: BOARD,
      item_id: ITEM,
      data: { title: 'Done' },
      parent_frame_id: null,
    });
    expect(fetch.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${BOARD_PATH}/items/${ITEM}`,
      `PATCH ${BOARD_PATH}/cards/${ITEM}`,
    ]);
    expect(fetch.calls[1]!.json).toEqual({ data: { title: 'Done' }, parent: { id: null } });
  });

  test('delete : a 204 becomes a confirmation', async () => {
    const fetch = mockFetch([
      itemIs('frame', FRAME),
      { method: 'DELETE', url: `${BOARD_PATH}/frames/${FRAME}`, status: 204 },
    ]);
    const result = await executeMiro(context(fetch), TOOL.deleteFrame, {
      board: BOARD,
      frame_id: FRAME,
    });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      deleted: FRAME,
      type: 'frame',
    });
  });

  test('the type check : a frame id given to delete_sticky_note sends no DELETE', async () => {
    const fetch = mockFetch([itemIs('frame')]);
    const reason = await refusalText(
      executeMiro(context(fetch), TOOL.deleteStickyNote, { board: BOARD, item_id: ITEM }),
    );
    expect(reason).toBe(
      `item_id: item '${ITEM}' is a frame, not a sticky_note; nothing was changed. Use the tool for its type.`,
    );
    expect(fetch.calls.map((c) => c.method)).toEqual(['GET']);

    const odd = mockFetch([{ method: 'GET', url: () => true, body: { id: ITEM, type: 'A B<' } }]);
    expect(
      await refusalText(
        executeMiro(context(odd), TOOL.updateText, {
          board: BOARD,
          item_id: ITEM,
          data: { content: 'x' },
        }),
      ),
    ).toMatch(/is of no known type, not a text/);
    expect(odd.calls).toHaveLength(1);
  });

  test('connectors : startItem / endItem with snapTo, captions and style', async () => {
    const fetch = mockFetch([{ method: 'POST', url: `${BOARD_PATH}/connectors`, body: {} }]);
    await executeMiro(context(fetch), TOOL.createConnector, {
      board: BOARD,
      start_item_id: ITEM,
      end_item_id: ITEM_2,
      end_snap_to: 'left',
      shape: 'straight',
      captions: [{ content: 'yes', position: '50%' }],
      style: { strokeStyle: 'dashed' },
    });
    expect(fetch.calls[0]!.json).toEqual({
      startItem: { id: ITEM },
      endItem: { id: ITEM_2, snapTo: 'left' },
      shape: 'straight',
      captions: [{ content: 'yes', position: '50%' }],
      style: { strokeStyle: 'dashed' },
    });
    const patch = mockFetch([
      { method: 'PATCH', url: `${BOARD_PATH}/connectors/${CONNECTOR}`, body: {} },
    ]);
    await executeMiro(context(patch), TOOL.updateConnector, {
      board: BOARD,
      connector_id: CONNECTOR,
      end_item_id: ITEM_2,
    });
    expect(patch.calls[0]!.json).toEqual({ endItem: { id: ITEM_2 } });
    const gone = mockFetch([
      { method: 'DELETE', url: `${BOARD_PATH}/connectors/${CONNECTOR}`, status: 204 },
    ]);
    await executeMiro(context(gone), TOOL.deleteConnector, {
      board: BOARD,
      connector_id: CONNECTOR,
    });
    expect(gone.calls).toHaveLength(1);
  });

  test('tags : create, attach and remove', async () => {
    const fetch = mockFetch([
      { method: 'POST', url: `${BOARD_PATH}/tags`, body: { id: TAG } },
      { method: 'POST', url: `${BOARD_PATH}/items/${ITEM}?tag_id=${TAG}`, status: 204 },
      { method: 'DELETE', url: `${BOARD_PATH}/items/${ITEM}?tag_id=${TAG}`, status: 204 },
    ]);
    await executeMiro(context(fetch), TOOL.createTag, {
      board: BOARD,
      title: 'Urgent',
      fill_color: 'red',
    });
    expect(fetch.calls[0]!.json).toEqual({ title: 'Urgent', fillColor: 'red' });
    const attached = await executeMiro(context(fetch), TOOL.attachTag, {
      board: BOARD,
      item_id: ITEM,
      tag_id: TAG,
    });
    expect(JSON.parse((attached.content[0] as { text: string }).text)).toEqual({
      attached: TAG,
      item: ITEM,
    });
    await executeMiro(context(fetch), TOOL.removeTag, { board: BOARD, item_id: ITEM, tag_id: TAG });
    expect(fetch.calls).toHaveLength(3);
  });

  test('bulk : one POST, a list of { type, …body }', async () => {
    const fetch = mockFetch([
      { method: 'POST', url: `${BOARD_PATH}/items/bulk`, status: 201, body: { data: [] } },
    ]);
    await executeMiro(context(fetch), TOOL.createItems, {
      board: BOARD,
      items: [
        { type: 'sticky_note', data: { content: 'One' }, position: { x: 0, y: 0 } },
        { type: 'card', data: { title: 'Two' }, parent_frame_id: FRAME },
      ],
    });
    expect(fetch.calls[0]!.json).toEqual([
      { type: 'sticky_note', data: { content: 'One' }, position: { x: 0, y: 0 } },
      { type: 'card', data: { title: 'Two' }, parent: { id: FRAME } },
    ]);
  });
});

describe('failures', () => {
  test('401 and 403 are thrown as UpstreamAuthError, another status as UpstreamHttpError', async () => {
    for (const status of [401, 403]) {
      const fetch = mockFetch([{ url: () => true, status, body: { message: 'nope' } }]);
      await expect(
        executeMiro(context(fetch), TOOL.getBoard, { board: BOARD }),
      ).rejects.toMatchObject({
        name: 'UpstreamAuthError',
        upstreamStatus: status,
      });
    }
    const missing = mockFetch([
      { url: () => true, status: 404, body: { message: 'Invalid access' } },
    ]);
    await expect(
      executeMiro(context(missing), TOOL.getItem, { board: BOARD, item_id: ITEM }),
    ).rejects.toMatchObject({
      name: 'UpstreamHttpError',
      status: 404,
      message: expect.stringMatching(/Invalid access/) as unknown,
    });
  });

  test('a 429 names the reset Miro announced', async () => {
    const fetch = mockFetch([
      { url: () => true, status: 429, headers: { 'x-ratelimit-reset': '1760620000' }, body: {} },
    ]);
    await expect(
      executeMiro(context(fetch), TOOL.getBoard, { board: BOARD }),
    ).rejects.toMatchObject({
      name: 'UpstreamHttpError',
      status: 429,
      message: expect.stringMatching(/X-RateLimit-Reset 1760620000/) as unknown,
    });
  });

  test('a declined call is an isError result and sends nothing', async () => {
    const fetch = mockFetch([]);
    expect(
      await refusalText(executeMiro(context(fetch), TOOL.getBoard, { board: OTHER_BOARD })),
    ).toBe(`board '${OTHER_BOARD}' is not selected in this mission`);
    expect(
      await refusalText(
        executeMiro(context(fetch), TOOL.getItem, { board: BOARD, item_id: ITEM, extra: 1 }),
      ),
    ).toMatch(/^extra: not an argument/);
    expect(
      await refusalText(
        executeMiro(context(fetch), `${PROVIDER_ID}__delete_board`, { board: BOARD }),
      ),
    ).toMatch(/unknown miro tool/);
    expect(
      await refusalText(
        executeMiro(context(fetch), TOOL.createStickyNote, { board: BOARD, data: { html: '<b>' } }),
      ),
    ).toMatch(/^data\.html: not a field/);
    expect(fetch.calls).toHaveLength(0);
  });

  test('a credential without the token field is refused before any request', async () => {
    const fetch = mockFetch([]);
    const ctx = {
      ...context(fetch),
      credential: { kind: 'api-key' as const, fields: {}, metadata: {} },
    };
    await expect(executeMiro(ctx, TOOL.getBoard, { board: BOARD })).rejects.toThrow(/access_token/);
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('discovery', () => {
  const team = {
    team: { id: '3458764500000000000', name: 'Acme' },
    scopes: ['boards:read', 'boards:write'],
  };
  const boardsUrl = (offset: number) =>
    `${MIRO_API_BASE}/boards?team_id=3458764500000000000&limit=50&offset=${offset}`;
  const board = (id: string, name = id) => ({
    id,
    name,
    viewLink: `https://miro.com/app/board/${id}`,
  });

  function logger(): PluginLogger & { warn: ReturnType<typeof vi.fn> } {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  }

  test('the boards of the installed team, one resource each, ref with ~', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: MIRO_TOKEN_CONTEXT_URL, body: team },
      { method: 'GET', url: boardsUrl(0), body: { data: [board(BOARD_ID, 'Workshop')], total: 1 } },
    ]);
    expect(await discoverMiroResources(context(fetch))).toEqual([
      {
        provider: PROVIDER_ID,
        ref: BOARD,
        displayName: 'Workshop',
        metadata: {
          team_id: '3458764500000000000',
          view_link: `https://miro.com/app/board/${BOARD_ID}`,
        },
      },
    ]);
    expect(miroPlugin.discoverResources).toBe(discoverMiroResources);
  });

  test('pages until a short page ; a board id outside the grammar is skipped with a warning', async () => {
    const full = Array.from({ length: 50 }, (_, i) => board(`b${i}=`));
    const log = logger();
    const fetch = mockFetch([
      { method: 'GET', url: MIRO_TOKEN_CONTEXT_URL, body: team },
      { method: 'GET', url: boardsUrl(0), body: { data: full } },
      {
        method: 'GET',
        url: boardsUrl(50),
        body: { data: [board('a+b='), { id: 'last', name: 'Last', viewLink: 'javascript:x' }] },
      },
    ]);
    const ctx: ConnectionContext = { ...context(fetch), logger: log };
    const found = await discoverMiroResources(ctx);
    expect(found).toHaveLength(51);
    expect(found.at(-1)).toEqual({
      provider: PROVIDER_ID,
      ref: 'last',
      displayName: 'Last',
      metadata: { team_id: '3458764500000000000' },
    });
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/1 board\(s\) left out/), {
      skipped: 1,
    });
  });

  test('stops at the ceiling, with a warning', async () => {
    const log = logger();
    const page = (offset: number): MockRoute => ({
      method: 'GET',
      url: boardsUrl(offset),
      body: { data: Array.from({ length: 50 }, (_, i) => board(`b${offset + i}`)), total: 10_000 },
    });
    const fetch = mockFetch([
      { method: 'GET', url: MIRO_TOKEN_CONTEXT_URL, body: team },
      ...Array.from({ length: 11 }, (_, i) => page(i * 50)),
    ]);
    const found = await discoverMiroResources({ ...context(fetch), logger: log });
    expect(found).toHaveLength(MAX_DISCOVERED_BOARDS);
    expect(fetch.calls).toHaveLength(1 + MAX_DISCOVERED_BOARDS / 50);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/stopped at 500/), {
      ceiling: 500,
    });
  });

  test('a payload it does not recognise fails discovery', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: MIRO_TOKEN_CONTEXT_URL, body: team },
      { method: 'GET', url: boardsUrl(0), body: [{ id: 'x', name: 'y' }] },
    ]);
    await expect(discoverMiroResources(context(fetch))).rejects.toThrow(/unexpected board list/);
    const badTeam = mockFetch([
      {
        method: 'GET',
        url: MIRO_TOKEN_CONTEXT_URL,
        body: { team: { id: '../x', name: 'A' }, scopes: [] },
      },
    ]);
    await expect(discoverMiroResources(context(badTeam))).rejects.toThrow(/malformed team id/);
    const noTeam = mockFetch([
      { method: 'GET', url: MIRO_TOKEN_CONTEXT_URL, body: { scopes: [] } },
    ]);
    await expect(discoverMiroResources(context(noTeam))).rejects.toThrow(
      /unexpected token context/,
    );
  });
});

describe('verify', () => {
  test('the team names the account ; no expiry', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: MIRO_TOKEN_CONTEXT_URL,
        body: {
          type: 'oAuthToken',
          team: { id: '1', name: 'Acme' },
          scopes: ['boards:read', 'boards:write', 'identity:read'],
        },
      },
    ]);
    expect(await verifyMiroToken(context(fetch))).toEqual({
      account: 'Acme (Miro team)',
      expiresAt: null,
    });
    expect(miroPlugin.credential).toMatchObject({ verify: verifyMiroToken });
  });

  test('a missing scope is refused, naming it', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: MIRO_TOKEN_CONTEXT_URL,
        body: { team: { id: '1', name: 'Acme' }, scopes: ['boards:read'] },
      },
    ]);
    await expect(verifyMiroToken(context(fetch))).rejects.toMatchObject({
      name: 'UpstreamAuthError',
      upstreamStatus: 403,
      message: expect.stringMatching(/lacks the scope\(s\) boards:write/) as unknown,
    });
  });

  test('Miro\'s 400 "invalid token" and a 401 are a rejected credential', async () => {
    for (const status of [400, 401]) {
      const fetch = mockFetch([{ method: 'GET', url: MIRO_TOKEN_CONTEXT_URL, status, body: {} }]);
      await expect(verifyMiroToken(context(fetch))).rejects.toMatchObject({
        name: 'UpstreamAuthError',
        upstreamStatus: 401,
      });
    }
  });
});
