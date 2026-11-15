/**
 * pkt-line — the framing of git's wire protocol (gitprotocol-common(5)).
 *
 * Spec : docs/spec/vaubaan-gateway.md §4.1 ter "Git remote" (the second door
 *        of the execution surface).
 * ADR  : docs/decisions/gateway-as-git-remote.md.
 *
 * A pkt-line is four lowercase hex digits giving the length of the whole
 * line (the four digits included), then the payload. `0000` is the
 * flush-pkt, `0001` the delim-pkt and `0002` the response-end-pkt of
 * protocol v2. A payload is at most 65516 bytes.
 *
 * Pure and dependency-free : the host's git door and the plugins that speak
 * to their service's git server share it. Nothing here buffers more than
 * one pkt-line : the pack that follows the command list of a push is handed
 * on as a stream (`PktLineReader.rest`).
 */

import { brandError, hasErrorBrand } from '@vaubaan/shared';

/** Longest pkt-line, length prefix included (gitprotocol-common(5) `LARGE_PACKET_MAX`). */
export const PKT_LINE_MAX = 65520;
/** Longest payload of one pkt-line. */
export const PKT_PAYLOAD_MAX = PKT_LINE_MAX - 4;

export const FLUSH_PKT = '0000';
export const DELIM_PKT = '0001';
export const RESPONSE_END_PKT = '0002';

/** Side-band channels (gitprotocol-pack(5) "side-band, side-band-64k"). */
export const SIDE_BAND = { data: 1, progress: 2, error: 3 } as const;
/** Payload of one side-band-64k packet, the band byte excluded. */
export const SIDE_BAND_64K_DATA_MAX = PKT_PAYLOAD_MAX - 1;

export type Pkt =
  | { readonly kind: 'data'; readonly payload: Uint8Array }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

import { prependChunk, streamOf } from './streams.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class PktLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PktLineError';
    brandError(this, 'PktLineError');
  }
}

/** Whether `x` is a `PktLineError`, whatever copy of the SDK made it (the host asks this, never `instanceof`). */
export function isPktLineError(x: unknown): x is PktLineError {
  return hasErrorBrand(x, 'PktLineError');
}

/** One pkt-line carrying `payload` (a string is UTF-8 encoded as is, newline included). */
export function pktLine(payload: string | Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = typeof payload === 'string' ? encoder.encode(payload) : payload;
  if (bytes.length > PKT_PAYLOAD_MAX) {
    throw new PktLineError(`pkt-line payload of ${bytes.length} bytes exceeds ${PKT_PAYLOAD_MAX}`);
  }
  const out = new Uint8Array(bytes.length + 4);
  out.set(encoder.encode((bytes.length + 4).toString(16).padStart(4, '0')), 0);
  out.set(bytes, 4);
  return out;
}

export function flushPkt(): Uint8Array<ArrayBuffer> {
  return encoder.encode(FLUSH_PKT);
}

