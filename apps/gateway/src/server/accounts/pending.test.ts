import { describe, expect, it } from 'vitest';

import { MemorySessionStore } from '../compose/memory';
import {
  CONNECT_TTL_MS,
  NOTICE_TTL_MS,
  NoticeStore,
  PendingConnectStore,
  type PendingConnect,
} from './pending';

function pendingFor(userId: string): PendingConnect {
  return {
    kind: 'oauth2',
    serviceId: 'oauthco',
    userId,
    displayName: 'OAuth Co',
    codeVerifier: 'verifier',
    redirectUri: 'https://gateway.example.com/connections/callback/oauthco',
    returnTo: null,
    reconnectId: null,
    createdAt: '2026-10-13T09:00:00.000Z',
  };
}

describe('PendingConnectStore — single-use state', () => {
  it('returns the flow once to the user who started it', async () => {
    const store = new PendingConnectStore(new MemorySessionStore());
    const state = await store.create(pendingFor('u1'));
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await store.take(state, 'u1')).toMatchObject({ userId: 'u1', codeVerifier: 'verifier' });
    expect(await store.take(state, 'u1')).toBeNull();
  });

  it('gives nothing to another user and burns the state', async () => {
    const store = new PendingConnectStore(new MemorySessionStore());
    const state = await store.create(pendingFor('u1'));
    expect(await store.take(state, 'u2')).toBeNull();
    expect(await store.take(state, 'u1')).toBeNull();
  });

  it('refuses an absent, malformed or unknown state', async () => {
    const store = new PendingConnectStore(new MemorySessionStore());
    expect(await store.take(null, 'u1')).toBeNull();
    expect(await store.take('', 'u1')).toBeNull();
    expect(await store.take('../session:abc', 'u1')).toBeNull();
    expect(await store.take('a'.repeat(43), 'u1')).toBeNull();
  });

  it('expires after the connect TTL', async () => {
    let now = 0;
    const store = new PendingConnectStore(new MemorySessionStore(() => now));
    const state = await store.create(pendingFor('u1'));
    now = CONNECT_TTL_MS + 1;
    expect(await store.take(state, 'u1')).toBeNull();
  });

  it('hands a state to exactly one of two concurrent callbacks', async () => {
    const store = new PendingConnectStore(new MemorySessionStore());
    const state = await store.create(pendingFor('u1'));
    const results = await Promise.all([store.take(state, 'u1'), store.take(state, 'u1')]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });
});

describe('NoticeStore — one-time notices', () => {
  const notice = { tone: 'success' as const, title: 'Connected', lines: ['3 resources'] };

  it('is read once, by the web session it was written for', async () => {
    const store = new NoticeStore(new MemorySessionStore());
    const id = await store.put('session-1', notice);
    expect(await store.take('session-2', id)).toBeNull();
    expect(await store.take('session-1', id)).toEqual(notice);
    expect(await store.take('session-1', id)).toBeNull();
  });

  it('ignores a malformed or expired id', async () => {
    let now = 0;
    const store = new NoticeStore(new MemorySessionStore(() => now));
    const id = await store.put('session-1', notice);
    expect(await store.take('session-1', 'x')).toBeNull();
    expect(await store.take('session-1', undefined)).toBeNull();
    now = NOTICE_TTL_MS + 1;
    expect(await store.take('session-1', id)).toBeNull();
  });
});
