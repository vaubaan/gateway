/**
 * The token alphabet is drawn without modulo bias (security audit 2026-10-31, H1):
 * a byte of 248 or more is drawn again, and each of the 62 symbols has exactly
 * four bytes behind it. The properties hold for every byte stream, so fast-check
 * runs them on its own seeds; a failure prints the seed to replay.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { randomBase62 } from './api-key.ts';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const LIMIT = 248;

/** A byte source that hands out `stream` in order, then accepted bytes for ever. */
function sourceOf(stream: readonly number[]): (size: number) => Uint8Array {
  let at = 0;
  return (size) =>
    Uint8Array.from({ length: size }, () => {
      const byte = stream[at];
      at += 1;
      return byte ?? at % LIMIT;
    });
}

describe('randomBase62', () => {
  it('maps exactly the accepted bytes, in order, and skips every byte from 248 up', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 200 }),
        fc.integer({ min: 1, max: 64 }),
        (stream, len) => {
          const out = randomBase62(len, sourceOf(stream));
          const accepted = stream.filter((byte) => byte < LIMIT).slice(0, len);
          expect(out).toHaveLength(len);
          expect(out.slice(0, accepted.length)).toBe(
            accepted.map((byte) => ALPHABET.charAt(byte % 62)).join(''),
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it('puts exactly four accepted bytes behind each of the 62 symbols', () => {
    const counts = new Map<string, number>();
    for (let byte = 0; byte < 256; byte += 1) {
      const symbol = randomBase62(1, sourceOf([byte]));
      if (byte < LIMIT) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    }
    expect(counts.size).toBe(62);
    expect(new Set(counts.values())).toEqual(new Set([4]));
  });

  it('draws again when a whole batch is refused', () => {
    expect(randomBase62(3, sourceOf([255, 254, 253, 0, 249, 1, 61]))).toBe('AB9');
  });
});
