/**
 * The service worker (`public/sw.js`) run in a sandbox with a fake worker scope: it shows
 * what a push carries, leads only to a page of its own origin, focuses an open window or
 * opens one, and listens to nothing else — no `fetch`, no cache (handbook notifications).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(join(__dirname, '../../../public/sw.js'), 'utf8');
const ORIGIN = 'https://gateway.example.com';

type Listener = (event: Record<string, unknown>) => void;

function load(windows: Array<{ url: string; focus: () => Promise<unknown> }> = []) {
  const listeners = new Map<string, Listener>();
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const opened: string[] = [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: () => undefined,
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
      },
    },
    clients: {
      claim: async () => undefined,
      matchAll: async () => windows,
      openWindow: async (url: string) => {
        opened.push(url);
      },
    },
  };
  runInNewContext(SOURCE, { self, URL });
  return { listeners, shown, opened };
}

async function dispatch(listener: Listener | undefined, event: Record<string, unknown>) {
  let pending: Promise<unknown> = Promise.resolve();
  listener?.({ ...event, waitUntil: (p: Promise<unknown>) => (pending = p) });
  await pending;
}

describe('the service worker', () => {
  it('listens to push and notification clicks only: no fetch, no cache', () => {
    const { listeners } = load();
    expect([...listeners.keys()].sort()).toEqual([
      'activate',
      'install',
      'notificationclick',
      'push',
    ]);
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/\bcaches\b|addEventListener\(\s*['"]fetch/);
  });

  it('shows what the push carries', async () => {
    const { listeners, shown } = load();
    const data = {
      title: 'Acme',
      body: 'Release train asks for your approval.',
      url: '/r/abc',
      tag: '/r/abc',
    };
    await dispatch(listeners.get('push'), { data: { json: () => data } });
    expect(shown).toEqual([
      {
        title: 'Acme',
        options: {
          body: data.body,
          tag: '/r/abc',
          icon: '/logo-vaubaan.png',
          data: { path: '/r/abc' },
        },
      },
    ]);
  });

  it('leads only to a page of its own origin', async () => {
    const { listeners, shown } = load();
    for (const url of ['https://evil.example/x', '//evil.example/x', 42]) {
      await dispatch(listeners.get('push'), { data: { json: () => ({ title: 'x', url }) } });
    }
    expect(shown.map((s) => (s.options.data as { path: string }).path)).toEqual(['/', '/', '/']);
  });

  it('focuses a window already on the page, or opens one', async () => {
    let focused = 0;
    const onPage = { url: `${ORIGIN}/r/abc`, focus: async () => (focused += 1) };
    const { listeners, opened } = load([onPage]);
    const click = (path: string) => ({
      notification: { close: () => undefined, data: { path } },
    });
    await dispatch(listeners.get('notificationclick'), click('/r/abc'));
    expect(focused).toBe(1);
    await dispatch(listeners.get('notificationclick'), click('/missions/m1'));
    // A path that resolves to another origin opens the home of this one.
    await dispatch(listeners.get('notificationclick'), click('/\\evil.example/x'));
    expect(opened).toEqual([`${ORIGIN}/missions/m1`, `${ORIGIN}/`]);
  });
});
