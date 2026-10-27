/**
 * The objects of a received pack, read before a byte of it leaves the
 * gateway (gitformat-pack(5) "pack-*.pack files have the following format" ;
 * ADR gateway-as-git-remote).
 *
 * Spec : docs/spec/vaubaan-gateway.md §4.1 ter "Git remote".
 * ADR  : docs/decisions/gateway-as-git-remote.md,
 *        docs/decisions/gateway-as-git-remote.md.
 *
 * What a plugin needs from a push's own objects is its commits, trees and
 * tags (what a ref points at, which tree a directory is). Blobs are inflated
 * to find where the next object starts, then dropped. Every object kept is
 * stored under the SHA-1 computed HERE from its content: an object is found
 * under an id only if its bytes hash to that id, so a garbled, truncated or
 * forged pack can only make objects missing, never wrong.
 *
 * Best effort and bounded: the reader never throws. A pack it cannot read to
 * the end (garbled, over a limit, a delta whose base it does not hold) yields
 * the objects it read and `complete: false`. The caller treats a missing
 * object as unknown — never as unchanged — so an incomplete read fails closed.
 *
 *   per object   at most `maxObjectBytes` inflated (GitHub refuses files over
 *                100 MB: nothing legitimate is lost below 128 MiB)
 *   inflated     at most `maxInflatedBytes` inflated over the whole pack
 *   kept         at most `maxKeptBytes` of commits, trees, tags and pending
 *                deltas held in memory
 *   objects      at most `maxObjects` entries
 *
 * Blobs are hashed, not kept: a delta against a blob is a blob. A chain of
 * blob deltas by id (`REF_DELTA`, a client that does not use offset deltas)
 * leaves the read incomplete — only blobs are missing then, and git pushes
 * with offset deltas whenever the server offers them, as the door does.
 *
 * Inflating is synchronous: the reader yields to the event loop every
 * `YIELD_EVERY_BYTES` inflated, so that one large push does not stall others.
 */
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly body: Uint8Array;
}

/** The commits, trees and tags of a pack, by the id their content hashes to. */
export interface GitPackObjects {
  get(oid: string): GitObject | undefined;
  /** Commits, trees and tags held. */
  readonly size: number;
  /** `false` when the pack could not be read to its end (an object may be missing). */
  readonly complete: boolean;
}

export interface PackReadLimits {
  readonly maxObjectBytes: number;
  readonly maxInflatedBytes: number;
  readonly maxKeptBytes: number;
  readonly maxObjects: number;
}

const MIB = 1024 * 1024;

export const DEFAULT_PACK_READ_LIMITS: PackReadLimits = {
  maxObjectBytes: 128 * MIB,
  maxInflatedBytes: 2048 * MIB,
  maxKeptBytes: 64 * MIB,
  maxObjects: 1_000_000,
};

const YIELD_EVERY_BYTES = 8 * MIB;

const PACK_SIGNATURE = 'PACK';
const PACK_HEADER_BYTES = 12;
const OID_BYTES = 20;
const TYPE_BY_CODE: Readonly<Record<number, GitObjectType>> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};
const OFS_DELTA = 6;
const REF_DELTA = 7;

const EMPTY: GitPackObjects = { get: () => undefined, size: 0, complete: true };

class PackEnd extends Error {}

/** The id git gives an object: SHA-1 of `<type> <size>\0<body>`. */
export function objectId(type: GitObjectType, body: Uint8Array): string {
  return createHash('sha1').update(`${type} ${body.length}\0`).update(body).digest('hex');
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex');
}

/** One entry's type code and declared inflated size; `next` is where its data starts. */
function entryHeader(pack: Uint8Array, at: number): { code: number; size: number; next: number } {
  let byte = pack[at];
  if (byte === undefined) throw new PackEnd();
  const code = (byte >> 4) & 0x7;
  let size = byte & 0x0f;
  let shift = 4;
  let next = at + 1;
  while (byte & 0x80) {
    byte = pack[next];
    if (byte === undefined || shift > 49) throw new PackEnd();
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    next += 1;
  }
  return { code, size, next };
}

/** The negative offset of an ofs-delta's base (gitformat-pack "offset encoding"). */
function ofsDeltaOffset(pack: Uint8Array, at: number): { offset: number; next: number } {
  let byte = pack[at];
  if (byte === undefined) throw new PackEnd();
  let offset = byte & 0x7f;
  let next = at + 1;
  while (byte & 0x80) {
    byte = pack[next];
    if (byte === undefined || offset > 2 ** 40) throw new PackEnd();
    offset = (offset + 1) * 128 + (byte & 0x7f);
    next += 1;
  }
  return { offset, next };
}

function deltaVarint(delta: Uint8Array, at: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let next = at;
  for (;;) {
    const byte = delta[next];
    if (byte === undefined || shift > 49) throw new PackEnd();
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    next += 1;
    if (!(byte & 0x80)) return { value, next };
  }
}

