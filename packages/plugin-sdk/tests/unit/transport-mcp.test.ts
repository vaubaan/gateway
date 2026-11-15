/**
 * The upstream MCP client against a scripted Streamable HTTP server : real
 * `Response` objects from `mockFetch`, JSON and SSE answers, sessions,
 * every failure typed.
 */
import { describe, expect, test } from 'vitest';

import { UpstreamAuthError, UpstreamHttpError } from '@vaubaan/shared';

import { mockFetch, type MockRoute, type RecordedCall } from '../../src/testing/mock-fetch.ts';
import {
  callUpstreamTool,
  firstJsonRpcFrame,
  mcpRequest,
  MCP_PROTOCOL_VERSION,
  upstreamToolResult,
  UpstreamProtocolError,
  type UpstreamMcpServer,
} from '../../src/transport/index.ts';

const SERVER: UpstreamMcpServer = {
  url: 'https://mcp.example.com/',
  name: 'Example MCP server',
  headers: { 'user-agent': 'vaubaan-test' },
};

interface Rpc {
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
}
function rpcOf(call: RecordedCall): Rpc {
  const { json } = call;
  return typeof json === 'object' && json !== null ? json : {};
}

/** Answers every request with `result`, as JSON or as one SSE event. */
function answering(result: (call: RecordedCall) => unknown, sse = false): MockRoute {
  return {
    url: SERVER.url,
    respond: (call) => {
      const frame = { jsonrpc: '2.0', id: rpcOf(call).id ?? null, result: result(call) };
      return sse ? `event: message\ndata: ${JSON.stringify(frame)}\n\n` : frame;
    },
  };
}

describe('firstJsonRpcFrame', () => {
  test('reads a bare JSON document or the SSE data lines, skipping other frames', () => {
    expect(firstJsonRpcFrame('{"jsonrpc":"2.0","id":3,"result":{"a":1}}', 3)).toEqual({
      result: { a: 1 },
    });
    const sse = [
      'data: {"jsonrpc":"2.0","method":"notifications/progress"}',
      'data: {"jsonrpc":"2.0","id":2,"result":"other request"}',
      'data: not json',
      'data: {"jsonrpc":"2.0","id":3,"result":"mine"}',
    ].join('\n');
    expect(firstJsonRpcFrame(sse, 3)).toEqual({ result: 'mine' });
  });

  test('accepts a null id for an error, never for a result', () => {
    expect(
      firstJsonRpcFrame('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse"}}', 3),
    ).toEqual({ error: { code: -32700, message: 'parse' } });
    expect(firstJsonRpcFrame('{"jsonrpc":"2.0","id":null,"result":"x"}', 3)).toBeNull();
    expect(firstJsonRpcFrame('{"id":3,"result":"no jsonrpc member"}', 3)).toBeNull();
  });
});

describe('upstreamToolResult', () => {
  test('rebuilds text, image and resource blocks ; another block becomes its JSON', () => {
    expect(
      upstreamToolResult(
        {
          content: [
            { type: 'text', text: 'hi', extra: 'dropped' },
            { type: 'image', data: 'aGk=', mimeType: 'image/png' },
            { type: 'resource', resource: { uri: 'file:///a', text: 't' } },
            { type: 'audio', data: 'x' },
          ],
          structuredContent: { ok: true },
          isError: true,
        },
        'w',
      ),
    ).toEqual({
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image', data: 'aGk=', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'file:///a', text: 't' } },
        { type: 'text', text: '{"type":"audio","data":"x"}' },
      ],
      structuredContent: { ok: true },
      isError: true,
    });
  });

  test('something that is not a tool result is a protocol failure', () => {
    expect(() => upstreamToolResult({ text: 'no content' }, 'Example, tool t')).toThrow(
      new UpstreamProtocolError('Example, tool t: the answer is not a tool result'),
    );
  });
});

