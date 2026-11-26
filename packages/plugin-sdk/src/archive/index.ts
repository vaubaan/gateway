/**
 * `@vaubaan/plugin-sdk/archive` — the one file a plugin version ships as (spec
 * plugin-authoring §0 "Archive"; ADR plugins-activated-by-an-administrator-on-trial;
 * ADR plugin-signature-sets-the-trust-level).
 *
 * An archive is a gzipped tar of the plugin's build: `index.js`, its YAML, its
 * `package.json`, `vaubaan-manifest.json` (the sha256 of every other file) and, later,
 * a signature of that manifest. The tar is the plain ustar subset this module writes:
 * regular files only, sorted, mode 0644, owner 0, time 0 — so one build gives one byte
 * stream and one digest. Reading refuses anything else (a link, a device, a path
 * leaving the archive, a file the manifest does not list or lists with another digest),
 * and bounds what it inflates.
 *
 * Shared by the command line that packs an archive and the gateway that unpacks one;
 * neither needs a tar dependency.
 */

import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { isRecord } from '../guards.ts';

export { HEX_COLOUR_PATTERN, SVG_PATH_DATA_PATTERN } from '../mark.ts';

/** The file of an archive that lists the digest of every other file. */
export const ARCHIVE_MANIFEST_FILE = 'vaubaan-manifest.json';
/** The format of {@link ARCHIVE_MANIFEST_FILE}. */
export const ARCHIVE_MANIFEST_FORMAT = 'vaubaan-plugin-manifest/v1';

/** Bounds an archive is read within. */
export const ARCHIVE_LIMITS = {
  /** The gzipped archive. */
  compressedBytes: 16 * 1024 * 1024,
  /** Everything it inflates to. */
  inflatedBytes: 64 * 1024 * 1024,
  /** Files in it. */
  files: 1000,
  /** One path, in bytes. */
  pathBytes: 255,
} as const;

/** The archive's manifest: the digest of every file but itself and a signature. */
export interface ArchiveManifest {
  readonly format: typeof ARCHIVE_MANIFEST_FORMAT;
  readonly id: string;
  readonly version: string;
  /** Path inside the archive (`/`-separated) → hex sha256, sorted by path. */
  readonly files: Readonly<Record<string, string>>;
  /**
   * The service's mark as the plugin declares it (`ServicePlugin.icon`, `iconColor`), when it
   * does: what the catalog's index carries, read as data, so a plugin not installed is drawn
   * with its own icon (ADR service-icons-declared-by-the-plugin, amendment 2026-11-26).
   * Covered by the signature like the rest of the manifest; a reader that does not know the
   * two fields ignores them.
   */
  readonly icon?: string;
  readonly iconColor?: string;
}

/** The service's mark an archive's manifest carries. */
export interface ArchiveMark {
  readonly icon?: string;
  readonly iconColor?: string;
}

/** An archive read and checked against its manifest. */
export interface ReadArchive {
  /** Hex sha256 of the gzipped bytes: the archive's identity. */
  readonly digest: string;
  readonly manifest: ArchiveManifest;
  /** Every file, the manifest and signatures included, by path. */
  readonly files: ReadonlyMap<string, Uint8Array>;
}

/** An archive refused, with the reason a person can act on. */
export class ArchiveFormatError extends Error {
  override readonly name = 'ArchiveFormatError';
}

/**
 * Whether a file of the archive is left out of its manifest: the manifest itself and its two
 * signatures, at the root, by their exact names. Any other file, wherever it sits and
 * whatever it is called, is listed and hashed: nothing rides along unsigned.
 */
export function outsideManifest(path: string): boolean {
  return (
    path === ARCHIVE_MANIFEST_FILE ||
    path === `${ARCHIVE_MANIFEST_FILE}.sig.json` ||
    path === `${ARCHIVE_MANIFEST_FILE}.sigstore.json`
  );
}

