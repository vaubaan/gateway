/**
 * The receive-pack side of git's smart HTTP protocol, as far as a push needs
 * it (gitprotocol-pack(5) "Reference Update Request and Packfile Transfer",
 * "Report Status" ; gitprotocol-http(5) "Smart Service git-receive-pack").
 *
 * Spec : docs/spec/vaubaan-gateway.md §4.1 ter "Git remote".
 * ADR  : docs/decisions/gateway-as-git-remote.md.
 *
 * Shared by the host's git door (which reads the agent's command list and
 * writes the report git prints) and by a plugin's `execute` (which sends the
 * reviewed ref updates to its provider's git server with a command list and
 * an empty pack). Pure, except `sendRefUpdates`, which takes its `fetch`.
 */

import { createHash } from 'node:crypto';

import { brandError, hasErrorBrand } from '@vaubaan/shared';

import {
  concatBytes,
  demultiplexSideBand,
  flushPkt,
  parsePktLines,
  pktLine,
  pktLineText,
  type Pkt,
} from './pkt-line.ts';

/** The null object id of SHA-1 repositories : "no ref" on either side of a command. */
export const ZERO_OID = '0'.repeat(40);
/** A SHA-1 object id, as git writes it. */
export const OID_SHAPE = /^[0-9a-f]{40}$/;

export const RECEIVE_PACK_SERVICE = 'git-receive-pack';
export const UPLOAD_PACK_SERVICE = 'git-upload-pack';
export const RECEIVE_PACK_REQUEST_TYPE = 'application/x-git-receive-pack-request';
export const RECEIVE_PACK_RESULT_TYPE = 'application/x-git-receive-pack-result';
export const UPLOAD_PACK_REQUEST_TYPE = 'application/x-git-upload-pack-request';
export const UPLOAD_PACK_RESULT_TYPE = 'application/x-git-upload-pack-result';

/** `application/x-<service>-advertisement`. */
export function advertisementType(service: string): string {
  return `application/x-${service}-advertisement`;
}

/** One line of a push's command list : `old new ref`, with `null` for the zero id. */
export interface RefCommand {
  readonly old: string | null;
  readonly new: string | null;
  readonly ref: string;
}

/** The command list of a push request, and the capabilities any of its lines asked for. */
export interface CommandList {
  readonly commands: readonly RefCommand[];
  readonly capabilities: readonly string[];
  /** `shallow <oid>` lines that preceded the commands. */
  readonly shallow: readonly string[];
  /** A push certificate was sent instead of a command list (never accepted here). */
  readonly pushCert: boolean;
}

export class GitProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitProtocolError';
    brandError(this, 'GitProtocolError');
  }
}

/** Whether `x` is a `GitProtocolError`, whatever copy of the SDK made it (the host asks this, never `instanceof`). */
export function isGitProtocolError(x: unknown): x is GitProtocolError {
  return hasErrorBrand(x, 'GitProtocolError');
}

function oidOrNull(value: string, line: string): string | null {
  if (!OID_SHAPE.test(value)) throw new GitProtocolError(`malformed object id in '${line}'`);
  return value === ZERO_OID ? null : value;
}

/** Parse one `old new ref` command. */
export function parseCommand(line: string): RefCommand {
  const parts = line.split(' ');
  if (parts.length !== 3 || parts[2] === '') {
    throw new GitProtocolError(`malformed push command '${line.slice(0, 120)}'`);
  }
  const [old, next, ref] = parts as [string, string, string];
  const command = { old: oidOrNull(old, line), new: oidOrNull(next, line), ref };
  if (command.old === null && command.new === null) {
    throw new GitProtocolError(`push command with two zero ids for '${ref.slice(0, 120)}'`);
  }
  return command;
}

/**
 * Read the command list of a push from its pkt-lines, up to and including
 * the flush-pkt that ends it. `next` yields the pkt-lines one at a time
 * (`PktLineReader.read`), so that nothing after the list is read.
 */
export async function readCommandList(next: () => Promise<Pkt | null>): Promise<CommandList> {
  const commands: RefCommand[] = [];
  const shallow: string[] = [];
  const capabilities: string[] = [];
  let pushCert = false;
  for (;;) {
    const pkt = await next();
    if (pkt === null) throw new GitProtocolError('the push request ended before its command list');
    if (pkt.kind === 'flush') break;
    if (pkt.kind !== 'data') throw new GitProtocolError('unexpected packet in the command list');
    let line = pktLineText(pkt) ?? '';
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      // git writes the feature list on the first command line, but receive-pack
      // honours one on any line: every one is collected, so that the door
      // refuses what it does not implement wherever it was written.
      for (const capability of line.slice(nul + 1).split(' ')) {
        if (capability && !capabilities.includes(capability)) capabilities.push(capability);
      }
      line = line.slice(0, nul);
    }
    if (line.startsWith('shallow ')) {
      shallow.push(line.slice('shallow '.length));
      continue;
    }
    if (line.startsWith('push-cert')) {
      pushCert = true;
      continue;
    }
    if (pushCert) continue;
    commands.push(parseCommand(line));
  }
  if (!pushCert && commands.length === 0) {
    throw new GitProtocolError('the push request carries no command');
  }
  return { commands, capabilities, shallow, pushCert };
}

