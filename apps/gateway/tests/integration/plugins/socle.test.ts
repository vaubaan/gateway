/**
 * The socle (ADR plugin-catalog-rebuilt-from-source): the image's own version of a plugin
 * runs from the catalog's signed archive when the image preinstalls it, end to end on a
 * real root. notion 0.2.0 as the catalog published it replaces the compiled notion 0.2.0;
 * a folder that is not the catalog's, or not that version, is logged and the compiled
 * copy runs — a broken socle never stops a start.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { manifestOfFiles, readArchive } from '@vaubaan/plugin-sdk/archive';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { loadInstanceConfig } from '../../../src/server/config';
import { validEnv } from '../../support/config/testing';

const NOTION = readFileSync(new URL('../../fixtures/sigstore/notion-v0.2.0.tgz', import.meta.url));
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function unpack(files: ReadonlyMap<string, Uint8Array>, dir: string): void {
  for (const [path, content] of files) {
    const target = join(dir, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

describe('the socle', () => {
  let dir: string;
  let root: GatewayRoot | null = null;
  const logs: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vbn-socle-'));
    logs.length = 0;
  });

  afterEach(async () => {
    await root?.close();
    root = null;
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(): Promise<GatewayRoot> {
    root = await buildRoot({
      loadConfig: () =>
        loadInstanceConfig({ env: validEnv({ VAUBAAN_STORE_PATH: join(dir, 'gateway.db') }) }),
      logWrite: (_level, line) => {
        logs.push(line);
      },
      requestRestart: () => undefined,
      socleDir: join(dir, 'socle'),
    });
    return root;
  }

  it('runs the image’s notion from the catalog’s signed archive, the same version', async () => {
    unpack(readArchive(NOTION).files, join(dir, 'socle', 'notion'));
    const r = await start();
    expect(r.plugins.entries.find((e) => e.id === 'notion')).toMatchObject({
      origin: 'bundled',
      version: '0.2.0',
      path: join(dir, 'socle', 'notion'),
      trust: 'vaubaan',
    });
    expect(r.registry.get('notion')?.plugin.version).toBe('0.2.0');
    expect(logs.join('\n')).toMatch(/plugin notion 0\.2\.0 from the socle, signed by the catalog/);
  });

  it('keeps the compiled copy when the folder is not the catalog’s', async () => {
    const files = new Map(
      [...readArchive(NOTION).files].filter(([path]) => !path.startsWith('vaubaan-manifest')),
    );
    files.set(
      'vaubaan-manifest.json',
      encode(JSON.stringify(manifestOfFiles(files, 'notion', '0.2.0'))),
    );
    unpack(files, join(dir, 'socle', 'notion'));
    const r = await start();
    expect(r.plugins.entries.find((e) => e.id === 'notion')).toMatchObject({
      origin: 'bundled',
      path: null,
    });
    expect(logs.join('\n')).toMatch(/plugin notion: the socle's archive is not used/);
    expect(logs.join('\n')).toMatch(/not signed by the catalog \(unsigned/);
  });

  it('keeps the compiled copy when a file was changed after the catalog signed it', async () => {
    const files = new Map(readArchive(NOTION).files);
    files.set('index.js', encode('export default {};\n'));
    unpack(files, join(dir, 'socle', 'notion'));
    const r = await start();
    expect(r.plugins.entries.find((e) => e.id === 'notion')?.path).toBeNull();
    expect(logs.join('\n')).toMatch(/plugin notion: the socle's archive is not used/);
  });

  it('starts as before without a socle folder', async () => {
    const r = await start();
    expect(r.plugins.entries.every((e) => e.origin === 'bundled' && e.path === null)).toBe(true);
  });
});
