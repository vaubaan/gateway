/**
 * The upload-pack side of git's wire protocol, as far as the door needs it
 * (gitprotocol-v2(5) "Command Request", "ls-refs"; gitprotocol-pack(5)
 * "Reference Discovery").
 *
 * Spec : docs/spec/vaubaan-gateway.md §4.1 ter "Git remote".
 * ADR  : docs/decisions/gateway-as-git-remote.md D3.
 *
 *   - the head of a protocol v2 request: its capability lines up to the
 *     delim-pkt (or the flush-pkt), with exactly one `command=` line. The
 *     door decides from it whether the request only lists refs (`ls-refs`)
 *     or transfers objects; a head that names no command or two is refused;
 *   - the filters that keep the gateway's temporary refs out of what a fetch
 *     lists: the v0/v1 advertisement and the v2 `ls-refs` answer.
 */
import {
  concatBytes,
  encodePkt,
  parsePktLines,
  PktLineError,
  pktLine,
  pktLineText,
  type Pkt,
  type PktLineReader,
} from './pkt-line.ts';
import { GitProtocolError, ZERO_OID } from './receive-pack.ts';

/** Lines a v2 request head may carry before its delim-pkt (git sends about five). */
export const V2_HEAD_MAX_LINES = 64;

export interface V2RequestHead {
  /** The value of the one `command=` line (`ls-refs`, `fetch`, `object-info`…). */
  readonly command: string;
  /** The head's bytes, to send on before the rest of the body. */
  readonly bytes: Uint8Array<ArrayBuffer>;
}

/**
 * Read the head of a v2 request: capability lines up to and including the
 * delim-pkt, or the flush-pkt of a request without arguments. Exactly one
 * `command=` line, or `GitProtocolError`.
 */
export async function readV2RequestHead(reader: PktLineReader): Promise<V2RequestHead> {
  const pkts: Pkt[] = [];
  const commands: string[] = [];
  for (;;) {
    let pkt: Pkt | null;
    try {
      pkt = await reader.read();
    } catch (err) {
      if (err instanceof PktLineError) throw new GitProtocolError(err.message);
      throw err;
    }
    if (pkt === null) throw new GitProtocolError('the request ended before its arguments');
    pkts.push(pkt);
    if (pkt.kind === 'delim' || pkt.kind === 'flush') break;
    if (pkt.kind !== 'data') throw new GitProtocolError('unexpected packet in the request head');
    if (pkts.length > V2_HEAD_MAX_LINES) throw new GitProtocolError('the request head is too long');
    const line = pktLineText(pkt) ?? '';
    if (line.startsWith('command=')) commands.push(line.slice('command='.length));
  }
  if (commands.length !== 1 || !commands[0]) {
    throw new GitProtocolError(
      commands.length === 0
        ? 'the request names no command'
        : 'the request names more than one command',
    );
  }
  return { command: commands[0], bytes: concatBytes(pkts.map(encodePkt)) };
}

/** Is `name` (or the tag it peels, `name^{}`) one of the hidden refs? */
function hiddenName(name: string, hidden: (ref: string) => boolean): boolean {
  return hidden(name.endsWith('^{}') ? name.slice(0, -3) : name);
}

/**
 * A v0/v1 smart HTTP advertisement without the refs `hidden` names. The
 * capabilities ride the first ref line: when that one is hidden they move to
 * the next line kept, or to the `capabilities^{}` placeholder when none is.
 * A protocol v2 capability advertisement lists no ref and is returned as is.
 */
export function advertisementWithout(
  body: Uint8Array,
  hidden: (ref: string) => boolean,
): Uint8Array {
  let pkts: Pkt[];
  try {
    pkts = parsePktLines(body);
  } catch {
    throw new GitProtocolError('the advertisement could not be read');
  }
  const texts = pkts.map((p) => pktLineText(p));
  if (texts.some((t) => t === 'version 2')) return body;
  const out: Uint8Array[] = [];
  let caps: string | null = null;
  let firstRef = true;
  let keptRef = false;
  let inRefs = false;
  let i = 0;
  for (; i < pkts.length; i++) {
    const pkt = pkts[i]!;
    const text = texts[i];
    if (!inRefs) {
      out.push(encodePkt(pkt));
      // The service line and its flush, then an optional `version 1`, then refs.
      if (pkt.kind === 'flush') inRefs = true;
      continue;
    }
    if (pkt.kind === 'flush') break;
    if (text === 'version 1') {
      out.push(encodePkt(pkt));
      continue;
    }
    let line = text ?? '';
    if (firstRef) {
      firstRef = false;
      const nul = line.indexOf('\0');
      if (nul !== -1) {
        caps = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const name = line.slice(line.indexOf(' ') + 1);
    if (hiddenName(name, hidden)) continue;
    out.push(pktLine(caps !== null && !keptRef ? `${line}\0${caps}\n` : `${line}\n`));
    keptRef = true;
  }
  if (!keptRef && caps !== null) out.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  for (; i < pkts.length; i++) out.push(encodePkt(pkts[i]!));
  return concatBytes(out);
}

/** The answer to a v2 `ls-refs` without the refs `hidden` names (`<oid> <name>[ attrs]` lines). */
export function lsRefsWithout(body: Uint8Array, hidden: (ref: string) => boolean): Uint8Array {
  let pkts: Pkt[];
  try {
    pkts = parsePktLines(body);
  } catch {
    throw new GitProtocolError('the ref listing could not be read');
  }
  return concatBytes(
    pkts
      .filter((pkt) => {
        const text = pktLineText(pkt);
        if (text === null) return true;
        const name = text.split(' ')[1] ?? '';
        return !hiddenName(name, hidden);
      })
      .map(encodePkt),
  );
}
