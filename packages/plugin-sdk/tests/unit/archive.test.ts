/**
 * A plugin archive (spec plugin-authoring §0 "Archive"): packed the same way every time,
 * read back only when it is exactly what its manifest lists, and never past its bounds
 * or outside itself.
 */
import { gunzipSync, gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  ARCHIVE_LIMITS,
  ARCHIVE_MANIFEST_FILE,
  ArchiveFormatError,
  manifestOfFiles,
  outsideManifest,
  packArchive,
  pathProblem,
  readArchive,
  sha256Hex,
} from '../../src/archive/index.ts';

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

function build(extra: Record<string, string> = {}, drop: string[] = []): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>([
    ['index.js', text('export default { id: "acme", version: "1.0.0" };\n')],
    ['package.json', text('{"name":"@acme/p","version":"1.0.0"}\n')],
    ['risk-catalog.yaml', text('service: acme\nrisks: []\n')],
    ['docs/connect/token.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])],
  ]);
  const manifest = manifestOfFiles(files, 'acme', '1.0.0');
  files.set(ARCHIVE_MANIFEST_FILE, text(JSON.stringify(manifest)));
  for (const [path, content] of Object.entries(extra)) files.set(path, text(content));
  for (const path of drop) files.delete(path);
  return files;
}

describe('plugin archive', () => {
  it('reads back exactly the files it packed, with its manifest', () => {
    const files = build();
    const read = readArchive(packArchive(files));
    expect([...read.files.keys()].sort()).toEqual([...files.keys()].sort());
    expect(Buffer.from(read.files.get('docs/connect/token.png') as Uint8Array)).toEqual(
      Buffer.from(files.get('docs/connect/token.png') as Uint8Array),
    );
    expect(read.manifest).toMatchObject({ id: 'acme', version: '1.0.0' });
    expect(Object.keys(read.manifest.files)).not.toContain(ARCHIVE_MANIFEST_FILE);
  });

  it('packs one content into one byte stream, whatever the insertion order', () => {
    const a = packArchive(build());
    const b = packArchive(new Map([...build()].reverse()));
    expect(sha256Hex(a)).toBe(sha256Hex(b));
    expect(readArchive(a).digest).toBe(sha256Hex(a));
  });

  it('keeps a long nested path through the ustar prefix', () => {
    const deep = `${'d'.repeat(60)}/${'e'.repeat(60)}/${'f'.repeat(60)}.png`;
    const files = new Map([
      ['a.txt', text('a')],
      [deep, text('deep')],
    ]);
    files.set(ARCHIVE_MANIFEST_FILE, text(JSON.stringify(manifestOfFiles(files, 'x', '1.0.0'))));
    expect(readArchive(packArchive(files)).files.has(deep)).toBe(true);
  });

  it('refuses a file modified since the manifest listed it', () => {
    const files = build();
    files.set('index.js', text('export default { id: "evil" };\n'));
    expect(() => readArchive(packArchive(files))).toThrow(/index\.js: modified/);
  });

  it('refuses a file the manifest does not list, and one it lists but is missing', () => {
    expect(() => readArchive(packArchive(build({ 'extra.js': 'x' })))).toThrow(
      /extra\.js: in the archive, not in its manifest/,
    );
    expect(() => readArchive(packArchive(build({}, ['risk-catalog.yaml'])))).toThrow(
      /risk-catalog\.yaml: listed, not in the archive/,
    );
  });

  it('lets a signature sit beside the manifest without being listed', () => {
    const read = readArchive(packArchive(build({ 'vaubaan-manifest.json.sig.json': '{}' })));
    expect(read.files.has('vaubaan-manifest.json.sig.json')).toBe(true);
    expect(outsideManifest('vaubaan-manifest.json.sigstore.json')).toBe(true);
  });

  it('refuses no manifest, a manifest of another format, and bytes that are not gzip', () => {
    expect(() => readArchive(packArchive(build({}, [ARCHIVE_MANIFEST_FILE])))).toThrow(
      /no vaubaan-manifest\.json/,
    );
    expect(() =>
      readArchive(packArchive(build({ [ARCHIVE_MANIFEST_FILE]: '{"format":"other"}' }))),
    ).toThrow(/is not a vaubaan-plugin-manifest\/v1/);
    expect(() => readArchive(text('not an archive'))).toThrow(ArchiveFormatError);
  });

  it('refuses a link, and a path leaving the archive, written by another tool', () => {
    const tar = Buffer.from(gzipUnzip(packArchive(build())));
    // Turn the first entry into a symbolic link (typeflag 2) and fix its checksum.
    tar[156] = '2'.charCodeAt(0);
    fixChecksum(tar, 0);
    expect(() => readArchive(gzipSync(tar))).toThrow(/only regular files/);

    const evil = Buffer.from(gzipUnzip(packArchive(build())));
    evil.write('../../etc/passwd\0', 0, 'utf8');
    fixChecksum(evil, 0);
    expect(() => readArchive(gzipSync(evil))).toThrow(/leaving the archive/);
  });

  it('never inflates past its bound', () => {
    const bomb = gzipSync(Buffer.alloc(ARCHIVE_LIMITS.inflatedBytes + 1024, 0));
    expect(bomb.byteLength).toBeLessThan(ARCHIVE_LIMITS.compressedBytes);
    expect(() => readArchive(bomb)).toThrow(/inflating past/);
  });

  it('names what a path may not be', () => {
    expect(pathProblem('a/b.js')).toBeNull();
    expect(pathProblem('/etc/passwd')).toMatch(/absolute/);
    expect(pathProblem('a/../b')).toMatch(/leaving/);
    expect(pathProblem('a\\b')).toMatch(/backslash/);
    expect(pathProblem('')).toMatch(/empty/);
  });
});

function gzipUnzip(bytes: Uint8Array): Buffer {
  return gunzipSync(bytes);
}

function fixChecksum(tar: Buffer, offset: number): void {
  const block = tar.subarray(offset, offset + 512);
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
}
