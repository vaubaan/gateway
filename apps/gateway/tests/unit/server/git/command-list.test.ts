/**
 * The door's judgement of a push's command list (`readPushCommands`, that is
 * `commandListIssue ∘ readCommandList`; ADR gateway-as-git-remote D4, D4
 * bis): a seeded generator of command lists — capabilities on any line,
 * hostile ref names, duplicates, too many commands, mutated bytes — and the
 * property that whatever is accepted is exactly what the door implements.
 * And the per-mission bound on pushes in flight.
 */
import { concatBytes, flushPkt, PktLineReader, pktLine, ZERO_OID } from '@vaubaan/plugin-sdk';
import { describe, expect, it } from 'vitest';

import {
  ACCEPTED_PUSH_CAPABILITIES,
  readPushCommands,
} from '../../../../src/server/git/command-list';
import { MAX_PUSH_COMMANDS, MAX_REF_NAME_LENGTH } from '../../../../src/server/git/constants';
import { inMemoryInFlightPushes } from '../../../../src/server/git/in-flight';

/** Mulberry32: seeded, so a failing case can be replayed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
}

const OID = 'a'.repeat(40);
const CAPABILITY_POOL = [
  'report-status',
  'side-band-64k',
  'quiet',
  'ofs-delta',
  'delete-refs',
  'agent=git/2.48.1',
  'object-format=sha1',
  'atomic',
  'push-options',
  'report-status-v2',
  'object-format=sha256',
  'push-cert=x',
  'agent=',
  'x-new',
];
const REF_POOL = [
  'refs/heads/main',
  'refs/heads/feature/a',
  'refs/heads/feature/b',
  'refs/tags/v1',
  'refs/heads/sp ace',
  'refs/heads/ctl\u0001',
  'refs/heads/a~1',
  'refs/heads/x:y',
  'refs/heads/q?',
  'refs/heads/st*r',
  'refs/heads/[x',
  'refs/heads/b\\s',
  `refs/heads/${'l'.repeat(MAX_REF_NAME_LENGTH)}`,
];
const ALLOWED = new Set<string>(ACCEPTED_PUSH_CAPABILITIES);
const accepted = (capability: string) =>
  ALLOWED.has(capability) ||
  /^agent=[\x21-\x7e]{1,256}$/.test(capability) ||
  capability === 'object-format=sha1';
/** A byte `git check-ref-format` never allows. */
const forbiddenByte = (ref: string) =>
  [...ref].some(
    (char) => (char.codePointAt(0) ?? 0) <= 0x20 || char === '\x7f' || '~^:?*[\\'.includes(char),
  );

describe('readPushCommands', () => {
  it('accepts only what the door implements, for 3000 generated command lists', async () => {
    const random = prng(0xc0ffee);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)]!;
    for (let i = 0; i < 3000; i += 1) {
      const count = random() < 0.05 ? MAX_PUSH_COMMANDS + 1 : 1 + Math.floor(random() * 4);
      const written: string[] = [];
      const lines = Array.from({ length: count }, (_, n) => {
        const ref = random() < 0.9 ? `refs/heads/f/${n}` : pick(REF_POOL);
        const caps =
          n === 0 || random() < 0.2
            ? Array.from({ length: Math.floor(random() * 4) }, () => pick(CAPABILITY_POOL))
            : [];
        written.push(...caps);
        const text = `${ZERO_OID} ${OID} ${random() < 0.05 ? 'refs/heads/f/0' : ref}`;
        return pktLine(caps.length > 0 ? `${text}\0${caps.join(' ')}` : text);
      });
      const bytes = concatBytes([...lines, flushPkt()]);
      const read = await readPushCommands(
        new PktLineReader(chunked(bytes, 1 + Math.floor(random() * 9))),
      );
      if ('issue' in read) continue;
      const { list } = read;
      // Whatever was written on any line was judged.
      for (const capability of written)
        expect(accepted(capability), `#${i} ${capability}`).toBe(true);
      expect(list.capabilities).toContain('report-status');
      expect(list.commands.length).toBeLessThanOrEqual(MAX_PUSH_COMMANDS);
      expect(new Set(list.commands.map((c) => c.ref)).size).toBe(list.commands.length);
      for (const c of list.commands) {
        expect(c.ref.length).toBeLessThanOrEqual(MAX_REF_NAME_LENGTH);
        expect(forbiddenByte(c.ref), `#${i} ${c.ref}`).toBe(false);
      }
    }
  });

  it('answers an issue, never throws, for 2000 mutated byte strings', async () => {
    const random = prng(0x5eed);
    const valid = concatBytes([
      pktLine(`${ZERO_OID} ${OID} refs/heads/feature/a\0report-status side-band-64k`),
      pktLine(`${OID} ${ZERO_OID} refs/heads/old`),
      flushPkt(),
    ]);
    for (let i = 0; i < 2000; i += 1) {
      const bytes = Array.from(valid);
      for (let e = 0; e < 1 + Math.floor(random() * 5); e += 1) {
        const at = Math.floor(random() * (bytes.length + 1));
        const op = Math.floor(random() * 3);
        if (op === 0 && bytes.length > 0) bytes[at % bytes.length] = Math.floor(random() * 256);
        else if (op === 1) bytes.splice(at, 0, Math.floor(random() * 256));
        else bytes.length = Math.floor(random() * bytes.length);
      }
      const read = await readPushCommands(
        new PktLineReader(chunked(new Uint8Array(bytes), 1 + Math.floor(random() * 5))),
      );
      if ('list' in read) expect(read.list.capabilities).toContain('report-status');
    }
  });
});

describe('pushes in flight', () => {
  it('bounds the pushes of one mission, not of another, and frees a slot once', () => {
    const inFlight = inMemoryInFlightPushes(2);
    const first = inFlight.acquire('m1');
    const second = inFlight.acquire('m1');
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(inFlight.acquire('m1')).toBeNull();
    expect(inFlight.acquire('m2')).not.toBeNull();
    first!();
    first!();
    expect(inFlight.acquire('m1')).not.toBeNull();
    expect(inFlight.acquire('m1')).toBeNull();
  });
});
