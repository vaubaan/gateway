/**
 * The ref advertisement of git's smart HTTP protocol, version 0/1
 * (gitprotocol-http(5) "Smart Clients", gitprotocol-pack(5) "Reference
 * Discovery") : what `GET <repo>/info/refs?service=git-receive-pack` answers.
 *
 * Spec : docs/spec/vaubaan-gateway.md §4.1 ter "Git remote".
 * ADR  : docs/decisions/gateway-as-git-remote.md.
 *
 * The host's git door reads the upstream advertisement of a push and writes
 * the one git sees : the same refs minus the gateway's own temporary refs,
 * and only the capabilities the door implements. A plugin reads it to learn
 * the current value of a ref and the capabilities of its service's server.
 */

import {
  concatBytes,
  flushPkt,
  parsePktLines,
  pktLine,
  pktLineText,
  PktLineError,
} from './pkt-line.ts';
import { GitProtocolError, ZERO_OID } from './receive-pack.ts';

export interface AdvertisedRef {
  readonly oid: string;
  readonly name: string;
}

export interface Advertisement {
  /** `git-receive-pack` or `git-upload-pack`. */
  readonly service: string;
  readonly refs: readonly AdvertisedRef[];
  readonly capabilities: readonly string[];
}

/** The placeholder line of a repository without any ref (gitprotocol-pack(5)). */
const NO_REFS = 'capabilities^{}';

/** Parse a smart HTTP v0/v1 advertisement (`# service=…`, flush, refs, flush). */
export function parseAdvertisement(body: Uint8Array): Advertisement {
  let pkts;
  try {
    pkts = parsePktLines(body);
  } catch (err) {
    if (err instanceof PktLineError) throw new GitProtocolError(err.message);
    throw err;
  }
  const first = pkts[0] ? pktLineText(pkts[0]) : null;
  if (first === null || !first.startsWith('# service=')) {
    throw new GitProtocolError('the advertisement does not start with "# service="');
  }
  const service = first.slice('# service='.length);
  let index = 1;
  if (pkts[index]?.kind === 'flush') index += 1;
  // Protocol v1 announces itself before the refs.
  if (pkts[index] && pktLineText(pkts[index]!) === 'version 1') index += 1;
  const refs: AdvertisedRef[] = [];
  let capabilities: string[] = [];
  for (; index < pkts.length; index++) {
    const pkt = pkts[index]!;
    if (pkt.kind === 'flush') break;
    let text = pktLineText(pkt) ?? '';
    const nul = text.indexOf('\0');
    if (nul !== -1) {
      capabilities = text
        .slice(nul + 1)
        .split(' ')
        .filter(Boolean);
      text = text.slice(0, nul);
    }
    const space = text.indexOf(' ');
    if (space === -1) throw new GitProtocolError('malformed advertised ref');
    const oid = text.slice(0, space);
    const name = text.slice(space + 1);
    if (name === NO_REFS) continue;
    refs.push({ oid, name });
  }
  return { service, refs, capabilities };
}

/** Write a smart HTTP v0 advertisement : the service line, a flush, the refs with the capabilities on the first. */
export function encodeAdvertisement(ad: Advertisement): Uint8Array<ArrayBuffer> {
  const caps = ad.capabilities.join(' ');
  const refLines =
    ad.refs.length === 0
      ? [pktLine(`${ZERO_OID} ${NO_REFS}\0${caps}\n`)]
      : ad.refs.map((ref, i) =>
          pktLine(i === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`),
        );
  return concatBytes([pktLine(`# service=${ad.service}\n`), flushPkt(), ...refLines, flushPkt()]);
}
