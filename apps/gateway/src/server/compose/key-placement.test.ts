import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadInstanceConfig } from '../config';
import { validEnv } from '../../../tests/support/config/testing';
import {
  KEY_BESIDE_STORE_WARNING,
  keyBesideStore,
  mountPointOf,
  mountPointsOf,
  type MountFacts,
} from './key-placement';
import { buildRoot, resetRoot } from './root';
import { memoryStoreDeps } from '../../../tests/support/compose/testing';

/** Two Docker volumes on one host disk: two mounts, one device. */
const MOUNTINFO = [
  '22 1 8:1 / / rw,relatime - ext4 /dev/sda1 rw',
  '400 22 8:1 /var/lib/docker/volumes/vaubaan_gateway-data/_data /data rw - ext4 /dev/sda1 rw',
  '401 22 8:1 /var/lib/docker/volumes/vaubaan_gateway-key/_data /keys rw - ext4 /dev/sda1 rw',
  '402 22 0:50 / /run/secrets/master\\040key ro - tmpfs tmpfs ro',
].join('\n');

function facts(mountInfo: string | null, device = 2049): MountFacts {
  return {
    mountInfo: () => mountInfo,
    realDirectory: (path) => path,
    device: () => device,
  };
}

describe('the master key file and the store', () => {
  it('reads the mount points of mountinfo, unescaping a space', () => {
    expect(mountPointsOf(MOUNTINFO)).toEqual(['/', '/data', '/keys', '/run/secrets/master key']);
  });

  it('finds the longest mount point holding a path, never a sibling with a common prefix', () => {
    const points = mountPointsOf(MOUNTINFO);
    expect(mountPointOf('/data', points)).toBe('/data');
    expect(mountPointOf('/data/sub', points)).toBe('/data');
    expect(mountPointOf('/database', points)).toBe('/');
    expect(mountPointOf('/keys', points)).toBe('/keys');
  });

  it('sit together on one volume', () => {
    expect(keyBesideStore('/data/master.key', '/data/gateway.db', facts(MOUNTINFO))).toBe(true);
  });

  it('sit apart on two volumes of one disk, which the device number alone would not tell', () => {
    expect(keyBesideStore('/keys/master.key', '/data/gateway.db', facts(MOUNTINFO))).toBe(false);
    expect(
      keyBesideStore('/run/secrets/master key/key', '/data/gateway.db', facts(MOUNTINFO)),
    ).toBe(false);
  });

  it('fall back on the device numbers without mountinfo, and say nothing they cannot tell', () => {
    expect(keyBesideStore('/a/master.key', '/b/gateway.db', facts(null))).toBe(true);
    const unknown: MountFacts = { ...facts(null), realDirectory: () => null };
    expect(keyBesideStore('/a/master.key', '/b/gateway.db', unknown)).toBeNull();
  });
});

describe('the boot warning', () => {
  const scratch: string[] = [];
  afterEach(async () => {
    await resetRoot();
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function bootLog(env: Record<string, string>, mountInfo: string): Promise<string[]> {
    const dir = mkdtempSync(join(tmpdir(), 'vbn-key-'));
    scratch.push(dir);
    const keyFile = join(dir, 'master.key');
    writeFileSync(keyFile, `${validEnv().VAUBAAN_MASTER_KEY}\n`, { mode: 0o600 });
    const lines: string[] = [];
    const root = await buildRoot({
      ...memoryStoreDeps,
      loadConfig: () =>
        loadInstanceConfig({
          env: validEnv({
            VAUBAAN_MASTER_KEY: undefined,
            VAUBAAN_MASTER_KEY_FILE: keyFile,
            VAUBAAN_STORE_PATH: join(dir, 'gateway.db'),
            ...env,
          }),
        }),
      logWrite: (_level, line) => lines.push(line),
      mountFacts: { ...facts(mountInfo), realDirectory: () => '/data' },
    });
    await root.close();
    return lines.filter((line) => line.includes(KEY_BESIDE_STORE_WARNING));
  }

  it('is said once when the key file shares the store’s mount, naming both paths and the remedy', async () => {
    const [warning, ...more] = await bootLog({}, MOUNTINFO);
    expect(more).toEqual([]);
    expect(JSON.parse(warning ?? '{}')).toMatchObject({ level: 'warn' });
    expect(warning).toContain('VAUBAAN_ACCEPT_KEY_BESIDE_STORE=1');
    expect(warning).toContain('master.key');
  });

  it('is not said once the operator accepted it', async () => {
    expect(await bootLog({ VAUBAAN_ACCEPT_KEY_BESIDE_STORE: '1' }, MOUNTINFO)).toEqual([]);
  });
});
