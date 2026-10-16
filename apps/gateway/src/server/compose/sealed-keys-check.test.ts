/**
 * Re-check M-1 of fix/v5-sec-2: at boot the instance opens one stored blob per key
 * version and says loudly when the configured keys do not open what the store holds.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadInstanceConfig } from '../config';
import { validEnv } from '../config/testing';
import { buildRoot, SEALED_KEY_MISMATCH } from './root';

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');

describe('boot check of the master keys against the store', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function boot(env: Record<string, string | undefined>): Promise<string[]> {
    const lines: string[] = [];
    const root = await buildRoot({
      loadConfig: () =>
        loadInstanceConfig({
          env: validEnv({ VAUBAAN_STORE_PATH: join(dir, 'gateway.db'), ...env }),
        }),
      logWrite: (_level, line) => lines.push(line),
    });
    await root.store.config.setSecret('test.secret', 'value');
    await root.close();
    return lines;
  }

  it('says nothing when the keys fit, and names the version when they do not', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vaubaan-sealed-'));
    expect((await boot({ VAUBAAN_MASTER_KEY: KEY_A })).join('\n')).not.toContain(
      SEALED_KEY_MISMATCH,
    );
    // A new key pasted without raising its version: the blob of version 1 does not open.
    const wrong = (await boot({ VAUBAAN_MASTER_KEY: KEY_B })).join('\n');
    expect(wrong).toContain(SEALED_KEY_MISMATCH);
    expect(wrong).toContain('not the one that sealed these blobs');
  });

  it('a version with no configured key is named too', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vaubaan-sealed-'));
    await boot({ VAUBAAN_MASTER_KEY: KEY_A });
    const lines = await boot({ VAUBAAN_MASTER_KEY: KEY_B, VAUBAAN_MASTER_KEY_VERSION: '2' });
    expect(lines.join('\n')).toContain('no key is configured for this version');
  });
});
