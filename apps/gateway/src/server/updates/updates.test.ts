/**
 * The schedule of the versions check: a first read after a delay, then one a day; off,
 * no request at all; a failure never escapes and keeps the last report.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '../logging';
import { CHECK_INTERVAL_MS, createUpdatesModule, FIRST_CHECK_DELAY_MS } from './index';

const FEED = {
  schema: 1,
  generated_at: '2026-11-05T10:00:00Z',
  gateway: { latest: '2.0.0-alpha.17', prerelease: true },
  plugins: { github: { latest: '5.1.0' } },
  advisories: [],
};

const logger = createLogger({ level: 'error', redact: (s) => s, write: () => undefined });
const feedUrl = new URL('https://feed.example.com/versions.json');

function counting(answers: (() => Response)[]): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const fake = (async () => {
    const answer = answers[Math.min(calls, answers.length - 1)];
    calls += 1;
    if (!answer) throw new TypeError('fetch failed');
    return answer();
  }) as typeof fetch;
  return { fetch: fake, calls: () => calls };
}

const ok = (): Response => new Response(JSON.stringify(FEED));
const down = (): Response => new Response('busy', { status: 503 });

function moduleWith(check: boolean, fakeFetch: typeof globalThis.fetch) {
  return createUpdatesModule({
    config: { check, feedUrl },
    gatewayVersion: '2.0.0-alpha.16',
    inventory: [
      {
        id: 'github',
        name: 'GitHub',
        version: '5.0.0',
        origin: 'bundled',
        replaces: null,
        enabled: true,
        path: null,
      },
    ],
    logger,
    fetch: fakeFetch,
    now: () => new Date('2026-11-05T12:00:00Z'),
  });
}

describe('the versions check', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the feed after the first delay, then every 24 h', async () => {
    const { fetch, calls } = counting([ok]);
    const updates = moduleWith(true, fetch);
    updates.start();
    expect(updates.current()).toBeNull();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1);
    expect(calls()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls()).toBe(1);
    expect(updates.current()).toMatchObject({
      checkedAt: '2026-11-05T12:00:00.000Z',
      gateway: { behind: true, latest: '2.0.0-alpha.17' },
      pluginsBehind: [{ id: 'github', loaded: '5.0.0', released: '5.1.0' }],
    });
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(calls()).toBe(2);
    updates.stop();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3);
    expect(calls()).toBe(2);
  });

  it('makes no request at all when off', async () => {
    const { fetch, calls } = counting([ok]);
    const updates = moduleWith(false, fetch);
    updates.start();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(await updates.refresh()).toBeNull();
    expect(calls()).toBe(0);
    expect(updates.current()).toBeNull();
  });

  it('keeps the last report through a failed read, and keeps scheduling', async () => {
    const { fetch, calls } = counting([ok, down]);
    const updates = moduleWith(true, fetch);
    expect(await updates.refresh()).not.toBeNull();
    const first = updates.current();
    expect(await updates.refresh()).toBeNull();
    expect(updates.current()).toBe(first);
    expect(updates.lastFailure()).toEqual({
      at: '2026-11-05T12:00:00.000Z',
      failure: 'http-status',
      status: 503,
    });
    updates.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS + CHECK_INTERVAL_MS);
    expect(calls()).toBe(4);
    updates.stop();
  });

  it('shares one read between concurrent refreshes', async () => {
    const { fetch, calls } = counting([ok]);
    const updates = moduleWith(true, fetch);
    const [a, b] = await Promise.all([updates.refresh(), updates.refresh()]);
    expect(a).toBe(b);
    expect(calls()).toBe(1);
  });
});

describe('the catalog index, read beside the feed', () => {
  const indexUrl = new URL('https://catalog.example.com/index.json');
  const SHA = 'a03544c0fdf5b307329c687a397176fde9ccf437c68b1cfad8b1ac7087a90bed';
  const INDEX = {
    schema: 1,
    generated_at: '2026-11-19T17:00:00Z',
    plugins: {
      github: { name: 'GitHub', version: '5.3.1', sha256: SHA },
      vercel: { name: 'Vercel', version: '4.2.2', sha256: SHA },
    },
  };

  function withIndex(index: () => Response) {
    const fake = (async (input: string | URL | Request) =>
      String(input) === indexUrl.href ? index() : ok()) as typeof fetch;
    return createUpdatesModule({
      config: { check: true, feedUrl },
      gatewayVersion: '2.0.0-alpha.16',
      inventory: [
        {
          id: 'github',
          name: 'GitHub',
          version: '5.0.0',
          origin: 'installed',
          trust: 'vaubaan',
          replaces: null,
          enabled: true,
          path: null,
        },
      ],
      logger,
      indexUrl,
      fetch: fake,
      now: () => new Date('2026-11-05T12:00:00Z'),
    });
  }

  it("offers the catalog's version, its service's name and digest from the index, whatever the feed names", async () => {
    const report = await withIndex(() => new Response(JSON.stringify(INDEX))).refresh();
    expect(report?.catalogSource).toBe('index');
    expect(report?.pluginsBehind).toEqual([{ id: 'github', loaded: '5.0.0', released: '5.3.1' }]);
    expect(report?.pluginsAvailable).toEqual([{ id: 'vercel', released: '4.2.2', name: 'Vercel' }]);
    expect(report?.catalog['vercel']).toEqual({ version: '4.2.2', name: 'Vercel', sha256: SHA });
    expect(report?.indexFailure).toBeNull();
  });

  it('falls back on the feed when the index cannot be read', async () => {
    const report = await withIndex(() => new Response('gone', { status: 404 })).refresh();
    expect(report?.catalogSource).toBe('feed');
    expect(report?.indexFailure).toBe('http-status');
    expect(report?.pluginsBehind).toEqual([{ id: 'github', loaded: '5.0.0', released: '5.1.0' }]);
  });
});
