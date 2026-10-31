/**
 * The git wire primitives of the SDK (spec vaubaan-gateway §4.1 ter; ADR
 * gateway-as-git-remote): pkt-line framing, the command list of a push, the
 * report-status and the ref advertisement. The command list is what an agent
 * controls byte for byte: it is read strictly, and a seeded fuzz checks that
 * no input makes the reader do anything but return a list or throw one of
 * the two protocol errors.
 */
import { describe, expect, it } from 'vitest';

import {
  concatBytes,
  emptyPack,
  encodeAdvertisement,
  encodeCommandList,
  encodeReportStatus,
  flushPkt,
  parseAdvertisement,
  parseCommand,
  parsePktLines,
  parseReceivePackResult,
  pktLine,
  PKT_LINE_MAX,
  PKT_PAYLOAD_MAX,
  PktLineError,
  PktLineReader,
  readCommandList,
  sideBand,
  SIDE_BAND,
  GitProtocolError,
  ZERO_OID,
  advertisementWithout,
  lsRefsWithout,
  prependChunk,
  readV2RequestHead,
  V2_HEAD_MAX_LINES,
  type CommandList,
} from '../../src/git/index.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const encoder = new TextEncoder();

/** A stream that yields `bytes` in chunks of `size` (1 = byte by byte). */
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

async function readList(bytes: Uint8Array, size = 7): Promise<CommandList> {
  const reader = new PktLineReader(chunked(bytes, size));
  return readCommandList(() => reader.read());
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) parts.push(chunk);
  return concatBytes(parts);
}

describe('pkt-line', () => {
  it('frames a payload with its length, prefix included', () => {
    expect(new TextDecoder().decode(pktLine('hi\n'))).toBe('0007hi\n');
    expect(new TextDecoder().decode(flushPkt())).toBe('0000');
  });

  it('refuses a payload longer than LARGE_PACKET_MAX allows', () => {
    expect(() => pktLine(new Uint8Array(PKT_PAYLOAD_MAX))).not.toThrow();
    expect(() => pktLine(new Uint8Array(PKT_PAYLOAD_MAX + 1))).toThrow(PktLineError);
  });

  it('parses special packets and refuses lengths 3, too large, or not hex', () => {
    expect(parsePktLines(encoder.encode('000000010002')).map((p) => p.kind)).toEqual([
      'flush',
      'delim',
      'response-end',
    ]);
    expect(() => parsePktLines(encoder.encode('0003'))).toThrow(PktLineError);
    const tooLong = (PKT_LINE_MAX + 1).toString(16).padStart(4, '0');
    expect(() => parsePktLines(encoder.encode(tooLong))).toThrow(PktLineError);
    expect(() => parsePktLines(encoder.encode('00zzab'))).toThrow(PktLineError);
    expect(() => parsePktLines(encoder.encode('0009ab'))).toThrow(PktLineError);
    expect(() => parsePktLines(encoder.encode('00'))).toThrow(PktLineError);
  });

  it('reads the same packets whatever the chunking, and hands the rest on untouched', async () => {
    const pack = new Uint8Array([0x50, 0x41, 0x43, 0x4b, 0, 1, 2, 3, 0xff, 0x00]);
    const body = concatBytes([pktLine('one\n'), pktLine('two\n'), flushPkt(), pack]);
    for (const size of [1, 2, 3, 5, 64, 4096]) {
      const reader = new PktLineReader(chunked(body, size));
      expect((await reader.read())?.kind).toBe('data');
      expect((await reader.read())?.kind).toBe('data');
      expect((await reader.read())?.kind).toBe('flush');
      expect(await drain(reader.rest())).toEqual(pack);
    }
  });

  it('refuses a stream that ends inside a pkt-line', async () => {
    const reader = new PktLineReader(chunked(encoder.encode('000ahel'), 2));
    await expect(reader.read()).rejects.toThrow(PktLineError);
  });

  it('splits side-band data into packets that fit', () => {
    const big = new Uint8Array(PKT_PAYLOAD_MAX * 2 + 10);
    const packets = sideBand(SIDE_BAND.data, big);
    expect(packets).toHaveLength(3);
    for (const p of packets) expect(p.length).toBeLessThanOrEqual(PKT_LINE_MAX);
  });
});