/** `base` with `delta` applied (gitformat-pack "Deltified representation"); throws when malformed. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  const source = deltaVarint(delta, 0);
  if (source.value !== base.length) throw new PackEnd();
  const target = deltaVarint(delta, source.next);
  const out = new Uint8Array(target.value);
  let written = 0;
  let at = target.next;
  while (at < delta.length) {
    const op = delta[at++]!;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) offset += delta[at++]! * 2 ** (8 * i);
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (1 << (4 + i))) size += delta[at++]! * 2 ** (8 * i);
      }
      if (size === 0) size = 0x10000;
      if (at > delta.length || offset + size > base.length || written + size > out.length) {
        throw new PackEnd();
      }
      out.set(base.subarray(offset, offset + size), written);
      written += size;
    } else if (op > 0) {
      if (at + op > delta.length || written + op > out.length) throw new PackEnd();
      out.set(delta.subarray(at, at + op), written);
      written += op;
      at += op;
    } else {
      throw new PackEnd();
    }
  }
  if (written !== out.length) throw new PackEnd();
  return out;
}

/** What one entry became: a full object, or a delta whose type follows its base. */
type Entry =
  | { readonly kind: 'object'; readonly type: GitObjectType; readonly body: Uint8Array | null }
  | { readonly kind: 'blob-chain' };

class Reader {
  private readonly byOid = new Map<string, GitObject>();
  private readonly blobs = new Set<string>();
  private readonly byOffset = new Map<number, Entry>();
  private readonly pendingRefDeltas: { base: string; delta: Uint8Array }[] = [];
  private inflated = 0;
  private kept = 0;
  private sinceYield = 0;

  constructor(
    private readonly pack: Uint8Array,
    private readonly limits: PackReadLimits,
  ) {}

  result(complete: boolean): GitPackObjects {
    const byOid = this.byOid;
    return { get: (oid) => byOid.get(oid), size: byOid.size, complete };
  }

  private keep(type: GitObjectType, body: Uint8Array): void {
    this.kept += body.length;
    if (this.kept > this.limits.maxKeptBytes) throw new PackEnd();
    this.byOid.set(objectId(type, body), { type, body });
  }

