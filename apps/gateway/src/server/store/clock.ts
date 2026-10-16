/**
 * Clock — the only source of "now" inside the store.
 *
 * Every timestamp persisted is produced by the application through this interface and
 * written as ISO-8601 UTC text, never by the database (`CURRENT_TIMESTAMP` differs
 * between SQLite and Postgres). Tests inject a fixed or stepping clock.
 */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function toIso(date: Date): string {
  return date.toISOString();
}

/** A clock that returns a fixed instant, advanced explicitly by tests. */
export class ManualClock implements Clock {
  private current: Date;

  constructor(start: Date | string = '2026-10-13T09:00:00.000Z') {
    this.current = new Date(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  set(instant: Date | string): void {
    this.current = new Date(instant);
  }

  advance(ms: number): Date {
    this.current = new Date(this.current.getTime() + ms);
    return this.now();
  }
}
