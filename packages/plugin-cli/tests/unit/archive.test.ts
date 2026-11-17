/**
 * The archive builder (spec plugin-authoring §0 "Archive"): the template plugin builds
 * into an archive whose manifest hashes every file, whose package names the plugin's own
 * name and licence, and which the command line reports.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ARCHIVE_MANIFEST_FILE,
  ARCHIVE_MANIFEST_FORMAT,
  archivePackage,
  buildArchive,
  filesOf,
  manifestOf,
  notBundleableReason,
  outsideManifest,
  parseCommand,
  resolveSdkVersion,
  run,
  type ArchiveManifest,
} from '../../src/index.ts';
import { readArchive } from '@vaubaan/plugin-sdk/archive';

const TEMPLATE = fileURLToPath(new URL('../../../../plugins/_template', import.meta.url));
const SDK_VERSION = (
  JSON.parse(
    readFileSync(new URL('../../../plugin-sdk/package.json', import.meta.url), 'utf8'),
  ) as { version: string }
).version;

describe('buildArchive', () => {
  let out: string;
  let result: Awaited<ReturnType<typeof buildArchive>>;

  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), 'vaubaan-archive-'));
    result = await buildArchive({ pluginDir: TEMPLATE, outDir: join(out, 'template') });
  }, 60_000);

  afterAll(() => {
    rmSync(out, { recursive: true, force: true });
  });

  it('builds the plugin and reads its id from the bundle', () => {
    expect(result).toMatchObject({ id: 'template', version: '0.2.0' });
  });

  it('packs the same files into the archive an administrator uploads', () => {
    const archive = readArchive(readFileSync(join(out, 'template.tgz')));
    expect(archive.manifest).toMatchObject({ id: 'template', version: '0.2.0' });
    expect([...archive.files.keys()].sort()).toEqual(
      [...filesOf(join(out, 'template')).keys()].sort(),
    );
  });

  it('writes the package under the plugin’s own name and licence, with the SDK range found', () => {
    const pkg = JSON.parse(readFileSync(join(out, 'template', 'package.json'), 'utf8')) as unknown;
    expect(pkg).toEqual({
      name: '@vaubaan/plugin-template',
      version: '0.2.0',
      description: expect.any(String) as string,
      type: 'module',
      exports: { '.': './index.js' },
      peerDependencies: { '@vaubaan/plugin-sdk': `^${SDK_VERSION}` },
      license: 'Apache-2.0',
    });
  });

  it('hashes every other file in its manifest', () => {
    const manifest = JSON.parse(
      readFileSync(join(out, 'template', ARCHIVE_MANIFEST_FILE), 'utf8'),
    ) as ArchiveManifest;
    expect(manifest.format).toBe(ARCHIVE_MANIFEST_FORMAT);
    expect(manifest.id).toBe('template');
    expect(Object.keys(manifest.files)).toEqual(
      expect.arrayContaining(['index.js', 'package.json', 'risk-catalog.yaml']),
    );
    expect(Object.keys(manifest.files)).not.toContain(ARCHIVE_MANIFEST_FILE);
    for (const [path, digest] of Object.entries(manifest.files)) {
      const actual = createHash('sha256')
        .update(readFileSync(join(out, 'template', path)))
        .digest('hex');
      expect(actual, path).toBe(digest);
    }
  });

  it('is what the command line builds and reports', async () => {
    const lines: string[] = [];
    const code = await run(['build', TEMPLATE, '--out', join(out, 'cli')], {
      cwd: out,
      log: (line) => lines.push(line),
      error: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(lines).toEqual([`built template 0.2.0 → ${join(out, 'cli')}.tgz`]);
  });
});

describe('archive helpers', () => {
  it('names the package from the plugin, unlicensed by default', () => {
    expect(archivePackage({ name: '@acme/crm', version: '1.0.0' }, '0.9.4')).toEqual({
      name: '@acme/crm',
      version: '1.0.0',
      type: 'module',
      exports: { '.': './index.js' },
      peerDependencies: { '@vaubaan/plugin-sdk': '^0.9.4' },
      license: 'UNLICENSED',
    });
  });

  it('reads the bundleable flag', () => {
    expect(notBundleableReason({})).toBeNull();
    expect(notBundleableReason({ vaubaan: { bundleable: false, reason: 'native addon' } })).toBe(
      'native addon',
    );
    expect(notBundleableReason({ vaubaan: { bundleable: false } })).toBe('declared not bundleable');
  });

  it('leaves the manifest and signatures out of the manifest', () => {
    expect(outsideManifest(ARCHIVE_MANIFEST_FILE)).toBe(true);
    expect(outsideManifest('vaubaan-manifest.json.sig.json')).toBe(true);
    expect(outsideManifest('docs/connect/token.png')).toBe(false);
  });

  it('hashes nested files with forward slashes, sorted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vaubaan-manifest-'));
    try {
      writeFileSync(join(dir, 'b.txt'), 'b');
      writeFileSync(join(dir, 'a.txt'), 'a');
      writeFileSync(join(dir, ARCHIVE_MANIFEST_FILE), '{}');
      expect(Object.keys(manifestOf(dir, 'x', '1.0.0').files)).toEqual(['a.txt', 'b.txt']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds the SDK the plugin resolves', () => {
    expect(resolveSdkVersion(TEMPLATE)).toBe(SDK_VERSION);
  });

  it('parses build, its folder and --out', () => {
    expect(parseCommand(['build'], '/p')).toEqual({
      name: 'build',
      pluginDir: '/p',
      out: '/p/dist/plugin',
    });
    expect(parseCommand(['build', 'crm', '--out', 'x'], '/w')).toEqual({
      name: 'build',
      pluginDir: '/w/crm',
      out: '/w/x',
    });
    expect(() => parseCommand([], '/p')).toThrow(/usage/);
    expect(() => parseCommand(['build', '--bogus'], '/p')).toThrow(/unknown option/);
  });
});