/** Concatenate byte chunks. */
export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** The payload as text (git's text lines are ASCII; a trailing LF is kept). */
export function pktText(pkt: Pkt): string | null {
  return pkt.kind === 'data' ? decoder.decode(pkt.payload) : null;
}

/** The payload as text without its trailing LF. */
export function pktLineText(pkt: Pkt): string | null {
  const text = pktText(pkt);
  return text === null ? null : text.replace(/\n$/, '');
}

/** Length of the pkt-line that starts `buffer`, or `null` when fewer than four bytes are there. */
function headerLength(buffer: Uint8Array): number | null {
  if (buffer.length < 4) return null;
  const hex = decoder.decode(buffer.subarray(0, 4));
  if (!/^[0-9a-f]{4}$/i.test(hex)) throw new PktLineError(`malformed pkt-line length '${hex}'`);
  const length = Number.parseInt(hex, 16);
  if (length === 3 || length > PKT_LINE_MAX) {
    throw new PktLineError(`invalid pkt-line length ${length}`);
  }
  return length;
}

function specialPkt(length: number): Pkt | null {
  if (length === 0) return { kind: 'flush' };
  if (length === 1) return { kind: 'delim' };
  if (length === 2) return { kind: 'response-end' };
  return null;
}

/** Every pkt-line of a complete buffer ; throws on a truncated or malformed one. */
export function parsePktLines(buffer: Uint8Array): Pkt[] {
  const out: Pkt[] = [];
  let at = 0;
  while (at < buffer.length) {
    const length = headerLength(buffer.subarray(at));
    if (length === null) throw new PktLineError('truncated pkt-line length');
    const special = specialPkt(length);
    if (special) {
      out.push(special);
      at += 4;
      continue;
    }
    if (at + length > buffer.length) throw new PktLineError('truncated pkt-line');
    out.push({ kind: 'data', payload: buffer.slice(at + 4, at + length) });
    at += length;
  }
  return out;
}

/**
 * Reads pkt-lines off a byte stream, one at a time, and hands the rest of
 * the stream on untouched (`rest`) : the command list of a push is read, the
 * pack after it is relayed without being held.
 */
export class PktLineReader {
  private buffer: Uint8Array = new Uint8Array(0);
  private ended = false;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  /** Bytes read off the stream so far (consumed pkt-lines and what is buffered). */
  bytesRead = 0;

  /** The next pkt-line, or `null` at the end of the stream (between two pkt-lines). */
  async read(): Promise<Pkt | null> {
    for (;;) {
      const length = headerLength(this.buffer);
      if (length !== null) {
        const special = specialPkt(length);
        if (special) {
          this.buffer = this.buffer.subarray(4);
          return special;
        }
        if (this.buffer.length >= length) {
          const payload = this.buffer.slice(4, length);
          this.buffer = this.buffer.subarray(length);
          return { kind: 'data', payload };
        }
      }
      if (this.ended) {
        if (this.buffer.length === 0) return null;
        throw new PktLineError('the stream ended inside a pkt-line');
      }
      await this.fill();
    }
  }

  /** What is left of the stream after the pkt-lines read : the buffered bytes, then the rest. */
  rest(): ReadableStream<Uint8Array> {
    const head = this.buffer;
    this.buffer = new Uint8Array(0);
    return prependChunk(head, streamOf(this.reader));
  }

  /** Stops reading the underlying stream. */
  async cancel(reason?: unknown): Promise<void> {
    await this.reader.cancel(reason);
  }

  private async fill(): Promise<void> {
    const { done, value } = await this.reader.read();
    if (done) {
      this.ended = true;
      return;
    }
    this.bytesRead += value.length;
    this.buffer = this.buffer.length === 0 ? value : concatBytes([this.buffer, value]);
  }
}

/**
 * Split a side-band multiplexed response into its three channels. `data`
 * keeps the bytes of channel 1 in order ; `progress` and `errors` are the
 * text of channels 2 and 3.
 */
export function demultiplexSideBand(pkts: readonly Pkt[]): {
  readonly data: Uint8Array;
  readonly progress: string;
  readonly errors: string;
} {
  const data: Uint8Array[] = [];
  let progress = '';
  let errors = '';
  for (const pkt of pkts) {
    if (pkt.kind !== 'data' || pkt.payload.length === 0) continue;
    const band = pkt.payload[0];
    const rest = pkt.payload.subarray(1);
    if (band === SIDE_BAND.data) data.push(rest);
    else if (band === SIDE_BAND.progress) progress += decoder.decode(rest);
    else if (band === SIDE_BAND.error) errors += decoder.decode(rest);
  }
  return { data: concatBytes(data), progress, errors };
}

/** Wrap `bytes` in side-band packets of `band`, at most `SIDE_BAND_64K_DATA_MAX` per packet. */
export function sideBand(band: number, bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += SIDE_BAND_64K_DATA_MAX) {
    const slice = bytes.subarray(at, at + SIDE_BAND_64K_DATA_MAX);
    const payload = new Uint8Array(slice.length + 1);
    payload[0] = band;
    payload.set(slice, 1);
    out.push(pktLine(payload));
  }
  return out;
}

/** The bytes of one pkt-line as it travels (a data line re-framed, a special packet as is). */
export function encodePkt(pkt: Pkt): Uint8Array<ArrayBuffer> {
  switch (pkt.kind) {
    case 'data':
      return pktLine(pkt.payload);
    case 'flush':
      return encoder.encode(FLUSH_PKT);
    case 'delim':
      return encoder.encode(DELIM_PKT);
    case 'response-end':
      return encoder.encode(RESPONSE_END_PKT);
  }
}

/**
 * A ref name or any value quoted in a refusal git prints: printable ASCII
 * only (anything else becomes `?`), at most 120 characters.
 */
export function printableRef(value: string): string {
  const clean = value.replace(/[^\x20-\x7e]/g, '?');
  return clean.length > 120 ? `${clean.slice(0, 120)}…` : clean;
}