/** Hex sha256 of some bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The manifest of a set of files, every one but those {@link outsideManifest} hashed. */
export function manifestOfFiles(
  files: ReadonlyMap<string, Uint8Array>,
  id: string,
  version: string,
  mark: ArchiveMark = {},
): ArchiveManifest {
  const digests: Record<string, string> = {};
  for (const path of [...files.keys()].filter((p) => !outsideManifest(p)).sort()) {
    digests[path] = sha256Hex(files.get(path) as Uint8Array);
  }
  return {
    format: ARCHIVE_MANIFEST_FORMAT,
    id,
    version,
    files: digests,
    ...(mark.icon !== undefined ? { icon: mark.icon } : {}),
    ...(mark.icon !== undefined && mark.iconColor !== undefined
      ? { iconColor: mark.iconColor }
      : {}),
  };
}

/** Why a path cannot be in an archive, or `null`. Pure. */
export function pathProblem(path: string): string | null {
  if (path === '') return 'an empty path';
  if (Buffer.byteLength(path) > ARCHIVE_LIMITS.pathBytes)
    return `a path over ${ARCHIVE_LIMITS.pathBytes} bytes`;
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return `an absolute path (${path})`;
  if (path.includes('\\')) return `a backslash in ${path}`;
  if (path.includes('\0')) return 'a NUL in a path';
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..'))
    return `a path leaving the archive (${path})`;
  return null;
}

// ---------------------------------------------------------------------------
// ustar
// ---------------------------------------------------------------------------

const BLOCK = 512;

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function writeString(header: Buffer, offset: number, width: number, value: string): void {
  header.write(value, offset, width, 'utf8');
}

function splitName(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
  const cut = path.lastIndexOf('/', path.length - 1);
  for (let index = cut; index > 0; index = path.lastIndexOf('/', index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new ArchiveFormatError(`${path}: too long for an archive path`);
}

function fileHeader(path: string, size: number): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  const { name, prefix } = splitName(path);
  writeString(header, 0, 100, name);
  writeString(header, 100, 8, octal(0o644, 8));
  writeString(header, 108, 8, octal(0, 8));
  writeString(header, 116, 8, octal(0, 8));
  writeString(header, 124, 12, octal(size, 12));
  writeString(header, 136, 12, octal(0, 12));
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, '0');
  writeString(header, 257, 6, 'ustar\0');
  writeString(header, 263, 2, '00');
  writeString(header, 345, 155, prefix);
  let sum = 0;
  for (const byte of header) sum += byte;
  writeString(header, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

/** The gzipped tar of `files`: sorted, regular files only, one byte stream per content. */
export function packArchive(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const parts: Buffer[] = [];
  for (const path of [...files.keys()].sort()) {
    const problem = pathProblem(path);
    if (problem !== null) throw new ArchiveFormatError(`cannot pack ${problem}`);
    const content = Buffer.from(files.get(path) as Uint8Array);
    parts.push(fileHeader(path, content.length), content);
    const pad = (BLOCK - (content.length % BLOCK)) % BLOCK;
    if (pad > 0) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  // zlib writes a gzip header with no name and a zero time: the bytes depend on the
  // content alone.
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

function readString(block: Buffer, offset: number, width: number): string {
  const slice = block.subarray(offset, offset + width);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? width : end).toString('utf8');
}

function readOctal(block: Buffer, offset: number, width: number, what: string): number {
  const text = readString(block, offset, width).trim();
  if (!/^[0-7]+$/.test(text)) throw new ArchiveFormatError(`a ${what} that is not a number`);
  return Number.parseInt(text, 8);
}

function untar(tar: Buffer): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) return files;
    const stored = readOctal(block, 148, 8, 'header checksum');
    let sum = 0;
    for (let index = 0; index < BLOCK; index += 1) {
      sum += index >= 148 && index < 156 ? 0x20 : (block[index] as number);
    }
    if (sum !== stored) throw new ArchiveFormatError('a damaged archive (header checksum)');
    const type = String.fromCharCode(block[156] as number);
    const prefix = readString(block, 345, 155);
    const name = readString(block, 0, 100);
    const path = prefix === '' ? name : `${prefix}/${name}`;
    const size = readOctal(block, 124, 12, 'file size');
    offset += BLOCK;
    if (type !== '0' && type !== '\0') {
      throw new ArchiveFormatError(`${path}: only regular files may be in an archive`);
    }
    const problem = pathProblem(path);
    if (problem !== null) throw new ArchiveFormatError(`the archive holds ${problem}`);
    if (files.has(path)) throw new ArchiveFormatError(`${path}: twice in the archive`);
    if (files.size >= ARCHIVE_LIMITS.files) {
      throw new ArchiveFormatError(`more than ${ARCHIVE_LIMITS.files} files`);
    }
    if (offset + size > tar.length) throw new ArchiveFormatError(`${path}: truncated`);
    files.set(path, Uint8Array.from(tar.subarray(offset, offset + size)));
    offset += Math.ceil(size / BLOCK) * BLOCK;
  }
  throw new ArchiveFormatError('a truncated archive (no end marker)');
}