/** The pkt-lines of a command list, capabilities on the first line, then the flush-pkt. */
export function encodeCommandList(
  commands: readonly RefCommand[],
  capabilities: readonly string[],
): Uint8Array<ArrayBuffer> {
  const lines = commands.map((c, i) => {
    const text = `${c.old ?? ZERO_OID} ${c.new ?? ZERO_OID} ${c.ref}`;
    return pktLine(
      i === 0 && capabilities.length > 0 ? `${text}\0${capabilities.join(' ')}` : text,
    );
  });
  return concatBytes([...lines, flushPkt()]);
}

/**
 * The empty pack : "PACK", version 2, zero objects, then its SHA-1. git
 * requires a pack after any create or update command, even when the server
 * already holds every object (gitprotocol-pack(5)).
 */
export function emptyPack(): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 0]);
  const digest = createHash('sha1').update(header).digest();
  return concatBytes([header, new Uint8Array(digest)]);
}

/** What a receive-pack server reported : the unpack status and one status per ref. */
export interface ReportStatus {
  /** `ok`, or the error the server gave for the pack. */
  readonly unpack: string;
  readonly refs: ReadonlyMap<
    string,
    { readonly ok: true } | { readonly ok: false; readonly error: string }
  >;
  /** Progress text of side-band channel 2. */
  readonly progress: string;
  /** Fatal text of side-band channel 3. */
  readonly errors: string;
}

/** Parse the report-status lines (already demultiplexed). */
export function parseReportLines(lines: readonly Pkt[]): Omit<ReportStatus, 'progress' | 'errors'> {
  let unpack = '';
  const refs = new Map<string, { ok: true } | { ok: false; error: string }>();
  for (const pkt of lines) {
    const text = pktLineText(pkt);
    if (text === null) continue;
    if (text.startsWith('unpack ')) unpack = text.slice('unpack '.length);
    else if (text.startsWith('ok ')) refs.set(text.slice(3), { ok: true });
    else if (text.startsWith('ng ')) {
      const rest = text.slice(3);
      const space = rest.indexOf(' ');
      const ref = space === -1 ? rest : rest.slice(0, space);
      refs.set(ref, { ok: false, error: space === -1 ? 'rejected' : rest.slice(space + 1) });
    }
  }
  return { unpack, refs };
}

/** Parse a whole receive-pack response body, side-band multiplexed or not. */
export function parseReceivePackResult(body: Uint8Array, sideBand: boolean): ReportStatus {
  const pkts = parsePktLines(body);
  if (!sideBand) return { ...parseReportLines(pkts), progress: '', errors: '' };
  const { data, progress, errors } = demultiplexSideBand(pkts);
  return { ...parseReportLines(data.length > 0 ? parsePktLines(data) : []), progress, errors };
}

/** The report-status a server writes, before any side-band wrapping. */
export function encodeReportStatus(
  unpack: string,
  refs: readonly { readonly ref: string; readonly error: string | null }[],
): Uint8Array<ArrayBuffer> {
  return concatBytes([
    pktLine(`unpack ${unpack}\n`),
    ...refs.map((r) => pktLine(r.error === null ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.error}\n`)),
    flushPkt(),
  ]);
}

/** The upstream git endpoint of one repository and the credential to present there. */
export interface GitUpstream {
  /** Repository URL without trailing slash (`https://github.com/acme/app.git`). */
  readonly url: string;
  /** Value of the `Authorization` header. In memory only ; never logged, never returned. */
  readonly authorization: string;
}

/** Capabilities the gateway asks of an upstream receive-pack for the pushes it sends itself. */
export const UPSTREAM_PUSH_CAPABILITIES = ['report-status', 'side-band-64k', 'quiet'] as const;

/**
 * Send ref updates whose objects the server already holds : the command
 * list, then an empty pack unless every command is a delete. Returns the
 * server's report. `old` of each command is the compare-and-swap value the
 * server checks before it moves the ref.
 */
export async function sendRefUpdates(input: {
  readonly fetch: typeof fetch;
  readonly upstream: GitUpstream;
  readonly commands: readonly RefCommand[];
  readonly atomic?: boolean;
  readonly agent?: string;
  readonly signal?: AbortSignal;
}): Promise<{ readonly status: number; readonly report: ReportStatus | null }> {
  const capabilities = [
    ...UPSTREAM_PUSH_CAPABILITIES,
    ...(input.atomic ? ['atomic'] : []),
    ...(input.agent ? [`agent=${input.agent}`] : []),
  ];
  const onlyDeletes = input.commands.every((c) => c.new === null);
  const body = concatBytes([
    encodeCommandList(input.commands, capabilities),
    ...(onlyDeletes ? [] : [emptyPack()]),
  ]);
  const res = await input.fetch(`${input.upstream.url}/${RECEIVE_PACK_SERVICE}`, {
    method: 'POST',
    headers: {
      Authorization: input.upstream.authorization,
      'Content-Type': RECEIVE_PACK_REQUEST_TYPE,
      Accept: RECEIVE_PACK_RESULT_TYPE,
    },
    body,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!res.ok) {
    await res.body?.cancel();
    return { status: res.status, report: null };
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, report: parseReceivePackResult(bytes, true) };
}
