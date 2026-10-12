import { afterEach, describe, expect, it } from 'vitest';

import { loadInstanceConfig } from '../config';
import { validEnv } from '../config/testing';
import { bootOrExit, EXIT_CONFIG_ERROR } from './boot';
import { EmptyPluginRegistry, MemoryCache, MemoryRateLimiter, MemorySessionStore } from './memory';
import type { Store } from './ports';
import { buildRoot, getRoot, resetRoot, type RootDeps } from './root';

const quiet: RootDeps = {
  loadConfig: () => loadInstanceConfig({ env: validEnv() }),
  logWrite: () => undefined,
};

afterEach(async () => {
  await resetRoot();
});

describe('buildRoot', () => {
  it('builds config, logger, encryptor and in-memory ports from configuration alone', async () => {
    const root = await buildRoot(quiet);
    expect(root.config.publicUrl.origin).toBe('https://gateway.example.com');
    expect(root.configFile).toBeNull();
    expect(root.encryptor.currentKeyVersion).toBe(1);
    expect(root.store.kind).toBe('none');
    expect(root.registry.list()).toEqual([]);
    expect(root.build).toEqual({ version: 'dev', commit: 'dev' });
    const sealed = await root.encryptor.encrypt('conn-1', 'hello');
    await expect(root.encryptor.decrypt('conn-1', sealed)).resolves.toBe('hello');
    await root.close();
  });

  it('plugs injected store and registry, and warns on provider apps for unknown plugins', async () => {
    const lines: string[] = [];
    let closed = false;
    const store: Store = {
      kind: 'fake',
      ping: async () => undefined,
      close: async () => {
        closed = true;
      },
    };
    const root = await buildRoot({
      loadConfig: () =>
        loadInstanceConfig({
          env: validEnv({
            VAUBAAN_PROVIDER_GITHUB_APP_ID: '1',
            VAUBAAN_PROVIDER_NOPE_CLIENT_ID: 'x',
          }),
        }),
      openStore: async () => store,
      buildRegistry: async () => ({
        list: () => [{ id: 'github', displayName: 'GitHub', version: '1.0.0' }],
        has: (id) => id === 'github',
      }),
      logWrite: (_lvl, line) => lines.push(line),
    });
    expect(root.store).toBe(store);
    const warnings = lines.filter((l) => l.includes('"level":"warn"'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('providers.nope');
    expect(warnings[0]).not.toContain('providers.github');
    await root.close();
    expect(closed).toBe(true);
  });

  it('never writes a secret to the boot log', async () => {
    const lines: string[] = [];
    const env = validEnv();
    await buildRoot({
      loadConfig: () => loadInstanceConfig({ env }),
      logWrite: (_lvl, line) => lines.push(line),
    });
    const all = lines.join('');
    expect(all).toContain('configuration loaded');
    expect(all).not.toContain(env.VAUBAAN_MASTER_KEY);
    expect(all).not.toContain(env.VAUBAAN_BOOTSTRAP_TOKEN);
  });
});

describe('getRoot', () => {
  it('builds once and hands the same promise to every caller', async () => {
    let builds = 0;
    const deps: RootDeps = {
      ...quiet,
      loadConfig: () => {
        builds += 1;
        return loadInstanceConfig({ env: validEnv() });
      },
    };
    const [a, b] = await Promise.all([getRoot(deps), getRoot(deps)]);
    expect(a).toBe(b);
    expect(await getRoot(deps)).toBe(a);
    expect(builds).toBe(1);
  });

  it('forgets a failed build so the next call retries', async () => {
    const failing: RootDeps = { ...quiet, loadConfig: () => loadInstanceConfig({ env: {} }) };
    await expect(getRoot(failing)).rejects.toThrow('Invalid instance configuration');
    await expect(getRoot(quiet)).resolves.toBeDefined();
  });
});

describe('bootOrExit', () => {
  it('exits with EX_CONFIG and a message naming the missing keys', async () => {
    let out = '';
    let code: number | null = null;
    await bootOrExit(
      {
        ...quiet,
        loadConfig: () => loadInstanceConfig({ env: validEnv({ VAUBAAN_MASTER_KEY: undefined }) }),
      },
      { stderr: (t) => (out += t), exit: (c) => (code = c) },
    );
    expect(code).toBe(EXIT_CONFIG_ERROR);
    expect(out).toContain(
      'encryption.master_key: missing required key (env: VAUBAAN_MASTER_KEY or VAUBAAN_MASTER_KEY_FILE)',
    );
    expect(out).toContain('gateway.example.yaml');
  });

  it('exits with 1 on any other boot failure', async () => {
    let code: number | null = null;
    let out = '';
    await bootOrExit(
      { ...quiet, openStore: async () => Promise.reject(new Error('disk on fire')) },
      { stderr: (t) => (out += t), exit: (c) => (code = c) },
    );
    expect(code).toBe(1);
    expect(out).toContain('disk on fire');
  });

  it('does nothing when the root builds', async () => {
    let code: number | null = null;
    await bootOrExit(quiet, { stderr: () => undefined, exit: (c) => (code = c) });
    expect(code).toBeNull();
  });
});

describe('in-memory ports (single-process only)', () => {
  it('MemoryRateLimiter counts a fixed window and resets after it', async () => {
    let t = 1_000;
    const rl = new MemoryRateLimiter(() => t);
    expect(await rl.take('k', 2, 1_000)).toEqual({ allowed: true, remaining: 1, retryAfterMs: 0 });
    expect(await rl.take('k', 2, 1_000)).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
    t += 400;
    expect(await rl.take('k', 2, 1_000)).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterMs: 600,
    });
    expect((await rl.take('other', 2, 1_000)).allowed).toBe(true);
    t += 600;
    expect((await rl.take('k', 2, 1_000)).allowed).toBe(true);
  });

  it('MemoryCache expires entries and evicts the oldest when full', async () => {
    let t = 0;
    const cache = new MemoryCache(2, () => t);
    await cache.set('a', 1, 100);
    await cache.set('b', 2, 100);
    await cache.set('c', 3, 100); // evicts a
    expect(await cache.get('a')).toBeUndefined();
    expect(await cache.get('b')).toBe(2);
    t = 100;
    expect(await cache.get('b')).toBeUndefined();
    await cache.set('d', 4, 50);
    await cache.delete('d');
    expect(await cache.get('d')).toBeUndefined();
  });

  it('MemorySessionStore returns null for unknown or expired sessions', async () => {
    let t = 0;
    const sessions = new MemorySessionStore<{ user: string }>(() => t);
    expect(await sessions.get('s1')).toBeNull();
    await sessions.set('s1', { user: 'u' }, 10);
    expect(await sessions.get('s1')).toEqual({ user: 'u' });
    t = 10;
    expect(await sessions.get('s1')).toBeNull();
  });

  it('EmptyPluginRegistry knows nothing', () => {
    const r = new EmptyPluginRegistry();
    expect(r.list()).toEqual([]);
    expect(r.has('github')).toBe(false);
  });
});
