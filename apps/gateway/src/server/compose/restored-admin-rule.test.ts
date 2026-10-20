/**
 * At boot the admin rule is the configured one plus the one a restored backup
 * carried (ADR backup-carries-the-sign-in-configuration).
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RESTORED_ADMIN_RULE_KEY } from '../auth/admin-rule';
import { loadInstanceConfig } from '../config';
import { validEnv } from '../config/testing';
import { buildRoot } from './root';

const KEY = randomBytes(32).toString('base64');

describe('the admin rule a restored backup carried', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vaubaan-restored-rule-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function boot(env: Record<string, string> = {}) {
    const lines: string[] = [];
    const root = await buildRoot({
      loadConfig: () =>
        loadInstanceConfig({
          env: validEnv({
            VAUBAAN_STORE_PATH: join(dir, 'gateway.db'),
            VAUBAAN_MASTER_KEY: KEY,
            ...env,
          }),
        }),
      logWrite: (_level, line) => lines.push(line),
    });
    return { root, lines };
  }

  it('adds to the configured rule, said once without the emails', async () => {
    const first = await boot();
    expect(first.root.config.admin.emails).toEqual(['ops@example.com']);
    await first.root.store.config.set(
      RESTORED_ADMIN_RULE_KEY,
      JSON.stringify({ group: 'entra:admins', emails: ['boss@fiabilis.example'] }),
    );
    await first.root.close();

    const second = await boot();
    try {
      expect(second.root.config.admin).toEqual({
        group: 'entra:admins',
        emails: ['ops@example.com', 'boss@fiabilis.example'],
      });
      const log = second.lines.join('\n');
      expect(log).toContain('the one a restored backup carried');
      expect(log).not.toContain('boss@fiabilis.example');
    } finally {
      await second.root.close();
    }
  });
});
