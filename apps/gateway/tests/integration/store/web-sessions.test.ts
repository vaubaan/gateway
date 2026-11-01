import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/server/store/index.ts';
import { openTestStore, type TestStore } from '../../support/store/testing.ts';

function rows(store: Store): { id: string; value_json: string }[] {
  return store.db
    .prepare<[], { id: string; value_json: string }>('SELECT id, value_json FROM web_sessions')
    .all();
}

describe('web sessions repository', () => {
  let t: TestStore;
  let store: Store;

  beforeEach(() => {
    t = openTestStore();
    store = t.store;
  });
  afterEach(() => store.close());

  it('stores, reads back and deletes a value', async () => {
    await store.webSessions.set('s1', { user: 'ada' }, 60_000);
    expect(await store.webSessions.get('s1')).toEqual({ user: 'ada' });
    await store.webSessions.delete('s1');
    expect(await store.webSessions.get('s1')).toBeNull();
  });

  it('returns null for an unknown id', async () => {
    expect(await store.webSessions.get('nope')).toBeNull();
  });

  it('keys the row by the SHA-256 of the id: the id itself is never written', async () => {
    const id = 'session:cookie-value-that-must-not-be-stored';
    await store.webSessions.set(id, { user: 'ada' }, 60_000);
    const stored = rows(store);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe(createHash('sha256').update(id, 'utf8').digest('hex'));
    expect(JSON.stringify(stored)).not.toContain('cookie-value-that-must-not-be-stored');
  });

  it('does not read a row whose key is the id in clear (rows written before the digest)', async () => {
    store.db
      .prepare('INSERT INTO web_sessions (id, value_json, expires_at) VALUES (?, ?, ?)')
      .run('session:legacy', '{"kind":"bootstrap"}', '2999-01-01T00:00:00.000Z');
    expect(await store.webSessions.get('session:legacy')).toBeNull();
  });

  it('expires a value after its TTL and sweeps expired rows on write', async () => {
    await store.webSessions.set('short', { user: 'a' }, 1_000);
    await store.webSessions.set('long', { user: 'b' }, 60_000);
    t.clock.advance(999);
    expect(await store.webSessions.get('short')).toEqual({ user: 'a' });
    t.clock.advance(1);
    expect(await store.webSessions.get('short')).toBeNull();
    expect(await store.webSessions.get('long')).toEqual({ user: 'b' });
    await store.webSessions.set('other', { user: 'c' }, 60_000);
    expect(await store.webSessions.count()).toBe(2);
  });

  it('overwrites the value and the expiry of an existing id', async () => {
    await store.webSessions.set('s', { user: 'v1' }, 1_000);
    await store.webSessions.set('s', { user: 'v2' }, 60_000);
    t.clock.advance(5_000);
    expect(await store.webSessions.get('s')).toEqual({ user: 'v2' });
  });

  it('refuses a non-positive TTL', async () => {
    await expect(store.webSessions.set('s', { user: 'x' }, 0)).rejects.toThrow(RangeError);
    await expect(store.webSessions.set('s', { user: 'x' }, Number.NaN)).rejects.toThrow(RangeError);
  });

  it('reads a value that is not JSON as no session, and removes the row', async () => {
    const digest = createHash('sha256').update('broken', 'utf8').digest('hex');
    store.db
      .prepare('INSERT INTO web_sessions (id, value_json, expires_at) VALUES (?, ?, ?)')
      .run(digest, '{not json', '2999-01-01T00:00:00.000Z');
    expect(await store.webSessions.get('broken')).toBeNull();
    expect(rows(store)).toEqual([]);
  });
});