/** Reads a manifest's JSON; the problem, or the manifest. Pure. */
export function parseArchiveManifest(raw: unknown): ArchiveManifest {
  if (!isRecord(raw) || raw['format'] !== ARCHIVE_MANIFEST_FORMAT) {
    throw new ArchiveFormatError(`${ARCHIVE_MANIFEST_FILE} is not a ${ARCHIVE_MANIFEST_FORMAT}`);
  }
  const { id, version, files } = raw;
  if (typeof id !== 'string' || id === '' || typeof version !== 'string' || version === '') {
    throw new ArchiveFormatError(`${ARCHIVE_MANIFEST_FILE} names no id or version`);
  }
  if (!isRecord(files)) throw new ArchiveFormatError(`${ARCHIVE_MANIFEST_FILE} lists no files`);
  const digests: Record<string, string> = {};
  for (const [path, digest] of Object.entries(files)) {
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new ArchiveFormatError(`${ARCHIVE_MANIFEST_FILE}: ${path} has no sha256`);
    }
    digests[path] = digest;
  }
  return { format: ARCHIVE_MANIFEST_FORMAT, id, version, files: digests };
}

/**
 * Reads a gzipped archive: inflated within bounds, every file a regular file inside it,
 * and exactly the files its manifest lists (signatures aside) with the digests it
 * lists. Throws {@link ArchiveFormatError}. Says nothing of who signed it.
 */
export function readArchive(bytes: Uint8Array): ReadArchive {
  if (bytes.byteLength > ARCHIVE_LIMITS.compressedBytes) {
    throw new ArchiveFormatError(`an archive over ${ARCHIVE_LIMITS.compressedBytes} bytes`);
  }
  let tar: Buffer;
  try {
    tar = gunzipSync(bytes, { maxOutputLength: ARCHIVE_LIMITS.inflatedBytes });
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    throw new ArchiveFormatError(
      code === 'ERR_BUFFER_TOO_LARGE'
        ? `an archive inflating past ${ARCHIVE_LIMITS.inflatedBytes} bytes`
        : 'not a gzipped archive',
    );
  }
  const files = untar(tar);
  const rawManifest = files.get(ARCHIVE_MANIFEST_FILE);
  if (rawManifest === undefined) throw new ArchiveFormatError(`no ${ARCHIVE_MANIFEST_FILE}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(rawManifest).toString('utf8'));
  } catch {
    throw new ArchiveFormatError(`${ARCHIVE_MANIFEST_FILE} is not JSON`);
  }
  const manifest = parseArchiveManifest(parsed);
  for (const [path, digest] of Object.entries(manifest.files)) {
    const content = files.get(path);
    if (content === undefined) throw new ArchiveFormatError(`${path}: listed, not in the archive`);
    if (sha256Hex(content) !== digest)
      throw new ArchiveFormatError(`${path}: modified since it was listed`);
  }
  for (const path of files.keys()) {
    if (!outsideManifest(path) && !(path in manifest.files)) {
      throw new ArchiveFormatError(`${path}: in the archive, not in its manifest`);
    }
  }
  return { digest: sha256Hex(bytes), manifest, files };
}

export {
  generateSigningKey,
  keyIdOf,
  parseSignature,
  signManifest,
  SIGNATURE_FILE,
  SIGNATURE_FORMAT,
  verifyManifestSignature,
  type ArchiveSignature,
  type SigningKeyPair,
  type TrustedKey,
} from './signature.ts';
