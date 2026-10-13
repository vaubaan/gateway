/**
 * `SessionStore` over the embedded SQLite store (table `web_sessions`,
 * migration 0003).
 *
 * Implements the composition root's `SessionStore` port
 * (`../compose/ports.ts`) so a web session survives a process restart and is
 * revocable server-side. Portable SQL (positional parameters, ISO-8601 text
 * timestamps, `ON CONFLICT ... DO UPDATE`); a Postgres or Redis
 * implementation of the same port replaces it in a hosted deployment with no
 * change to the callers.
 *
 * Expired rows are swept on every write (cheap: one indexed `DELETE`), so no
 * background job is needed and a read never returns a stale session.
 */
import type { SessionStore } from '../compose/ports';
import { systemClock, toIso, type Clock } from '../store/clock';
import type { StoreDb } from '../store/db';

export interface SqliteSessionStoreOptions {
  readonly db: StoreDb;
  readonly clock?: Clock;
}

interface SessionRow {
  value_json: string;
  expires_at: string;
}

export class SqliteSessionStore<T = unknown> implements SessionStore<T> {
  private readonly clock: Clock;
  private readonly selectStmt;
  private readonly upsertStmt;
  private readonly deleteStmt;
  private readonly sweepStmt;

  constructor(options: SqliteSessionStoreOptions) {
    this.clock = options.clock ?? systemClock;
    const { db } = options;
    this.selectStmt = db.prepare<[string], SessionRow>(
      'SELECT value_json, expires_at FROM web_sessions WHERE id = ?',
    );
    this.upsertStmt = db.prepare<[string, string, string]>(
      `INSERT INTO web_sessions (id, value_json, expires_at) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET value_json = excluded.value_json,
         expires_at = excluded.expires_at`,
    );
    this.deleteStmt = db.prepare<[string]>('DELETE FROM web_sessions WHERE id = ?');
    this.sweepStmt = db.prepare<[string]>('DELETE FROM web_sessions WHERE expires_at <= ?');
  }

  async get(id: string): Promise<T | null> {
    const row = this.selectStmt.get(id);
    if (!row) return null;
    if (row.expires_at <= this.nowIso()) {
      this.deleteStmt.run(id);
      return null;
    }
    return JSON.parse(row.value_json) as T;
  }

  async set(id: string, value: T, ttlMs: number): Promise<void> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RangeError(`session ttlMs must be a positive number (got ${String(ttlMs)})`);
    }
    const now = this.clock.now();
    this.sweepStmt.run(toIso(now));
    this.upsertStmt.run(id, JSON.stringify(value), toIso(new Date(now.getTime() + ttlMs)));
  }

  async delete(id: string): Promise<void> {
    this.deleteStmt.run(id);
  }

  /** Live rows, for tests and diagnostics. */
  count(): number {
    this.sweepStmt.run(this.nowIso());
    return (
      this.selectStmt.database
        .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM web_sessions')
        .get()?.n ?? 0
    );
  }

  private nowIso(): string {
    return toIso(this.clock.now());
  }
}
