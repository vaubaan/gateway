/**
 * `execute`, `discoverResources` and `verify` of the `context7` plugin against
 * `mockFetch` (handbook §6). No test calls Context7.
 */
import { describe, expect, test } from 'vitest';

import { UpstreamAuthError, UpstreamHttpError, type ConnectionContext } from '@vaubaan/plugin-sdk';
import { mockFetch, refusalText } from '@vaubaan/plugin-sdk/testing';

import {
  CONTEXT7_MCP_URL,
  CONTEXT7_USAGE_URL,
  MALFORMED_LIBRARY_ID,
  NO_CONTEXT7_INDEX,
  PROVIDER_ID,
  TOOL,
  TOOL_PREFIX,
  classifyContext7,
  context7Plugin,
  executeContext7,
  firstJsonRpcFrame,
  verifyContext7Key,
} from '../../src/index.ts';
import {
  DOCS_RESULT,
  INVALID_KEY_RESULT,
  KEY,
  ctx,
  index,
  mcpAnswers,
  sse,
  usageAnswers,
} from './support.ts';

const QUERY = 'middleware matcher';

describe('executeContext7 — the forwarded call', () => {
  test('one JSON-RPC tools/call, prefix stripped, arguments as classified, Bearer key', async () => {
    const fetch = mockFetch([mcpAnswers(DOCS_RESULT)]);
    const result = await executeContext7(ctx(fetch), TOOL.queryDocs, {
      libraryId: '/vercel/next.js@v14.3.0',
      query: QUERY,
      language: 'TypeScript',
    });
    expect(result).toEqual({ content: DOCS_RESULT.content });
    expect(fetch.calls).toHaveLength(1);
    const [call] = fetch.calls;
    expect(call!.method).toBe('POST');
    expect(call!.url).toBe(CONTEXT7_MCP_URL);
    expect(call!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call!.headers.accept).toBe('application/json, text/event-stream');
    expect(call!.headers['content-type']).toBe('application/json');
    expect(call!.headers['user-agent']).toBe('vaubaan-gateway');
    expect(call!.headers['mcp-protocol-version']).toBe('2025-06-18');
    // The key is sent once, the documented way : no other key header.
    for (const name of [
      'context7_api_key',
      'x-context7-api-key',
      'context7-api-key',
      'x-api-key',
    ]) {
      expect(call!.headers[name]).toBeUndefined();
    }
    const { id, ...request } = call!.json as { id: unknown };
    expect(typeof id).toBe('number');
    expect(request).toEqual({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'query-docs',
        arguments: { libraryId: '/vercel/next.js@v14.3.0', query: QUERY, language: 'TypeScript' },
      },
    });
  });

  test('resolve-library-id forwards its two arguments', async () => {
    const fetch = mockFetch([mcpAnswers(DOCS_RESULT)]);
    await executeContext7(ctx(fetch), TOOL.resolveLibraryId, {
      libraryName: 'Next.js',
      query: QUERY,
    });
    expect(fetch.calls[0]!.json).toMatchObject({
      params: { name: 'resolve-library-id', arguments: { query: QUERY, libraryName: 'Next.js' } },
    });
  });

  test('a bare JSON answer is read too', async () => {
    const fetch = mockFetch([
      {
        method: 'POST',
        url: CONTEXT7_MCP_URL,
        respond: (call) => ({
          jsonrpc: '2.0',
          id: (call.json as { id: number }).id,
          result: DOCS_RESULT,
        }),
      },
    ]);
    expect(
      await executeContext7(ctx(fetch), TOOL.resolveLibraryId, { libraryName: 'x', query: QUERY }),
    ).toEqual({ content: DOCS_RESULT.content });
  });
});