describe('the command list of a push', () => {
  it('reads every command, not only the first, with the capabilities of the first line', async () => {
    const list = await readList(
      encodeCommandList(
        [
          { old: A, new: B, ref: 'refs/heads/feature/a' },
          { old: null, new: C, ref: 'refs/heads/main' },
          { old: B, new: null, ref: 'refs/tags/v1' },
        ],
        ['report-status', 'side-band-64k', 'agent=git/2.48.1'],
      ),
    );
    expect(list.commands).toEqual([
      { old: A, new: B, ref: 'refs/heads/feature/a' },
      { old: null, new: C, ref: 'refs/heads/main' },
      { old: B, new: null, ref: 'refs/tags/v1' },
    ]);
    expect(list.capabilities).toEqual(['report-status', 'side-band-64k', 'agent=git/2.48.1']);
    expect(list.pushCert).toBe(false);
  });

  it('reads the zero id as "no ref" on either side, and refuses it on both', () => {
    expect(parseCommand(`${ZERO_OID} ${A} refs/heads/x`)).toEqual({
      old: null,
      new: A,
      ref: 'refs/heads/x',
    });
    expect(parseCommand(`${A} ${ZERO_OID} refs/heads/x`).new).toBeNull();
    expect(() => parseCommand(`${ZERO_OID} ${ZERO_OID} refs/heads/x`)).toThrow(GitProtocolError);
  });

  it.each([
    ['too few fields', `${A} ${B}`],
    ['too many fields', `${A} ${B} refs/heads/x extra`],
    ['an empty ref', `${A} ${B} `],
    ['a short id', `${A.slice(1)} ${B} refs/heads/x`],
    ['an uppercase id', `${A.toUpperCase()} ${B} refs/heads/x`],
    ['a sha-256 id', `${'a'.repeat(64)} ${B} refs/heads/x`],
  ])('refuses %s', (_name, line) => {
    expect(() => parseCommand(line)).toThrow(GitProtocolError);
  });

  it('records shallow lines and push certificates, and refuses an empty list', async () => {
    const shallow = await readList(
      concatBytes([
        pktLine(`shallow ${C}`),
        pktLine(`${A} ${B} refs/heads/x\0report-status`),
        flushPkt(),
      ]),
    );
    expect(shallow.shallow).toEqual([C]);
    const cert = await readList(
      concatBytes([
        pktLine('push-cert\0report-status'),
        pktLine('certificate version 0.1'),
        flushPkt(),
      ]),
    );
    expect(cert.pushCert).toBe(true);
    await expect(readList(flushPkt())).rejects.toThrow(GitProtocolError);
  });

  it('refuses a list that ends before its flush, or carries a delim packet', async () => {
    await expect(readList(pktLine(`${A} ${B} refs/heads/x`))).rejects.toThrow(GitProtocolError);
    await expect(
      readList(concatBytes([pktLine(`${A} ${B} refs/heads/x`), encoder.encode('0001')])),
    ).rejects.toThrow(GitProtocolError);
  });

  it('round-trips through encodeCommandList', async () => {
    const commands = Array.from({ length: 20 }, (_, i) => ({
      old: i % 3 === 0 ? null : A,
      new: i % 5 === 0 ? null : B,
      ref: `refs/heads/f/${i}`,
    })).filter((c) => c.old !== null || c.new !== null);
    const list = await readList(encodeCommandList(commands, ['report-status']), 1);
    expect(list.commands).toEqual(commands);
  });
});

/** Mulberry32: a small seeded generator, so a failing case can be replayed. */
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

/** A mutation of a valid list: bytes flipped, inserted, removed, lengths altered, truncated. */
function mutate(base: Uint8Array, random: () => number): Uint8Array {
  const bytes = Array.from(base);
  const edits = 1 + Math.floor(random() * 6);
  for (let i = 0; i < edits; i += 1) {
    const at = Math.floor(random() * (bytes.length + 1));
    const op = Math.floor(random() * 5);
    if (op === 0 && bytes.length > 0) bytes[at % bytes.length] = Math.floor(random() * 256);
    else if (op === 1) bytes.splice(at, 0, Math.floor(random() * 256));
    else if (op === 2 && bytes.length > 0) bytes.splice(at % bytes.length, 1);
    else if (op === 3) bytes.splice(at, 0, ...encoder.encode('0000'));
    else bytes.length = Math.floor(random() * bytes.length);
  }
  return new Uint8Array(bytes);
}

