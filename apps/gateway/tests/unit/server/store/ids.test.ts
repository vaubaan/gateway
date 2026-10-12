import { describe, expect, it } from 'vitest';
import { idTimestampMs, isUuidV7, newId } from '../../../../src/server/store/ids.ts';

describe('store ids (UUIDv7)', () => {
  it('produces canonical lowercase UUIDs with version 7 and the RFC variant', () => {
    for (let i = 0; i < 100; i++) {
      const id = newId();
      expect(id).toHaveLength(36);
      expect(isUuidV7(id)).toBe(true);
    }
  });

  it('embeds the millisecond timestamp in the first 48 bits', () => {
    const now = Date.UTC(2026, 9, 13, 9, 0, 0, 123);
    expect(idTimestampMs(newId(now))).toBe(now);
  });

  it('sorts by generation time across distinct milliseconds', () => {
    const earlier = newId(1_000_000);
    const later = newId(1_000_001);
    expect(earlier < later).toBe(true);
  });

  it('is strictly increasing within one process, even inside a millisecond', () => {
    const ids = Array.from({ length: 5_000 }, () => newId());
    for (let i = 1; i < ids.length; i++) {
      const prev = ids[i - 1] ?? '';
      const cur = ids[i] ?? '';
      expect(cur > prev).toBe(true);
      expect(idTimestampMs(cur)).toBeGreaterThanOrEqual(idTimestampMs(prev));
    }
    // 5,000 ids never push the embedded time more than a few ms ahead of the clock.
    expect(idTimestampMs(ids[ids.length - 1] ?? '') - Date.now()).toBeLessThan(50);
  });

  it('never repeats', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => newId()));
    expect(ids.size).toBe(10_000);
  });

  it('rejects non-v7 UUIDs', () => {
    expect(isUuidV7('123e4567-e89b-12d3-a456-426614174000')).toBe(false);
    expect(isUuidV7('not-a-uuid')).toBe(false);
  });
});
