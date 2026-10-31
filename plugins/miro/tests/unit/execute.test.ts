/**
 * The executor and the discovery of the `miro` provider, against a mock of
 * Miro's MCP server : what is sent, what is passed back, how a failure is
 * thrown, how boards are found in an answer whose shape Miro does not
 * document.
 */
import { describe, expect, test, vi } from 'vitest';

import {
  CredentialRefusal,
  UpstreamAuthError,
  UpstreamHttpError,
  UpstreamProtocolError,
} from '@vaubaan/plugin-sdk';
import { mockFetch } from '@vaubaan/plugin-sdk/testing';

import {
  DISCOVERY_PAGE_SIZE,
  MCP_SERVER_REFUSED,
  boardsIn,
  discoverMiroResources,
  executeMiro,
  hasMore,
  toolDrift,
} from '../../src/execute.ts';
import { MIRO_MCP_URL, TOOL } from '../../src/identity.ts';
import { UPSTREAM_TOOL_LIST } from '../../src/tools.ts';
import {
  BOARD,
  BOARD_ID,
  BOARD_URL,
  ITEM,
  TOKEN,
  context,
  mcpRoute,
  retro,
  rpcOf,
  textResult,
  workshop,
} from './fixtures.ts';

describe('execute — one tools/call to Miro’s MCP server', () => {
  test('the upstream name, the declared arguments, miro_url written by the gateway, the bearer token', async () => {
    const fetch = mockFetch([mcpRoute(() => textResult('<svg/>'))]);
    const result = await executeMiro(context(fetch), TOOL.canvasUpdateFromSvg, {
      board: BOARD,
      item_id: ITEM,
      svg: '<svg/>',
    });
    expect(result).toEqual(textResult('<svg/>'));
    expect(fetch.calls).toHaveLength(1);
    const [call] = fetch.calls;
    expect(call?.url).toBe(MIRO_MCP_URL);
    expect(call?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(rpcOf(call!)).toMatchObject({
      method: 'tools/call',
      params: {
        name: 'canvas_update_from_svg',
        arguments: { svg: '<svg/>', miro_url: `${BOARD_URL}?moveToWidget=${ITEM}` },
      },
    });
  });

  test('a tool without a board sends no miro_url', async () => {
    const fetch = mockFetch([mcpRoute(() => textResult('board created'))]);
    await executeMiro(context(fetch, []), TOOL.boardCreate, { name: 'Retro' });
    expect(rpcOf(fetch.calls[0]!).params?.arguments).toEqual({ name: 'Retro' });
    await executeMiro(context(fetch, [workshop]), TOOL.canvasComposerSkill, {});
    expect(rpcOf(fetch.calls[1]!).params?.arguments).toEqual({});
  });

  test('a tool whose locator has another name gets the board there : content_item_url', async () => {
    const fetch = mockFetch([mcpRoute(() => textResult('{"entries":[],"has_more":false}'))]);
    await executeMiro(context(fetch), TOOL.contentItemListRoles, { board: BOARD, limit: 10 });
    expect(rpcOf(fetch.calls[0]!).params).toEqual({
      name: 'content_item_list_roles',
      arguments: { limit: 10, content_item_url: BOARD_URL },
    });
  });

  test("Miro's own arguments go as written ; its telemetry fields never leave", async () => {
    const fetch = mockFetch([mcpRoute(() => textResult('ok'))]);
    await executeMiro(context(fetch), TOOL.prototypeCreate, {
      board: BOARD,
      html_contents: ['<p>Home</p>'],
      device_type: 'mobile',
      x: 10,
    });
    const sent = rpcOf(fetch.calls[0]!).params?.arguments ?? {};
    expect(sent).toEqual({
      html_contents: ['<p>Home</p>'],
      device_type: 'mobile',
      x: 10,
      miro_url: BOARD_URL,
    });
    expect(sent).not.toHaveProperty('invocation_source');
    expect(sent).not.toHaveProperty('is_repository');
    const refused = await executeMiro(context(fetch), TOOL.prototypeCreate, {
      board: BOARD,
      html_contents: ['<p/>'],
      is_repository: true,
    });
    expect(refused.isError).toBe(true);
    expect(fetch.calls).toHaveLength(1);
  });

  test('an SSE answer is read ; Miro’s isError, images and structured content pass through', async () => {
    const fetch = mockFetch([
      mcpRoute(
        () => ({
          content: [
            { type: 'text', text: 'partly failed' },
            { type: 'image', data: 'aGk=', mimeType: 'image/png' },
            { type: 'audio', data: 'x' },
          ],
          structuredContent: { ok: false },
          isError: true,
        }),
        { sse: true },
      ),
    ]);
    const result = await executeMiro(context(fetch), TOOL.imageGetData, {
      board: BOARD,
      item_id: ITEM,
    });
    expect(result).toEqual({
      content: [
        { type: 'text', text: 'partly failed' },
        { type: 'image', data: 'aGk=', mimeType: 'image/png' },
        { type: 'text', text: '{"type":"audio","data":"x"}' },
      ],
      structuredContent: { ok: false },
      isError: true,
    });
  });

  test('list_boards is answered from the mission, without a request', async () => {
    const fetch = mockFetch([]);
    const result = await executeMiro(context(fetch, [workshop, retro]), TOOL.listBoards, {});
    expect(fetch.calls).toHaveLength(0);
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(JSON.parse(text)).toEqual({
      boards: [
        { board: BOARD, name: 'Workshop', url: BOARD_URL },
        { board: retro.ref, name: 'Retro', url: 'https://miro.com/app/board/o9J_kzlUDmo=/' },
      ],
    });
  });

  test('401 and 403 are a rejected credential ; another status an HTTP failure ; an error frame a protocol failure with Miro’s text', async () => {
    for (const status of [401, 403]) {
      const fetch = mockFetch([{ url: MIRO_MCP_URL, status, body: { error: 'nope' } }]);
      await expect(
        executeMiro(context(fetch), TOOL.prototypeRead, { board: BOARD }),
      ).rejects.toBeInstanceOf(UpstreamAuthError);
    }
    const down = mockFetch([{ url: MIRO_MCP_URL, status: 503, body: 'down' }]);
    await expect(
      executeMiro(context(down), TOOL.prototypeRead, { board: BOARD }),
    ).rejects.toBeInstanceOf(UpstreamHttpError);
    const frame = mockFetch([
      {
        url: MIRO_MCP_URL,
        respond: (call) => ({
          jsonrpc: '2.0',
          id: rpcOf(call).id,
          error: { code: -32602, message: 'Invalid params: svg' },
        }),
      },
    ]);
    // A provider failure for the host (HTTP 502), Miro's words for the agent.
    const failure = executeMiro(context(frame), TOOL.prototypeRead, { board: BOARD });
    await expect(failure).rejects.toBeInstanceOf(UpstreamProtocolError);
    await expect(failure).rejects.toThrow(/Invalid params: svg/);
  });

  test('a server that wants a session : initialize once, then the call again with its session id', async () => {
    const fetch = mockFetch([
      { url: MIRO_MCP_URL, status: 400, body: { error: 'no session' }, times: 1 },
      {
        url: MIRO_MCP_URL,
        times: 1,
        headers: { 'mcp-session-id': 'session-1' },
        respond: (call) => ({
          jsonrpc: '2.0',
          id: rpcOf(call).id,
          result: { protocolVersion: '2025-06-18' },
        }),
      },
      { url: MIRO_MCP_URL, status: 202, body: '', times: 1 },
      mcpRoute(() => textResult('ok')),
    ]);
    const result = await executeMiro(context(fetch), TOOL.prototypeRead, { board: BOARD });
    expect(result).toEqual(textResult('ok'));
    expect(fetch.calls.map((c) => rpcOf(c).method)).toEqual([
      'tools/call',
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    expect(fetch.calls[3]?.headers['mcp-session-id']).toBe('session-1');
  });
});

describe('discovery — the boards of the team, from board_search_boards', () => {
  const tools = { tools: UPSTREAM_TOOL_LIST.tools };

  function discoveryFetch(answer: unknown) {
    return mockFetch([mcpRoute((call) => (rpcOf(call).method === 'tools/list' ? tools : answer))]);
  }

  test('Miro refusing the search is its failure, typed : a protocol error with its words', async () => {
    const fetch = discoveryFetch({
      content: [{ type: 'text', text: 'rate limited' }],
      isError: true,
    });
    const discovery = discoverMiroResources(context(fetch));
    await expect(discovery).rejects.toBeInstanceOf(UpstreamProtocolError);
    await expect(discovery).rejects.toThrow(
      'Miro MCP server, tool board_search_boards failed: rate limited',
    );
  });

  test('boards described as JSON objects, owners and items ignored', async () => {
    const fetch = discoveryFetch(
      textResult(
        JSON.stringify({
          data: [
            {
              id: BOARD_ID,
              type: 'board',
              name: 'Workshop',
              owner: { id: '3074457350000000000', name: 'Ada' },
            },
            {
              id: 'o9J_kzlUDmo=',
              name: 'Retro',
              viewLink: 'https://miro.com/app/board/o9J_kzlUDmo=/',
            },
            { id: 'notABoard12', name: 'Item', viewLink: 'https://miro.com/app/board/other=/' },
          ],
        }),
      ),
    );
    const boards = await discoverMiroResources(context(fetch));
    expect(boards).toEqual([
      { provider: 'miro', ref: BOARD, displayName: 'Workshop', metadata: { url: BOARD_URL } },
      {
        provider: 'miro',
        ref: 'o9J_kzlUDmo~',
        displayName: 'Retro',
        metadata: { url: 'https://miro.com/app/board/o9J_kzlUDmo=/' },
      },
    ]);
    expect(rpcOf(fetch.calls[0]!).params).toEqual({
      name: 'board_search_boards',
      arguments: { limit: DISCOVERY_PAGE_SIZE, offset: 0 },
    });
    expect(fetch.calls.filter((c) => rpcOf(c).method === 'tools/call')).toHaveLength(1);
  });

  test("Miro's captured shape : board summaries without an id, page after page while has_more", async () => {
    const page = (offset: number) => {
      const boards =
        offset === 0
          ? [
              {
                name: 'Workshop',
                miro_url: 'https://miro.com/app/board/uXjVOD6LSME=',
                owner: 'Ada',
              },
              { name: 'Item link', miro_url: `${BOARD_URL}?moveToWidget=${ITEM}` },
            ]
          : [{ name: 'Retro', miro_url: 'https://miro.com/app/board/o9J_kzlUDmo=/' }];
      const body = { data: boards, total: 2, has_more: offset === 0 };
      return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body };
    };
    const fetch = mockFetch([
      mcpRoute((call) => {
        const rpc = rpcOf(call);
        if (rpc.method === 'tools/list') return { tools: UPSTREAM_TOOL_LIST.tools };
        return page(Number(rpc.params?.arguments?.offset ?? 0));
      }),
    ]);
    const boards = await discoverMiroResources(context(fetch));
    expect(boards).toEqual([
      { provider: 'miro', ref: BOARD, displayName: 'Workshop', metadata: { url: BOARD_URL } },
      {
        provider: 'miro',
        ref: 'o9J_kzlUDmo~',
        displayName: 'Retro',
        metadata: { url: 'https://miro.com/app/board/o9J_kzlUDmo=/' },
      },
    ]);
    const searches = fetch.calls.filter((c) => rpcOf(c).method === 'tools/call');
    expect(searches.map((c) => rpcOf(c).params?.arguments)).toEqual([
      { limit: 50, offset: 0 },
      { limit: 50, offset: 50 },
    ]);
  });

  test('a server that ignores offset is not asked again for the same page', async () => {
    const body = { data: [{ name: 'Workshop', miro_url: BOARD_URL }], total: 99, has_more: true };
    const fetch = mockFetch([
      mcpRoute((call) =>
        rpcOf(call).method === 'tools/list'
          ? { tools: UPSTREAM_TOOL_LIST.tools }
          : { content: [{ type: 'text', text: JSON.stringify(body) }] },
      ),
    ]);
    expect(await discoverMiroResources(context(fetch))).toHaveLength(1);
    expect(fetch.calls.filter((c) => rpcOf(c).method === 'tools/call')).toHaveLength(2);
    expect(hasMore(textResult(JSON.stringify(body)))).toBe(true);
    expect(hasMore(textResult('has_more: true'))).toBe(false);
  });

  test('a text answer : the board links it holds, with or without the trailing slash', () => {
    const boards = boardsIn(
      textResult(
        `Found 3 boards:\n- Workshop ${BOARD_URL}\n- Retro https://miro.com/app/board/o9J_kzlUDmo=/?share=1\n- Plan https://miro.com/app/board/uXjVOakxTk0=`,
      ),
    );
    expect(boards.map((b) => b.ref)).toEqual([BOARD, 'o9J_kzlUDmo~', 'uXjVOakxTk0~']);
    expect(boards[0]?.displayName).toBe(BOARD_ID);
  });

  test("Miro refusing its MCP server (403) is told in the plugin's words", async () => {
    const fetch = mockFetch([{ url: MIRO_MCP_URL, status: 403, body: { error: 'forbidden' } }]);
    const failure = discoverMiroResources(context(fetch));
    await expect(failure).rejects.toBeInstanceOf(CredentialRefusal);
    await expect(discoverMiroResources(context(fetch))).rejects.toThrow(MCP_SERVER_REFUSED);
  });

  test('a 401 stays a rejected credential, with no sentence of the plugin', async () => {
    const fetch = mockFetch([{ url: MIRO_MCP_URL, status: 401, body: {} }]);
    const failure = discoverMiroResources(context(fetch)).catch((err: unknown) => err);
    const err = await failure;
    expect(err).toBeInstanceOf(UpstreamAuthError);
    expect(err).not.toBeInstanceOf(CredentialRefusal);
  });

  test('a live tool list that differs from the model is logged, names only', async () => {
    const live = {
      tools: [
        ...UPSTREAM_TOOL_LIST.tools.filter((t) => t.name !== 'table_update_view'),
        { name: 'board_delete', inputSchema: { type: 'object', properties: {} } },
      ].map((t) => {
        if (t.name !== 'canvas_search') return t;
        // Miro renames the locator and drops one argument.
        const rest: Record<string, unknown> = { ...t.inputSchema.properties };
        delete rest.miro_url;
        delete rest.cursor;
        return { ...t, inputSchema: { type: 'object', properties: { board_url: {}, ...rest } } };
      }),
    };
    expect(toolDrift(live)).toEqual({
      gone: ['table_update_view'],
      unmodelled: ['board_delete'],
      arguments: { canvas_search: ['+board_url', '-miro_url', '-cursor'] },
    });
    const warn = vi.fn();
    const fetch = mockFetch([
      mcpRoute((call) => (rpcOf(call).method === 'tools/list' ? live : textResult(BOARD_URL))),
    ]);
    await discoverMiroResources({
      ...context(fetch),
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ unmodelled: ['board_delete'] });
    expect(toolDrift(tools)).toEqual({ gone: [], unmodelled: [], arguments: {} });
  });
});
