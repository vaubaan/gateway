/**
 * Property-based tests of the git wire readers: a push's pkt-lines and its
 * `old new ref` commands come from the agent's git client, the advertisement
 * and the report from the provider. Each reader is fed arbitrary bytes.
 *
 * Properties: a reader returns or throws its own typed error, nothing else;
 * what is encoded reads back the same. Seeded and replayable
 * (`propertyRuns`, FC_SEED / FC_RUNS).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  encodePkt,
  GitProtocolError,
  parseAdvertisement,
  parseCommand,
  parsePktLines,
  parseReceivePackResult,
  PKT_PAYLOAD_MAX,
  PktLineError,
  type Pkt,
} from '../../src/git/index.ts';
import { propertyRuns } from '../../src/testing/property.ts';

const typed = (err: unknown): boolean =>
  err instanceof PktLineError || err instanceof GitProtocolError;

/** Bytes that look like pkt-lines often enough to get past the first header. */
const wireBytes = fc.oneof(
  fc.uint8Array({ maxLength: 300 }),
  fc
    .array(
      fc.oneof(
        fc.constantFrom(
          '0000',
          '0001',
          '0002',
          '0004',
          '0005',
          '000a',
          'fff0',
          'ffff',
          'zzzz',
          '00',
        ),
        fc.string({ maxLength: 12 }),
      ),
      { maxLength: 20 },
    )
    .map((parts) => new TextEncoder().encode(parts.join(''))),
);

const pkt: fc.Arbitrary<Pkt> = fc.oneof(
  fc.constant<Pkt>({ kind: 'flush' }),
  fc.constant<Pkt>({ kind: 'delim' }),
  fc.constant<Pkt>({ kind: 'response-end' }),
  fc
    .uint8Array({ minLength: 1, maxLength: 200 })
    .map((payload): Pkt => ({ kind: 'data', payload })),
);

describe('git wire — properties', () => {
  it('pkt-lines read back as they were encoded', () => {
    fc.assert(
      fc.property(fc.array(pkt, { maxLength: 12 }), (pkts) => {
        const bytes = new Uint8Array(pkts.flatMap((p) => [...encodePkt(p)]));
        expect(parsePktLines(bytes)).toEqual(pkts);
      }),
      propertyRuns(),
    );
  });

  it('arbitrary bytes are read or refused with a typed error, by every reader', () => {
    fc.assert(
      fc.property(wireBytes, fc.boolean(), (bytes, sideBand) => {
        for (const read of [
          () => parsePktLines(bytes),
          () => parseAdvertisement(bytes),
          () => parseReceivePackResult(bytes, sideBand),
        ]) {
          try {
            read();
          } catch (err) {
            expect(typed(err), String(err)).toBe(true);
          }
        }
      }),
      propertyRuns(),
    );
  });

  it('a push command is parsed or refused with GitProtocolError', () => {
    const oid = fc.oneof(
      fc.stringMatching(/^[0-9a-f]{40}$/),
      fc.constant('0'.repeat(40)),
      fc.string({ maxLength: 42 }),
    );
    const line = fc.oneof(
      fc.tuple(oid, oid, fc.string({ maxLength: 40 })).map(([a, b, r]) => `${a} ${b} ${r}`),
      fc.string({ maxLength: 120 }),
    );
    fc.assert(
      fc.property(line, (text) => {
        try {
          const command = parseCommand(text);
          expect(command.old !== null || command.new !== null).toBe(true);
          expect(command.ref.length).toBeGreaterThan(0);
        } catch (err) {
          expect(err).toBeInstanceOf(GitProtocolError);
        }
      }),
      propertyRuns(),
    );
  });

  it('a payload longer than a pkt-line can hold is never encoded silently', () => {
    expect(() =>
      encodePkt({ kind: 'data', payload: new Uint8Array(PKT_PAYLOAD_MAX + 1) }),
    ).toThrow();
  });
});