describe('the command list reader under fuzzing', () => {
  const valid = concatBytes([
    encodeCommandList(
      [
        { old: A, new: B, ref: 'refs/heads/feature/a' },
        { old: null, new: C, ref: 'refs/heads/main' },
      ],
      ['report-status', 'side-band-64k'],
    ),
    emptyPack(),
  ]);

  it('returns a well-formed list or throws a protocol error, for 4000 mutated inputs', async () => {
    const random = prng(0x5eed);
    for (let i = 0; i < 4000; i += 1) {
      const input =
        i % 10 === 0
          ? new Uint8Array(Math.floor(random() * 200)).map(() => Math.floor(random() * 256))
          : mutate(valid, random);
      try {
        const list = await readList(input, 1 + Math.floor(random() * 9));
        // Whatever was accepted is what the door reasons about: well-formed.
        for (const c of list.commands) {
          expect(c.ref.length).toBeGreaterThan(0);
          expect(c.ref.includes(' ')).toBe(false);
          expect(c.old === null || /^[0-9a-f]{40}$/.test(c.old)).toBe(true);
          expect(c.new === null || /^[0-9a-f]{40}$/.test(c.new)).toBe(true);
          expect(c.old !== null || c.new !== null).toBe(true);
        }
        expect(list.pushCert || list.commands.length > 0).toBe(true);
      } catch (err) {
        if (!(err instanceof GitProtocolError || err instanceof PktLineError)) {
          throw new Error(`input #${i} threw ${String(err)}`, { cause: err });
        }
      }
    }
  });
});

describe('report-status and the advertisement', () => {
  it('round-trips a report, plain and side-band', () => {
    const report = encodeReportStatus('ok', [
      { ref: 'refs/heads/a', error: null },
      { ref: 'refs/heads/b', error: 'stale info' },
    ]);
    const plain = parseReceivePackResult(report, false);
    expect(plain.unpack).toBe('ok');
    expect(plain.refs.get('refs/heads/a')).toEqual({ ok: true });
    expect(plain.refs.get('refs/heads/b')).toEqual({ ok: false, error: 'stale info' });
    const banded = parseReceivePackResult(
      concatBytes([
        ...sideBand(SIDE_BAND.progress, encoder.encode('hello\n')),
        ...sideBand(SIDE_BAND.data, report),
        flushPkt(),
      ]),
      true,
    );
    expect(banded.progress).toBe('hello\n');
    expect(banded.refs.size).toBe(2);
  });

  it('round-trips an advertisement, empty repositories included', () => {
    const ad = {
      service: 'git-receive-pack',
      refs: [
        { oid: A, name: 'refs/heads/main' },
        { oid: B, name: 'refs/tags/v1' },
      ],
      capabilities: ['report-status', 'delete-refs'],
    };
    expect(parseAdvertisement(encodeAdvertisement(ad))).toEqual(ad);
    expect(parseAdvertisement(encodeAdvertisement({ ...ad, refs: [] })).refs).toEqual([]);
    expect(() => parseAdvertisement(pktLine('nope\n'))).toThrow(GitProtocolError);
  });
});

describe('a feature list on any command line', () => {
  it('is collected, so that the door judges it wherever it was written', async () => {
    const list = await readList(
      concatBytes([
        pktLine(`${ZERO_OID} ${A} refs/heads/a\0report-status`),
        pktLine(`${ZERO_OID} ${B} refs/heads/b\0atomic report-status push-options`),
        flushPkt(),
      ]),
    );
    expect(list.commands.map((c) => c.ref)).toEqual(['refs/heads/a', 'refs/heads/b']);
    expect(list.capabilities).toEqual(['report-status', 'atomic', 'push-options']);
  });
});

describe('prependChunk', () => {
  it('yields the head, then the rest, and passes an error of the rest on', async () => {
    const head = encoder.encode('head');
    expect(
      new TextDecoder().decode(
        await drain(prependChunk(head, chunked(encoder.encode('-rest'), 2))),
      ),
    ).toBe('head-rest');
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('gone'));
      },
    });
    await expect(drain(prependChunk(head, failing))).rejects.toThrow('gone');
  });
});

