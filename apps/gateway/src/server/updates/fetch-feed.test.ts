import { describe, expect, it } from 'vitest';

import { FEED_USER_AGENT, readVersionsFeed } from './fetch-feed';

const URL_ = new URL('https://feed.example.com/versions.json');
const FEED = {
  schema: 1,
  generated_at: '2026-11-05T10:00:00Z',
  gateway: { latest: '2.0.0-alpha.17', prerelease: true },
  plugins: {},
  advisories: [],
};

function answering(
  body: BodyInit | null,
  init: ResponseInit = {},
): {
  readonly fetch: typeof fetch;
  readonly seen: { url: string; init: RequestInit | undefined }[];
} {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const fake = (async (input: RequestInfo | URL, requestInit?: RequestInit) => {
    seen.push({ url: String(input), init: requestInit });
    return new Response(body, { status: 200, ...init });
  }) as typeof fetch;
  return { fetch: fake, seen };
}

describe('readVersionsFeed', () => {
  it('sends a GET that says nothing about the instance', async () => {
    const { fetch, seen } = answering(JSON.stringify(FEED));
    const read = await readVersionsFeed(URL_, { fetch });
    expect(read.ok).toBe(true);
    expect(seen).toHaveLength(1);
    const [{ url, init }] = seen as [(typeof seen)[number]];
    expect(url).toBe('https://feed.example.com/versions.json');
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toEqual({ 'user-agent': FEED_USER_AGENT, accept: 'application/json' });
    expect(FEED_USER_AGENT).not.toMatch(/\d/);
  });

  it('turns every failure into a result, never a throw', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(await readVersionsFeed(URL_, { fetch: failing })).toEqual({
      ok: false,
      failure: 'unreachable',
    });
    expect(
      await readVersionsFeed(URL_, { fetch: answering('gone', { status: 404 }).fetch }),
    ).toEqual({ ok: false, failure: 'http-status', status: 404 });
    expect(await readVersionsFeed(URL_, { fetch: answering('{').fetch })).toEqual({
      ok: false,
      failure: 'not-json',
    });
    expect(
      await readVersionsFeed(URL_, {
        fetch: answering(JSON.stringify({ ...FEED, schema: 2 })).fetch,
      }),
    ).toEqual({ ok: false, failure: 'not-a-feed' });
  });

  it('stops reading past the size bound', async () => {
    const big = JSON.stringify({ ...FEED, pad: 'x'.repeat(2048) });
    expect(await readVersionsFeed(URL_, { fetch: answering(big).fetch, maxBytes: 1024 })).toEqual({
      ok: false,
      failure: 'too-large',
    });
    const declared = answering(big, { headers: { 'content-length': String(big.length) } });
    expect(await readVersionsFeed(URL_, { fetch: declared.fetch, maxBytes: 1024 })).toEqual({
      ok: false,
      failure: 'too-large',
    });
  });

  it('gives up after the timeout', async () => {
    const hanging = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation timed out.', 'TimeoutError')),
        );
      })) as typeof fetch;
    expect(await readVersionsFeed(URL_, { fetch: hanging, timeoutMs: 20 })).toEqual({
      ok: false,
      failure: 'timeout',
    });
  });
});
