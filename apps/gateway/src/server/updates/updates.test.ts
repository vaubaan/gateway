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