describe('the head of a v2 request', () => {
  const head = (lines: readonly string[], end: 'delim' | 'flush' | 'none' = 'delim') =>
    concatBytes([
      ...lines.map((l) => pktLine(`${l}\n`)),
      ...(end === 'delim' ? [encoder.encode('0001')] : end === 'flush' ? [flushPkt()] : []),
    ]);
  const readHead = (bytes: Uint8Array, size = 3) =>
    readV2RequestHead(new PktLineReader(chunked(bytes, size)));

  it('names its one command, wherever the line is, and keeps the bytes to send on', async () => {
    const bytes = head(['agent=git/2.48.1', 'object-format=sha1', 'command=ls-refs']);
    const read = await readHead(concatBytes([bytes, pktLine('peel\n'), flushPkt()]));
    expect(read.command).toBe('ls-refs');
    expect(read.bytes).toEqual(bytes);
  });

  it.each([
    ['no command', head(['agent=x'])],
    ['two commands', head(['command=ls-refs', 'command=fetch'])],
    ['an empty command', head(['command='])],
    ['no end', head(['command=fetch'], 'none')],
    [
      'too many lines',
      head([...Array.from({ length: V2_HEAD_MAX_LINES + 1 }, () => 'x'), 'command=fetch']),
    ],
  ])('refuses %s', async (_name, bytes) => {
    await expect(readHead(bytes)).rejects.toBeInstanceOf(GitProtocolError);
  });

  it('accepts exactly the heads with one command, for 3000 generated inputs', async () => {
    const random = prng(0xbeef);
    const pool = [
      'command=ls-refs',
      'command=fetch',
      'command=object-info',
      'agent=git/x',
      'object-format=sha1',
      'server-option=a',
      'command=',
      'junk',
    ];
    for (let i = 0; i < 3000; i += 1) {
      const lines = Array.from(
        { length: Math.floor(random() * 6) },
        () => pool[Math.floor(random() * pool.length)]!,
      );
      const end = (['delim', 'flush', 'none'] as const)[Math.floor(random() * 3)]!;
      const commands = lines.filter((l) => l.startsWith('command='));
      const expected =
        end !== 'none' && commands.length === 1 && commands[0] !== 'command='
          ? commands[0]!.slice(8)
          : null;
      try {
        const read = await readHead(head(lines, end), 1 + Math.floor(random() * 7));
        expect(read.command, `input #${i}`).toBe(expected);
      } catch (err) {
        if (!(err instanceof GitProtocolError)) throw err;
        expect(expected, `input #${i}`).toBeNull();
      }
    }
  });
});

describe('the refs a fetch lists', () => {
  const hidden = (ref: string) => ref.startsWith('refs/vaubaan/');
  const names = (body: Uint8Array) =>
    parsePktLines(body)
      .flatMap((p) => (p.kind === 'data' ? [new TextDecoder().decode(p.payload)] : []))
      .map((t) => t.replace(/\0.*$/s, '').trimEnd());

  it('a v0 advertisement loses the hidden refs, and the capabilities move to the next kept ref', () => {
    const ad = concatBytes([
      pktLine('# service=git-upload-pack\n'),
      flushPkt(),
      pktLine(`${A} refs/vaubaan/0123\0multi_ack symref=HEAD:refs/heads/main\n`),
      pktLine(`${B} refs/heads/main\n`),
      pktLine(`${C} refs/tags/v1\n`),
      pktLine(`${A} refs/tags/v1^{}\n`),
      flushPkt(),
    ]);
    const out = advertisementWithout(ad, hidden);
    expect(names(out)).toEqual([
      '# service=git-upload-pack',
      `${B} refs/heads/main`,
      `${C} refs/tags/v1`,
      `${A} refs/tags/v1^{}`,
    ]);
    expect(new TextDecoder().decode(out)).toContain(
      `${B} refs/heads/main\0multi_ack symref=HEAD:refs/heads/main`,
    );
    expect(parseAdvertisement(out).capabilities).toEqual([
      'multi_ack',
      'symref=HEAD:refs/heads/main',
    ]);
  });

  it('an advertisement of hidden refs only keeps its capabilities on the placeholder line', () => {
    const ad = concatBytes([
      pktLine('# service=git-upload-pack\n'),
      flushPkt(),
      pktLine(`${A} refs/vaubaan/0123\0ofs-delta\n`),
      flushPkt(),
    ]);
    const parsed = parseAdvertisement(advertisementWithout(ad, hidden));
    expect(parsed.refs).toEqual([]);
    expect(parsed.capabilities).toEqual(['ofs-delta']);
  });

  it('a v2 capability advertisement and an ls-refs answer', () => {
    const v2 = concatBytes([
      pktLine('# service=git-upload-pack\n'),
      flushPkt(),
      pktLine('version 2\n'),
      pktLine('ls-refs\n'),
      flushPkt(),
    ]);
    expect(advertisementWithout(v2, hidden)).toEqual(v2);
    const ls = concatBytes([
      pktLine(`${A} HEAD symref-target:refs/heads/main\n`),
      pktLine(`${B} refs/vaubaan/0123\n`),
      pktLine(`${C} refs/heads/main\n`),
      flushPkt(),
    ]);
    expect(names(lsRefsWithout(ls, hidden))).toEqual([
      `${A} HEAD symref-target:refs/heads/main`,
      `${C} refs/heads/main`,
    ]);
  });
});
