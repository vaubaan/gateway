/** SEC 2026-10-15 re-check L-1: a self resource of an unknown service stops the boot. */
import { describe, expect, it } from 'vitest';

import { ConfigError, loadInstanceConfig } from '../config';
import { validEnv } from '../../../tests/support/config/testing';
import { buildRoot } from './root';
import { memoryStoreDeps } from '../../../tests/support/compose/testing';

function rootWith(selfResources: string) {
  return buildRoot({
    loadConfig: () =>
      loadInstanceConfig({ env: validEnv({ VAUBAAN_SELF_RESOURCES: selfResources }) }),
    logWrite: () => undefined,
    ...memoryStoreDeps,
  });
}

describe('self resources name registered plugins', () => {
  it('refuses an entry whose service no plugin has', async () => {
    const err = await rootWith('Railway:6f1c').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).issues.map((i) => i.path)).toEqual(['self_resources']);
  });

  it('accepts an entry of a shipped plugin', async () => {
    const root = await rootWith('vercel:prj_host');
    expect(root.config.selfResources.map((s) => s.service)).toContain('vercel');
    await root.close();
  });
});
