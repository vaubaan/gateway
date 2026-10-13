/**
 * Web sessions (table `web_sessions`, migration 0003): the opaque server-side
 * records behind a browser cookie — a signed-in user, the bootstrap operator,
 * a sign-in or a connect flow in flight.
 *
 * The repository satisfies the composition root's `SessionStore` port
 * (`compose/ports.ts`) structurally, so the root hands `store.webSessions` to
 * every consumer of that port.
 *
 * The caller's id is a bearer (the cookie value, an OAuth `state`): it is
 * never written. The row key is its SHA-256, like every other bearer of the
 * schema, so a copy of the database file is not a set of live sessions. The
 * ids carry 256 bits of entropy, which is why a plain digest is enough.
 *
 * Expired rows are swept on every write (one indexed `DELETE`), so no
 * background job is needed and a read never returns a stale record. A value
 * is returned as `unknown`: the consumer narrows it with its own type guard.
 */
import { createHash } from 'node:crypto';

import { toIso } from '../clock.ts';
import { nowIso, type RepoContext } from './context.ts';

export interface WebSessionsRepo {
  /** The live value under `id`, or `null` (unknown, expired or unreadable). */
  get(id: string): Promise<unknown>;
  /** Writes (or replaces) the value; it expires `ttlMs` from now. */
  set(id: string, value: unknown, ttlMs: number): Promise<void>;
  delete(id: string): Promise<void>;
  /** Live rows, for tests and diagnostics. */
  count(): Promise<number>;
}

interface WebSessionRow {
  value_json: string;
  expires_at: string;
}

function rowKey(id: string): string {
  return createHash('sha256').update(id, 'utf8').digest('hex');
}

export function createWebSessionsRepo(ctx: RepoContext): WebSessionsRepo {
  const { db } = ctx;
  const select = db.prepare<[string], WebSessionRow>(
    'SELECT value_json, expires_at FROM web_sessions WHERE id = ?',
  );
  const upsert = db.prepare<[string, string, string]>(
    `INSERT INTO web_sessions (id, value_json, expires_at) VALUES (?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET value_json = excluded.value_json,
       expires_at = excluded.expires_at`,
  );
  const remove = db.prepare<[string]>('DELETE FROM web_sessions WHERE id = ?');
  const sweep = db.prepare<[string]>('DELETE FROM web_sessions WHERE expires_at <= ?');
  const countAll = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM web_sessions');

  return {
    async get(id) {
      const key = rowKey(id);
      const row = select.get(key);
      if (!row) return null;
      if (row.expires_at <= nowIso(ctx)) {
        remove.run(key);
        return null;
      }
      try {
        const value: unknown = JSON.parse(row.value_json);
        return value;
      } catch {
        // A record that cannot be read is no session; it is not kept around.
        remove.run(key);
        return null;
      }
    },
    async set(id, value, ttlMs) {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new RangeError(`session ttlMs must be a positive number (got ${String(ttlMs)})`);
      }
      const now = ctx.clock.now();
      sweep.run(toIso(now));
      upsert.run(rowKey(id), JSON.stringify(value), toIso(new Date(now.getTime() + ttlMs)));
    },
    async delete(id) {
      remove.run(rowKey(id));
    },
    async count() {
      sweep.run(nowIso(ctx));
      return countAll.get()?.n ?? 0;
    },
  };
}