describe('executeContext7 — what it declines, before any request', () => {
  test('an unknown tool, an undeclared argument, a malformed value, no resource', async () => {
    const fetch = mockFetch([]);
    expect(await refusalText(executeContext7(ctx(fetch), `${TOOL_PREFIX}add-library`, {}))).toBe(
      `unknown tool '${TOOL_PREFIX}add-library'`,
    );
    expect(
      await refusalText(
        executeContext7(ctx(fetch), TOOL.queryDocs, { libraryName: '/evil/lib', query: QUERY }),
      ),
    ).toBe(
      `libraryName: not an argument of '${TOOL.queryDocs}' — nothing classifies it, so it is not sent.`,
    );
    expect(
      await refusalText(
        executeContext7(ctx(fetch), TOOL.queryDocs, { libraryId: 'vercel', query: QUERY }),
      ),
    ).toBe(MALFORMED_LIBRARY_ID);
    expect(
      await refusalText(
        executeContext7(ctx(fetch, []), TOOL.queryDocs, { libraryId: '/a/b', query: QUERY }),
      ),
    ).toBe(NO_CONTEXT7_INDEX);
    expect(fetch.calls).toHaveLength(0);
  });

  test('hostile identifiers : what classify refuses, execute does not send', async () => {
    const hostile = [
      '..',
      '.',
      '/a/../b',
      '/a/./b',
      '%2e%2e',
      '/a/%2e%2e',
      '..%2f',
      '/a%2fb',
      '/a/*',
      '/a\nb',
      '/a?x=1#y',
    ];
    for (const value of hostile) {
      const args = { libraryId: value, query: QUERY };
      expect(classifyContext7(TOOL.queryDocs, args, [index]), value).toEqual({
        denied: MALFORMED_LIBRARY_ID,
      });
      const fetch = mockFetch([]);
      expect(await refusalText(executeContext7(ctx(fetch), TOOL.queryDocs, args))).toBe(
        MALFORMED_LIBRARY_ID,
      );
      expect(fetch.calls, value).toHaveLength(0);
    }
  });

  test('an accepted library id is the one the request carries, unchanged', async () => {
    for (const value of ['/vercel/next.js', '/vercel/next.js/v14.3.0', '/vercel/next.js@v14.3.0']) {
      expect(
        'slices' in classifyContext7(TOOL.queryDocs, { libraryId: value, query: QUERY }, [index]),
      ).toBe(true);
      const fetch = mockFetch([mcpAnswers(DOCS_RESULT)]);
      await executeContext7(ctx(fetch), TOOL.queryDocs, { libraryId: value, query: QUERY });
      expect(fetch.calls.map((c) => c.url)).toEqual([CONTEXT7_MCP_URL]);
      expect((fetch.calls[0]!.json as { params: { arguments: unknown } }).params.arguments).toEqual(
        {
          libraryId: value,
          query: QUERY,
        },
      );
    }
  });

  test('a credential without the key is refused before any request', async () => {
    const fetch = mockFetch([]);
    await expect(
      executeContext7(
        { ...ctx(fetch), credential: { kind: 'api-key', fields: {}, metadata: {} } },
        TOOL.resolveLibraryId,
        { libraryName: 'x', query: QUERY },
      ),
    ).rejects.toThrow(/'api_key'/);
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('executeContext7 — provider failures are thrown', () => {
  test('HTTP 401 / 403 from the MCP server → UpstreamAuthError ; another status → UpstreamHttpError', async () => {
    for (const status of [401, 403]) {
      const fetch = mockFetch([{ url: CONTEXT7_MCP_URL, status, body: { error: 'no' } }]);
      await expect(
        executeContext7(ctx(fetch), TOOL.resolveLibraryId, { libraryName: 'x', query: QUERY }),
      ).rejects.toMatchObject({ name: 'UpstreamAuthError', upstreamStatus: status });
    }
    const down = mockFetch([{ url: CONTEXT7_MCP_URL, status: 503, body: 'down' }]);
    await expect(
      executeContext7(ctx(down), TOOL.resolveLibraryId, { libraryName: 'x', query: QUERY }),
    ).rejects.toMatchObject({ name: 'UpstreamHttpError', status: 503 });
  });

  test('a JSON-RPC error frame, or an answer that is not a tool result, is a plain Error', async () => {
    const errorFrame = mockFetch([
      {
        url: CONTEXT7_MCP_URL,
        respond: (call) =>
          sse({
            jsonrpc: '2.0',
            id: (call.json as { id: number }).id,
            error: { code: -32602, message: 'bad params' },
          }),
      },
    ]);
    const err = await executeContext7(ctx(errorFrame), TOOL.resolveLibraryId, {
      libraryName: 'x',
      query: QUERY,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UpstreamHttpError);
    expect((err as Error).message).toMatch(/-32602: bad params/);

    const odd = mockFetch([
      mcpAnswers({ content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] }),
    ]);
    await expect(
      executeContext7(ctx(odd), TOOL.resolveLibraryId, { libraryName: 'x', query: QUERY }),
    ).rejects.toThrow(/not a tool result/);

    const empty = mockFetch([{ url: CONTEXT7_MCP_URL, body: '' }]);
    await expect(
      executeContext7(ctx(empty), TOOL.resolveLibraryId, { libraryName: 'x', query: QUERY }),
    ).rejects.toThrow(/no JSON-RPC frame/);
  });

  test('an isError result with a key the usage endpoint refuses (live : 401) → UpstreamAuthError', async () => {
    const fetch = mockFetch([
      mcpAnswers(INVALID_KEY_RESULT),
      usageAnswers(401, { error: 'unauthorized' }),
    ]);
    const err = await executeContext7(ctx(fetch), TOOL.queryDocs, {
      libraryId: '/vercel/next.js',
      query: QUERY,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamAuthError);
    expect(err).toMatchObject({ upstreamStatus: 401 });
    expect((err as Error).message).toMatch(/^Context7: Invalid API key\./);
    // The probe carries the same key and nothing of the agent.
    expect(fetch.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${CONTEXT7_MCP_URL}`,
      `GET ${CONTEXT7_USAGE_URL}`,
    ]);
    expect(fetch.calls[1]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(fetch.calls[1]!.body).toBeNull();
  });

  test('an isError result while the usage endpoint answers 429 → UpstreamHttpError(429)', async () => {
    const quota = {
      content: [
        {
          type: 'text',
          text: 'Rate limited or quota exceeded. Upgrade your plan at https://context7.com/plans for higher limits.',
        },
      ],
      isError: true,
    };
    const fetch = mockFetch([mcpAnswers(quota), usageAnswers(429, { error: 'rate_limited' })]);
    await expect(
      executeContext7(ctx(fetch), TOOL.resolveLibraryId, { libraryName: 'x', query: QUERY }),
    ).rejects.toMatchObject({ name: 'UpstreamHttpError', status: 429 });
  });

  test('an isError result with a healthy key, or a probe that fails → a plain Error carrying the text', async () => {
    const missing = {
      content: [{ type: 'text', text: 'The library you are trying to access does not exist.' }],
      isError: true,
    };
    for (const probe of [usageAnswers(200), usageAnswers(500, { error: 'boom' })]) {
      const fetch = mockFetch([mcpAnswers(missing), probe]);
      const err = await executeContext7(ctx(fetch), TOOL.queryDocs, {
        libraryId: '/no/such',
        query: QUERY,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(UpstreamAuthError);
      expect(err).not.toBeInstanceOf(UpstreamHttpError);
      expect((err as Error).message).toBe(
        'Context7: The library you are trying to access does not exist.',
      );
    }
    // The probe cannot be reached : no route for it.
    const unreachable = mockFetch([mcpAnswers(missing)]);
    await expect(
      executeContext7(ctx(unreachable), TOOL.queryDocs, { libraryId: '/no/such', query: QUERY }),
    ).rejects.toThrow('Context7: The library you are trying to access does not exist.');
  });

  test('"No documentation found" is an answer, passed through', async () => {
    const none = {
      content: [{ type: 'text', text: 'No documentation found for this query.' }],
      isError: false,
    };
    const fetch = mockFetch([mcpAnswers(none)]);
    expect(
      await executeContext7(ctx(fetch), TOOL.queryDocs, { libraryId: '/a/b', query: QUERY }),
    ).toEqual({
      content: none.content,
    });
    expect(fetch.calls).toHaveLength(1);
  });
});

describe('firstJsonRpcFrame', () => {
  test('skips frames of another id and lines that are not JSON', () => {
    const body = `event: message\ndata: not json\n\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 9, result: 1 })}\n\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 7, result: 2 })}\n`;
    expect(firstJsonRpcFrame(body, 7)).toEqual({ result: 2 });
    expect(() => firstJsonRpcFrame(body, 8)).toThrow(/no JSON-RPC frame answered id 8/);
  });
});

describe('discoverResources and verify — GET /v2/usage', () => {
  const connection = (fetch: ReturnType<typeof mockFetch>): ConnectionContext => {
    const { resources: _resources, ...rest } = ctx(fetch);
    return rest;
  };

  test('one resource, the library index, with the plan', async () => {
    for (const plan of ['free', 'pro', 'enterprise', 'payg']) {
      const fetch = mockFetch([
        usageAnswers(200, { plan, member: { requests: 1, includedInPlan: 1000 } }),
      ]);
      expect(await context7Plugin.discoverResources(connection(fetch))).toEqual([
        {
          provider: PROVIDER_ID,
          ref: 'docs',
          displayName: 'Context7 library index',
          metadata: { plan },
        },
      ]);
      expect(fetch.calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(await verifyContext7Key(connection(mockFetch([usageAnswers(200, { plan })])))).toEqual(
        {
          account: `Context7 ${plan} plan`,
          expiresAt: null,
        },
      );
    }
  });

  test('a refused key throws UpstreamAuthError, another status UpstreamHttpError', async () => {
    for (const run of [verifyContext7Key, context7Plugin.discoverResources]) {
      await expect(
        run(connection(mockFetch([usageAnswers(401, { error: 'unauthorized' })]))),
      ).rejects.toMatchObject({
        name: 'UpstreamAuthError',
        upstreamStatus: 401,
      });
      await expect(
        run(connection(mockFetch([usageAnswers(503, { error: 'down' })]))),
      ).rejects.toMatchObject({
        name: 'UpstreamHttpError',
        status: 503,
      });
    }
  });

  test('an answer that is not the documented one fails', async () => {
    for (const body of [{ plan: 'gold' }, { member: {} }, ['free'], 'free']) {
      await expect(
        context7Plugin.discoverResources(connection(mockFetch([usageAnswers(200, body)]))),
      ).rejects.toThrow(/unexpected usage answer/);
    }
  });
});