describe('mcpRequest', () => {
  test('one POST with the bearer, the protocol headers, the service headers and the signal', async () => {
    const fetch = mockFetch([answering(() => ({ tools: [] }))]);
    const signal = new AbortController().signal;
    expect(await mcpRequest({ fetch, signal }, SERVER, 'tok', 'tools/list', {})).toEqual({
      tools: [],
    });
    const [call] = fetch.calls;
    expect(call?.method).toBe('POST');
    expect(call?.headers).toMatchObject({
      authorization: 'Bearer tok',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      'user-agent': 'vaubaan-test',
    });
    expect(rpcOf(call!)).toMatchObject({ method: 'tools/list', params: {} });
  });

  test('a server that wants a session : initialize once, then the request again with its id', async () => {
    const fetch = mockFetch([
      { url: SERVER.url, status: 400, body: { error: 'no session' }, times: 1 },
      {
        url: SERVER.url,
        times: 1,
        headers: { 'mcp-session-id': 'session-1' },
        respond: (call) => ({ jsonrpc: '2.0', id: rpcOf(call).id, result: {} }),
      },
      { url: SERVER.url, status: 202, times: 1 },
      answering(() => 'done', true),
    ]);
    expect(await mcpRequest({ fetch }, SERVER, 'tok', 'tools/call', { name: 't' })).toBe('done');
    expect(fetch.calls.map((c) => rpcOf(c).method)).toEqual([
      'tools/call',
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    expect(fetch.calls[2]?.headers['mcp-session-id']).toBe('session-1');
    expect(fetch.calls[3]?.headers['mcp-session-id']).toBe('session-1');
  });

  test("session: 'never' takes a 400 as the failure it is", async () => {
    const fetch = mockFetch([{ url: SERVER.url, status: 400, body: 'bad request' }]);
    const failure = await mcpRequest(
      { fetch },
      { ...SERVER, session: 'never' },
      't',
      'm',
      {},
    ).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(UpstreamHttpError);
    expect((failure as UpstreamHttpError).status).toBe(400);
    expect(fetch.calls).toHaveLength(1);
  });

  test('401 and 403 are a rejected credential ; another status an HTTP failure', async () => {
    for (const status of [401, 403]) {
      const fetch = mockFetch([{ url: SERVER.url, status, body: 'nope' }]);
      await expect(mcpRequest({ fetch }, SERVER, 't', 'm', {})).rejects.toBeInstanceOf(
        UpstreamAuthError,
      );
    }
    const down = mockFetch([{ url: SERVER.url, status: 503, body: 'down' }]);
    await expect(mcpRequest({ fetch: down }, SERVER, 't', 'm', {})).rejects.toThrow(
      'Example MCP server, m failed with HTTP 503: down',
    );
  });

  test('an error frame, or no frame for the request, is a protocol failure with the server text', async () => {
    const frame = mockFetch([
      {
        url: SERVER.url,
        respond: (call) => ({
          jsonrpc: '2.0',
          id: rpcOf(call).id,
          error: { code: -32602, message: 'Invalid params: svg' },
        }),
      },
    ]);
    const failure = await mcpRequest({ fetch: frame }, SERVER, 't', 'tools/call', {}).catch(
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(UpstreamProtocolError);
    expect((failure as UpstreamHttpError).status).toBe(502);
    expect((failure as Error).message).toBe(
      'Example MCP server, tools/call: JSON-RPC error -32602: Invalid params: svg',
    );
    const silent = mockFetch([{ url: SERVER.url, body: { jsonrpc: '2.0', id: -1, result: 'x' } }]);
    await expect(mcpRequest({ fetch: silent }, SERVER, 't', 'm', {})).rejects.toThrow(
      'Example MCP server, m: no JSON-RPC frame answered the request',
    );
  });
});

describe('callUpstreamTool', () => {
  test('calls tools/call with the name and arguments ; reads the answer as a tool result', async () => {
    const fetch = mockFetch([answering(() => ({ content: [{ type: 'text', text: 'ok' }] }))]);
    expect(await callUpstreamTool({ fetch }, SERVER, 't', 'search', { q: 'x' })).toEqual({
      content: [{ type: 'text', text: 'ok' }],
    });
    expect(rpcOf(fetch.calls[0]!)).toMatchObject({
      method: 'tools/call',
      params: { name: 'search', arguments: { q: 'x' } },
    });
  });
});
