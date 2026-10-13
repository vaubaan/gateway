import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openTestStore, type TestStore } from '../store/testing';
import { SqliteSessionStore } from './sqlite-session-store';

describe('SqliteSessionStore', () => {
  let t: TestStore;
  let sessions: SqliteSessionStore<{ user: string }>;

  beforeEach(() => {
    t = openTestStore();
    sessions = new SqliteSessionStore({ db: t.store.db, clock: t.clock });
  });
  afterEach(() => t.store.close());

  it('stores, reads back and deletes a value', async () => {
    await sessions.set('s1', { user: 'ada' }, 60_000);
    expect(await sessions.get('s1')).toEqual({ user: 'ada' });
    await sessions.delete('s1');
    expect(await sessions.get('s1')).toBeNull();
  });

  it('returns null for an unknown id', async () => {
    expect(await sessions.get('nope')).toBeNull();
  });

  it('expires a value after its TTL and sweeps expired rows on write', async () => {
    await sessions.set('short', { user: 'a' }, 1_000);
    await sessions.set('long', { user: 'b' }, 60_000);
    t.clock.advance(999);
    expect(await sessions.get('short')).toEqual({ user: 'a' });
    t.clock.advance(1);
    expect(await sessions.get('short')).toBeNull();
    expect(await sessions.get('long')).toEqual({ user: 'b' });
    await sessions.set('other', { user: 'c' }, 60_000);
    expect(sessions.count()).toBe(2);
  });

  it('overwrites the value and the expiry of an existing id', async () => {
    await sessions.set('s', { user: 'v1' }, 1_000);
    await sessions.set('s', { user: 'v2' }, 60_000);
    t.clock.advance(5_000);
    expect(await sessions.get('s')).toEqual({ user: 'v2' });
  });

  it('refuses a non-positive TTL', async () => {
    await expect(sessions.set('s', { user: 'x' }, 0)).rejects.toThrow(RangeError);
    await expect(sessions.set('s', { user: 'x' }, Number.NaN)).rejects.toThrow(RangeError);
  });

  it('survives reopening the same database (durable, unlike the in-memory store)', async () => {
    await sessions.set('durable', { user: 'ada' }, 60_000);
    const again = new SqliteSessionStore<{ user: string }>({ db: t.store.db, clock: t.clock });
    expect(await again.get('durable')).toEqual({ user: 'ada' });
  });
});
