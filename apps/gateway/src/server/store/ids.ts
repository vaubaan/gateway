/**
 * UUIDv7 identifiers (RFC 9562 §5.7) as lowercase canonical text.
 *
 * Time-ordered so that primary-key inserts land at the end of the B-tree (append-mostly
 * tables such as `audit` and `events`) and random in the low 62 bits so ids are not
 * guessable. `newId()` without argument is also strictly monotonic within one process
 * (RFC 9562 §6.2 method 1: a 12-bit counter in `rand_a`, seeded randomly each
 * millisecond), so `ORDER BY ts, id` is insertion order for rows this process wrote.
 * Ids from two processes in the same millisecond are not ordered relative to each
 * other; nothing relies on that. `newId(ms)` with an explicit timestamp is pure (tests).
 *
 * ADR: docs/decisions/embedded-store-sqlite-and-migrations.md.
 */

import { randomBytes } from 'node:crypto';

export type IdGenerator = () => string;

const COUNTER_BITS = 12;
const COUNTER_MAX = (1 << COUNTER_BITS) - 1;

// single-process only: the monotonic counter lives in this module. A multi-process
// deployment would order by timestamp plus a per-writer sequence instead.
let lastMs = -1;
let counter = 0;

export function newId(nowMs?: number): string {
  const bytes = randomBytes(16);
  if (nowMs !== undefined) {
    return format(bytes, nowMs, ((bytes[6] ?? 0) << 8) | (bytes[7] ?? 0));
  }
  let ms = Date.now();
  if (ms > lastMs) {
    lastMs = ms;
    // Random start in the lower half leaves headroom for 2^11 ids in this millisecond.
    counter = (((bytes[6] ?? 0) << 8) | (bytes[7] ?? 0)) & (COUNTER_MAX >> 1);
  } else {
    counter += 1;
    if (counter > COUNTER_MAX) {
      // Counter exhausted: borrow the next millisecond, as the RFC allows.
      lastMs += 1;
      counter = 0;
    }
    ms = lastMs;
  }
  return format(bytes, ms, counter);
}

function format(bytes: Buffer, ms: number, counter: number): string {
  // 48-bit big-endian Unix timestamp in milliseconds.
  const msBig = BigInt(ms);
  for (let i = 0; i < 6; i++) {
    bytes[5 - i] = Number((msBig >> BigInt(8 * i)) & 0xffn);
  }
  // Version 7 in the top nibble of byte 6, 12 bits of counter (or randomness) in the
  // rest of rand_a, RFC 4122 variant in the top bits of byte 8.
  bytes[6] = 0x70 | ((counter >> 8) & 0x0f);
  bytes[7] = counter & 0xff;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV7(value: string): boolean {
  return UUID_RE.test(value);
}

/** Millisecond timestamp embedded in a UUIDv7. */
export function idTimestampMs(id: string): number {
  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}