  private inflate(at: number, size: number): { data: Uint8Array; next: number } {
    if (size > this.limits.maxObjectBytes) throw new PackEnd();
    this.inflated += size;
    this.sinceYield += size;
    if (this.inflated > this.limits.maxInflatedBytes) throw new PackEnd();
    const out = inflateSync(this.pack.subarray(at), {
      info: true,
      maxOutputLength: Math.max(size, 1),
    }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (out.buffer.length !== size) throw new PackEnd();
    const data = new Uint8Array(out.buffer.buffer, out.buffer.byteOffset, out.buffer.length);
    return { data, next: at + out.engine.bytesWritten };
  }

  /** Read every entry; returns `true` when the pack was read to its end. */
  async read(): Promise<boolean> {
    const { pack } = this;
    if (pack.length < PACK_HEADER_BYTES) return false;
    if (Buffer.from(pack.subarray(0, 4)).toString('latin1') !== PACK_SIGNATURE) return false;
    const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
    const version = view.getUint32(4);
    if (version !== 2 && version !== 3) return false;
    const count = view.getUint32(8);
    if (count > this.limits.maxObjects) return false;
    let at = PACK_HEADER_BYTES;
    try {
      for (let i = 0; i < count; i += 1) {
        at = this.entry(at);
        if (this.sinceYield >= YIELD_EVERY_BYTES) {
          this.sinceYield = 0;
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    } catch {
      return false;
    }
    const resolved = this.resolveRefDeltas();
    // The trailer: the pack's own checksum, 20 bytes; anything else is garbled.
    return resolved && at + OID_BYTES === pack.length;
  }

  private entry(start: number): number {
    const { code, size, next } = entryHeader(this.pack, start);
    const type = TYPE_BY_CODE[code];
    if (type !== undefined) {
      const { data, next: end } = this.inflate(next, size);
      if (type === 'blob') {
        // Its id only: a ref-delta against it is a blob too, never read.
        this.blobs.add(objectId(type, data));
        this.byOffset.set(start, { kind: 'object', type, body: null });
      } else {
        this.byOffset.set(start, { kind: 'object', type, body: data });
        this.keep(type, data);
      }
      return end;
    }
    if (code === OFS_DELTA) {
      const { offset, next: dataAt } = ofsDeltaOffset(this.pack, next);
      const base = this.byOffset.get(start - offset);
      if (base === undefined) throw new PackEnd();
      const { data, next: end } = this.inflate(dataAt, size);
      if (base.kind === 'blob-chain' || base.body === null) {
        this.byOffset.set(start, { kind: 'blob-chain' });
      } else {
        const body = applyDelta(base.body, data);
        this.byOffset.set(start, { kind: 'object', type: base.type, body });
        this.keep(base.type, body);
      }
      return end;
    }
    if (code === REF_DELTA) {
      const baseAt = next + OID_BYTES;
      if (baseAt > this.pack.length) throw new PackEnd();
      const base = hex(this.pack.subarray(next, baseAt));
      const { data, next: end } = this.inflate(baseAt, size);
      // An ofs-delta on top of it cannot be resolved here.
      this.byOffset.set(start, { kind: 'blob-chain' });
      if (this.blobs.has(base)) return end;
      // Its base may come later in the pack: resolved at the end.
      this.kept += data.length;
      if (this.kept > this.limits.maxKeptBytes) throw new PackEnd();
      this.pendingRefDeltas.push({ base, delta: data });
      return end;
    }
    throw new PackEnd();
  }

  /** Ref-deltas against objects held, until no more resolve; `false` if some never did. */
  private resolveRefDeltas(): boolean {
    let pending = this.pendingRefDeltas;
    while (pending.length > 0) {
      const left: typeof pending = [];
      for (const p of pending) {
        if (this.blobs.has(p.base)) continue;
        const base = this.byOid.get(p.base);
        if (base === undefined) {
          left.push(p);
          continue;
        }
        try {
          this.keep(base.type, applyDelta(base.body, p.delta));
        } catch {
          return false;
        }
      }
      if (left.length === pending.length) return false;
      pending = left;
    }
    return true;
  }
}

/**
 * The commits, trees and tags of `pack` (the bytes after a push's command
 * list), by the ids their content hashes to. Never throws; see the module
 * comment for what `complete: false` means. An empty body is an empty pack.
 */
export async function readPackObjects(
  pack: Uint8Array,
  limits: PackReadLimits = DEFAULT_PACK_READ_LIMITS,
): Promise<GitPackObjects> {
  if (pack.length === 0) return EMPTY;
  const reader = new Reader(pack, limits);
  const complete = await reader.read();
  return reader.result(complete);
}

// ─────────────────────────────────────────────────────────────────────────────
// The three object bodies a plugin reads
// ─────────────────────────────────────────────────────────────────────────────

const OID_HEX = /^[0-9a-f]{40}$/;

function headerLines(body: Uint8Array): string[] {
  const text = Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('latin1');
  const end = text.indexOf('\n\n');
  return (end === -1 ? text : text.slice(0, end)).split('\n');
}

/** A commit's tree and parents, or `null` when the body is not a commit git would write. */
export function parseCommit(
  body: Uint8Array,
): { readonly tree: string; readonly parents: readonly string[] } | null {
  const lines = headerLines(body);
  const tree = /^tree ([0-9a-f]{40})$/.exec(lines[0] ?? '')?.[1];
  if (tree === undefined) return null;
  const parents: string[] = [];
  for (const line of lines.slice(1)) {
    const parent = /^parent ([0-9a-f]{40})$/.exec(line)?.[1];
    if (parent === undefined) break;
    parents.push(parent);
  }
  return { tree, parents };
}

/** An annotated tag's target, or `null`. */
export function parseTag(
  body: Uint8Array,
): { readonly object: string; readonly type: string } | null {
  const lines = headerLines(body);
  const object = /^object ([0-9a-f]{40})$/.exec(lines[0] ?? '')?.[1];
  const type = /^type ([a-z]+)$/.exec(lines[1] ?? '')?.[1];
  return object === undefined || type === undefined ? null : { object, type };
}

/** One entry of a tree: its name, its mode as git writes it (`100644`, `40000`), its id. */
export interface GitTreeEntry {
  readonly name: string;
  readonly mode: string;
  readonly oid: string;
}

/** A tree's entries, or `null` when the body is malformed. */
export function parseTree(body: Uint8Array): readonly GitTreeEntry[] | null {
  const entries: GitTreeEntry[] = [];
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space === -1) return null;
    const nul = body.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 1 + OID_BYTES > body.length) return null;
    const mode = Buffer.from(body.subarray(at, space)).toString('latin1');
    if (!/^[0-7]{5,6}$/.test(mode)) return null;
    const name = Buffer.from(body.subarray(space + 1, nul)).toString('utf8');
    const oid = hex(body.subarray(nul + 1, nul + 1 + OID_BYTES));
    if (!OID_HEX.test(oid)) return null;
    entries.push({ name, mode: normalizeMode(mode), oid });
    at = nul + 1 + OID_BYTES;
  }
  return entries;
}

/** A tree mode as git writes it in a tree object (`040000` → `40000`). */
export function normalizeMode(mode: string): string {
  const value = Number.parseInt(mode, 8);
  return Number.isNaN(value) ? mode : value.toString(8);
}

/** Mode of a tree entry that is itself a tree. */
export const TREE_MODE = '40000';
