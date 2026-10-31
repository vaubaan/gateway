/**
 * The transport helpers on real `Response` objects : what a provider answers
 * becomes a typed value or a typed failure, never more than the bound.
 */
import { describe, expect, test } from 'vitest';

import { UpstreamAuthError, UpstreamHttpError } from '@vaubaan/shared';

import {
  anyJson,
  describeUrl,
  httpJson,
  readBounded,
  readBoundedText,
  readPrefixText,
  readShape,
  upstreamFailure,
  UpstreamAnswerTooLarge,
  UpstreamProtocolError,
} from '../../src/transport/index.ts';
import { mockFetch } from '../../src/testing/mock-fetch.ts';

const encoder = new TextEncoder();

/**
 * A body sent in `chunks` that records how many were read and whether it was
 * cancelled ; without `content-length` unless `headers` declares one.
 */
function streamed(
  chunks: readonly string[],
  headers: Readonly<Record<string, string>> = {},
): { response: Response; cancelled: () => boolean; read: () => number } {
  let cancelled = false;
  let next = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[next++];
        if (chunk === undefined) controller.close();
        else controller.enqueue(encoder.encode(chunk));
      },
      cancel() {
        cancelled = true;
      },
    },
    // Nothing is pulled before a reader asks : `read` counts what was asked.
    { highWaterMark: 0 },
  );
  return {
    response: new Response(body, { headers }),
    cancelled: () => cancelled,
    read: () => next,
  };
}

interface Workspace {
  readonly id: string;
}
function isWorkspaceList(x: unknown): x is readonly Workspace[] {
  return Array.isArray(x) && x.every((w) => typeof (w as { id?: unknown })?.id === 'string');
}

describe('readBounded', () => {
  test('reads a body up to its bound, chunk by chunk', async () => {
    const { response } = streamed(['ab', 'cd', 'é']);
    expect(await readBoundedText(response, 6)).toBe('abcdé');
  });

  test('refuses a declared content-length above the bound before reading', async () => {
    const { response, cancelled, read } = streamed(['x'.repeat(20)], { 'content-length': '20' });
    await expect(readBounded(response, 10, 'GET /big')).rejects.toThrow(
      new UpstreamAnswerTooLarge('GET /big', 10),
    );
    expect(read()).toBe(0);
    expect(cancelled()).toBe(true);
  });

  test('cuts and cancels a body without content-length as soon as it passes the bound', async () => {
    const { response, cancelled } = streamed(['12345', '67890', 'never read']);
    const failure = await readBounded(response, 8).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(UpstreamAnswerTooLarge);
    expect(failure).toBeInstanceOf(UpstreamHttpError);
    expect((failure as UpstreamHttpError).status).toBe(502);
    expect(cancelled()).toBe(true);
  });

  test('an answer without a body is empty', async () => {
    expect(await readBounded(new Response(null, { status: 204 }), 1)).toEqual(new Uint8Array(0));
  });

  test('readPrefixText keeps the first bytes and cancels the rest', async () => {
    const { response, cancelled } = streamed(['hello ', 'world', '!']);
    expect(await readPrefixText(response, 8)).toBe('hello wo');
    expect(cancelled()).toBe(true);
  });
});

describe('readShape', () => {
  test('returns the value its guard accepts', () => {
    const value: unknown = [{ id: 'w-1' }];
    expect(readShape(value, isWorkspaceList, 'GET /workspaces')).toEqual([{ id: 'w-1' }]);
  });

  test('throws a protocol failure naming where the answer came from, never the value', () => {
    const failure = (() => {
      try {
        return readShape({ secret: 'v' }, isWorkspaceList, 'GET /workspaces: a list of { id }');
      } catch (e) {
        return e;
      }
    })();
    expect(failure).toBeInstanceOf(UpstreamProtocolError);
    expect((failure as Error).message).toBe('GET /workspaces: a list of { id }: unexpected answer');
  });
});

