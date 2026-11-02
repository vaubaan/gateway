/**
 * Mail as a notification channel, switched on by its person (migration 0032; spec §4.2
 * bis). A row is "on"; no row is off. The address is the person's own (`users.email`), read
 * when a notification leaves: nothing of it is copied here.
 */

import type { Iso } from '../types.ts';
import { nowIso, type RepoContext } from './context.ts';

export interface NotificationMailRepo {
  /** When the person switched mail on; `null` when it is off. */
  switchedOnAt(userId: string): Promise<Iso | null>;
  /** Switches mail on or off; returns whether it was on before. */
  set(userId: string, on: boolean): Promise<boolean>;
  /** Every person who switched mail on (Administration → People counts them). */
  switchedOn(): Promise<ReadonlySet<string>>;
}

export function createNotificationMailRepo(ctx: RepoContext): NotificationMailRepo {
  const { db } = ctx;
  const one = db.prepare<[string], { switched_on_at: string }>(
    'SELECT switched_on_at FROM notification_mail WHERE user_id = ?',
  );
  const on = db.prepare<[string, string]>(
    'INSERT INTO notification_mail (user_id, switched_on_at) VALUES (?, ?) ON CONFLICT (user_id) DO NOTHING',
  );
  const off = db.prepare<[string]>('DELETE FROM notification_mail WHERE user_id = ?');
  const all = db.prepare<[], { user_id: string }>('SELECT user_id FROM notification_mail');

  return {
    async switchedOnAt(userId) {
      return one.get(userId)?.switched_on_at ?? null;
    },
    async set(userId, value) {
      // One statement each way: `changes` says whether the switch moved.
      if (value) return on.run(userId, nowIso(ctx)).changes === 0;
      return off.run(userId).changes > 0;
    },
    async switchedOn() {
      return new Set(all.all().map((row) => row.user_id));
    },
  };
}
