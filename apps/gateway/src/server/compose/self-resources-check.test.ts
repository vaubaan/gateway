/** SEC 2026-10-15 re-check L-1: a self resource of an unknown service stops the boot. */
import { describe, expect, it } from 'vitest';

import { ConfigError, loadInstanceConfig } from '../config';
import { validEnv } from '../../../tests/support/config/testing';
import { checkSelfResources } from './registry';
import { buildRoot } from './root';
import { memoryStoreDeps } from '../../../tests/support/compose/testing';

function rootWith(selfResources: string, bundled = memoryStoreDeps.bundled) {
  return buildRoot({
    loadConfig: () =>
      loadInstanceConfig({ env: validEnv({ VAUBAAN_SELF_RESOURCES: selfResources }) }),
    logWrite: () => undefined,
    ...memoryStoreDeps,
    bundled,
  });
}

/** The image of 2.0.0-alpha.27 on: `ssh` and `vaubaan` compiled, every other plugin from the catalog. */
const IMAGE_ONLY = new Set(['ssh', 'vaubaan']);
const imageRegistry = {
  size: IMAGE_ONLY.size,
  has: (id: string) => IMAGE_ONLY.has(id),
  ids: [...IMAGE_ONLY],
};

function configWith(selfResources: string) {
  return loadInstanceConfig({ env: validEnv({ VAUBAAN_SELF_RESOURCES: selfResources }) }).config;
}

describe('self resources name registered plugins', () => {
  it('refuses an entry whose service no plugin has', async () => {
    const err = await rootWith('Railway:6f1c').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).issues.map((i) => i.path)).toEqual(['self_resources']);
  });

  it('accepts an entry of a catalog plugin the image does not compile, not installed yet', () => {
    const config = configWith('fly:vbn-dalae');
    expect(() => checkSelfResources(config, imageRegistry, new Set(['fly']))).not.toThrow();
    // The catalog this release knows offers fly by default.
    expect(() => checkSelfResources(config, imageRegistry)).not.toThrow();
  });

  it('still refuses an entry neither registered nor in the catalog', () => {
    const config = configWith('jira:6f1c');
    const err = (() => {
      try {
        checkSelfResources(config, imageRegistry, new Set(['railway']));
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(ConfigError);
  });

  it('starts an image without the plugin when the entry names a catalog plugin', async () => {
    const shipped = (memoryStoreDeps.bundled ?? []).filter((p) => IMAGE_ONLY.has(p.id));
    const root = await rootWith('fly:vbn-dalae', shipped);
    expect(root.registry.has('fly')).toBe(false);
    expect(root.config.selfResources.map((s) => s.service)).toEqual(['fly']);
    await root.close();
  });

  it('accepts an entry of a shipped plugin', async () => {
    const root = await rootWith('vercel:prj_host');
    expect(root.config.selfResources.map((s) => s.service)).toContain('vercel');
    await root.close();
  });
});
