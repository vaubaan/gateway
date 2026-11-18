/**
 * The admin rule a backup carried (docs/handbook/authentication.md) is
 * read once, by the seed, while the store names no administrator (ADR
 * administrators-live-in-the-instance): its people become administrators like the
 * configuration's, and the key is deleted.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RESTORED_ADMIN_RULE_KEY } from '../auth/restored-admin-rule';
import { loadInstanceConfig } from '../config';
import { validEnv } from '../../../tests/support/config/testing';
import { createEncryptor } from '../crypto';
import { openStore, SetCatalogIndex } from '../store';
import { buildRoot } from './root';
import { REPOSITORY_PLUGINS } from '../../../tests/support/plugins/repository';

const KEY = randomBytes(32).toString('base64');
const CARRIED = JSON.stringify({ group: 'entra:admins', emails: ['boss@acme.example'] });

describe('the admin rule a restored backup carried', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vaubaan-restored-rule-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function load() {
    return loadInstanceConfig({
      env: validEnv({ VAUBAAN_STORE_PATH: join(dir, 'gateway.db'), VAUBAAN_MASTER_KEY: KEY }),
    });
  }

  /** A copy restored in place: the store holds the carried key and no administrator. */
  async function restoredCopy(): Promise<void> {
    const loaded = load();
    const store = openStore({
      path: loaded.config.store.path,
      encryptor: await createEncryptor(loaded.config.encryption),
      catalog: new SetCatalogIndex([]),
    });
    await store.config.set(RESTORED_ADMIN_RULE_KEY, CARRIED);
    await store.close();
  }

  async function boot() {
    const lines: string[] = [];
    const root = await buildRoot({
      loadConfig: load,
      logWrite: (_level, line) => lines.push(line),
      bundled: REPOSITORY_PLUGINS,
    });
    return { root, lines };
  }

  it('names its people administrators with the configuration’s, then is gone', async () => {
    await restoredCopy();
    const { root, lines } = await boot();
    try {
      const designations = await root.store.administrators.list();
      expect(
        designations.map((d) =>
          d.kind === 'email' ? d.email : d.kind === 'group' ? d.groupName : d.userId,
        ),
      ).toEqual(['ops@example.com', 'boss@acme.example', 'entra:admins']);
      expect(await root.store.config.get(RESTORED_ADMIN_RULE_KEY)).toBeNull();
      // The configuration's own rule is what was applied: no drift on the next boot.
      expect(await root.auth.administrators.configurationDrift()).toBeNull();
      expect(lines.join('\n')).not.toContain('boss@acme.example');
    } finally {
      await root.close();
    }
  });

  it('grants nothing once the store names administrators: the key is dropped', async () => {
    const first = await boot();
    await first.root.store.config.set(RESTORED_ADMIN_RULE_KEY, CARRIED);
    await first.root.close();
    const second = await boot();
    try {
      const designations = await second.root.store.administrators.list();
      expect(designations).toHaveLength(1);
      expect(await second.root.store.config.get(RESTORED_ADMIN_RULE_KEY)).toBeNull();
    } finally {
      await second.root.close();
    }
  });
});