describe('httpJson', () => {
  const url = 'https://api.example.com/v1/workspaces?key=secret';

  test('sends the method, headers, JSON body and signal ; returns the guarded answer', async () => {
    const fetch = mockFetch([{ method: 'POST', url, body: [{ id: 'w-1' }] }]);
    const signal = new AbortController().signal;
    const answer = await httpJson(
      { fetch, signal },
      { url, method: 'post', headers: { authorization: 'Bearer k' }, body: { name: 'n' } },
      isWorkspaceList,
    );
    expect(answer).toEqual([{ id: 'w-1' }]);
    const [call] = fetch.calls;
    expect(call?.method).toBe('POST');
    expect(call?.headers).toMatchObject({
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: 'Bearer k',
    });
    expect(call?.json).toEqual({ name: 'n' });
  });

  test('a raw body is sent as it is : a form with the type fetch gives it, bytes with the type the plugin gives', async () => {
    const fetch = mockFetch([{ method: 'POST', url, body: { id: 'w-1' } }]);
    await httpJson(
      { fetch },
      { url, method: 'POST', rawBody: new URLSearchParams({ 'items[0][price]': 'p' }) },
      anyJson,
    );
    await httpJson(
      { fetch },
      {
        url,
        method: 'POST',
        headers: { 'content-type': 'image/png' },
        rawBody: new Uint8Array([1, 2, 3]),
      },
      anyJson,
    );
    const [form, bytes] = fetch.calls;
    expect(form?.body).toBe('items%5B0%5D%5Bprice%5D=p');
    // No JSON type written over the form's : `fetch` derives it from the body.
    expect(form?.headers['content-type']).toBeUndefined();
    expect(bytes?.headers['content-type']).toBe('image/png');
    expect(bytes?.body).toBe('\u0001\u0002\u0003');
  });

  test('401 and 403 are a rejected credential, quoting the answer ; the query string is never named', async () => {
    for (const status of [401, 403]) {
      const fetch = mockFetch([{ url, status, body: { message: 'bad token' } }]);
      const failure = await httpJson({ fetch }, { url }, anyJson).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(UpstreamAuthError);
      expect((failure as UpstreamAuthError).upstreamStatus).toBe(status);
      expect((failure as Error).message).toBe(
        `GET https://api.example.com/v1/workspaces failed with HTTP ${status}: {"message":"bad token"}`,
      );
    }
  });

  test('another failed status is an HTTP failure with that status', async () => {
    const fetch = mockFetch([{ url, status: 503, body: 'down' }]);
    const failure = await httpJson({ fetch }, { url, what: 'list workspaces' }, anyJson).catch(
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(UpstreamHttpError);
    expect(failure).not.toBeInstanceOf(UpstreamAuthError);
    expect((failure as UpstreamHttpError).status).toBe(503);
    expect((failure as Error).message).toBe('list workspaces failed with HTTP 503: down');
  });

  test('a failed answer is quoted at most 300 characters', async () => {
    const fetch = mockFetch([{ url, status: 500, body: 'e'.repeat(5_000) }]);
    await expect(httpJson({ fetch }, { url, what: 'w' }, anyJson)).rejects.toThrow(
      new UpstreamHttpError(`w failed with HTTP 500: ${'e'.repeat(300)}`, 500),
    );
  });

  test('an answer that is not JSON, or not what the guard says, is a protocol failure', async () => {
    const notJson = mockFetch([{ url, body: '<html>' }]);
    await expect(httpJson({ fetch: notJson }, { url, what: 'w' }, anyJson)).rejects.toThrow(
      new UpstreamProtocolError('w: the answer is not JSON'),
    );
    const wrong = mockFetch([{ url, body: { workspaces: [] } }]);
    await expect(httpJson({ fetch: wrong }, { url, what: 'w' }, isWorkspaceList)).rejects.toThrow(
      new UpstreamProtocolError('w: unexpected answer'),
    );
  });

  test('an answer without content is null', async () => {
    const fetch = mockFetch([{ url, method: 'DELETE', status: 204 }]);
    expect(await httpJson({ fetch }, { url, method: 'DELETE' }, anyJson)).toBeNull();
  });

  test('an answer above maxBytes is not read', async () => {
    const fetch = mockFetch([{ url, body: 'x'.repeat(100) }]);
    await expect(httpJson({ fetch }, { url, maxBytes: 10 }, anyJson)).rejects.toBeInstanceOf(
      UpstreamAnswerTooLarge,
    );
  });
});

describe('upstreamFailure and describeUrl', () => {
  test('upstreamFailure types a response a plugin read itself', async () => {
    const failure = await upstreamFailure(new Response('', { status: 404 }), 'GET /x');
    expect(failure).toBeInstanceOf(UpstreamHttpError);
    expect(failure.message).toBe('GET /x failed with HTTP 404');
  });

  test('describeUrl drops the query string and the fragment', () => {
    expect(describeUrl('https://a.example/p/q?token=t#f')).toBe('https://a.example/p/q');
    expect(describeUrl('not a url')).toBe('<invalid URL>');
  });
});
