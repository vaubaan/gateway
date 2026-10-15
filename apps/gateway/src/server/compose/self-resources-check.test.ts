/** SEC 2026-10-15 re-check L-1: a self resource of an unknown provider stops the boot. */
import { describe, expect, it } from 'vitest';

import { ConfigError, loadInstanceConfig } from '../config';
import { validEnv } from '../config/testing';
import { buildRoot } from './root';
import { memoryStoreDeps } from './testing';

function rootWith(selfResources: string) {
  return buildRoot({
    loadConfig: () =>
      loadInstanceConfig({ env: validEnv({ VAUBAAN_SELF_RESOURCES: selfResources }) }),
    logWrite: () => undefined,
    ...memoryStoreDeps,
  });
}

describe('self resources name registered plugins', () => {
  it('refuses an entry whose provider no plugin has', async () => {
    const err = await rootWith('Railway:6f1c').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).issues.map((i) => i.path)).toEqual(['self_resources']);
  });

  it('accepts an entry of a shipped plugin', async () => {
    const root = await rootWith('vercel:prj_host');
    expect(root.config.selfResources.map((s) => s.provider)).toContain('vercel');
    await root.close();
  });
});
