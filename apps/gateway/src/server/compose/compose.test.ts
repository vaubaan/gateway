import { PluginRegistry } from '@vaubaan/plugin-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadInstanceConfig } from '../config';
import { validEnv } from '../../../tests/support/config/testing';
import { openMemoryStore, type CatalogIndex } from '../store';
import { bootOrExit, EXIT_CONFIG_ERROR } from './boot';
import { MemoryRateLimiter, MemorySessionStore } from './memory';
import { RegistryCatalogIndex } from './registry';
import { buildRoot, getRoot, NO_TRUSTED_PROXY_WARNING, resetRoot, type RootDeps } from './root';
import { SHIPPED_PLUGINS } from './shipped-plugins';
import { fakePlugin, memoryStoreDeps } from '../../../tests/support/compose/testing';

const quiet: RootDeps = {
  loadConfig: () => loadInstanceConfig({ env: validEnv() }),
  logWrite: () => undefined,
  ...memoryStoreDeps,
};

afterEach(async () => {
  await resetRoot();
});

describe('buildRoot', () => {
  it('builds config, logger, encryptor, the shipped registry and the store from configuration alone', async () => {
    const root = await buildRoot(quiet);
    expect(root.config.publicUrl.origin).toBe('https://gateway.example.com');
    expect(root.configFile).toBeNull();
    expect(root.encryptor.currentKeyVersion).toBe(1);
    expect(root.store.kind).toBe('memory');
    expect(root.store.schemaVersion).toBe(30);
    expect(root.registry.size).toBe(SHIPPED_PLUGINS.length);
    expect(root.registry.ids).toEqual(SHIPPED_PLUGINS.map((p) => p.id));
    expect(new Set(root.registry.ids).size).toBe(root.registry.size);
    expect((await root.connections.service.providers()).map((p) => p.id)).toEqual(
      root.registry.ids,
    );
    expect(root.build).toEqual({ version: 'dev', commit: 'dev' });
    const sealed = await root.encryptor.encrypt('conn-1', 'hello');
    await expect(root.encryptor.decrypt('conn-1', sealed)).resolves.toBe('hello');
    await root.close();
  });

  it('hands the encryptor and a registry-backed catalog index to the store, and closes it', async () => {
    let seenCatalog: CatalogIndex | null = null;
    let seenEncryptor: unknown = null;
    let closed = false;
    const root = await buildRoot({
      ...quiet,
      buildRegistry: async () => new PluginRegistry([fakePlugin()]),
      openStore: async ({ encryptor, catalog }) => {
        seenCatalog = catalog;
        seenEncryptor = encryptor;
        const store = openMemoryStore({ encryptor, catalog });
        return {
          ...store,
          close: async () => {
            closed = true;
            await store.close();
          },
        };
      },
    });
    expect(seenEncryptor).toBe(root.encryptor);
    expect(seenCatalog).toBeInstanceOf(RegistryCatalogIndex);
    expect(seenCatalog!.has('acme.read-things')).toBe(true);
    expect(seenCatalog!.has('acme[staging].thing-write')).toBe(true);
    expect(seenCatalog!.has('acme[dev].thing-write')).toBe(false);
    expect(seenCatalog!.has('acme[prod].read-things')).toBe(false); // not env-scoped
    expect(seenCatalog!.has('nope.read-things')).toBe(false);
    expect(seenCatalog!.has('acme.*')).toBe(false);
    expect(root.registry.ids).toEqual(['acme']);
    await root.close();
    expect(closed).toBe(true);
  });

  it('starts with the retired OAuth-client keys still set, and warns once per key without its value', async () => {
    // ADR gmail-over-imap-with-an-app-password: `providers.<id>.*` is no longer read.
    const lines: string[] = [];
    const root = await buildRoot({
      ...quiet,
      loadConfig: () =>
        loadInstanceConfig({
          env: validEnv({
            VAUBAAN_PROVIDER_GMAIL_CLIENT_ID: 'cid-0123456789',
            VAUBAAN_PROVIDER_GMAIL_CLIENT_SECRET: 'csecret-0123456789',
          }),
        }),
      logWrite: (_lvl, line) => lines.push(line),
    });
    expect(root.config.retiredKeys).toEqual([
      'VAUBAAN_PROVIDER_GMAIL_CLIENT_ID',
      'VAUBAAN_PROVIDER_GMAIL_CLIENT_SECRET',
    ]);
    const retired = lines.filter((l) => l.includes('configuration key no longer read'));
    expect(retired).toHaveLength(2);
    expect(retired.join('\n')).toContain('VAUBAAN_PROVIDER_GMAIL_CLIENT_ID');
    expect(lines.join('\n')).not.toContain('csecret-0123456789');
    expect(lines.join('\n')).not.toContain('cid-0123456789');
    await root.close();
  });

  it('warns at boot when trusted_proxies is empty, naming the key and what it costs; says nothing once it is set', async () => {
    const bootLog = async (env: Record<string, string>): Promise<string[]> => {
      const lines: string[] = [];
      const root = await buildRoot({
        ...quiet,
        loadConfig: () => loadInstanceConfig({ env: validEnv(env) }),
        logWrite: (_level, line) => lines.push(line),
      });
      await root.close();
      return lines;
    };

    const without = (await bootLog({})).filter((line) => line.includes(NO_TRUSTED_PROXY_WARNING));
    expect(without).toHaveLength(1);
    expect(JSON.parse(without[0] ?? '{}')).toMatchObject({
      level: 'warn',
      key: 'trusted_proxies',
      env: 'VAUBAAN_TRUSTED_PROXIES',
    });
    expect(without[0]).toContain('429');

    const withProxy = await bootLog({ VAUBAAN_TRUSTED_PROXIES: '10.0.0.0/8' });
    expect(withProxy.some((line) => line.includes(NO_TRUSTED_PROXY_WARNING))).toBe(false);
    expect(withProxy.join('')).toContain('"trusted_proxies":1');
  });

  it('never writes a secret to the boot log', async () => {
    const lines: string[] = [];
    const env = validEnv();
    const root = await buildRoot({
      ...quiet,
      loadConfig: () => loadInstanceConfig({ env }),
      logWrite: (_lvl, line) => lines.push(line),
    });
    await root.close();
    const all = lines.join('');
    expect(all).toContain('configuration loaded');
    expect(all).toContain('composition root ready');
    expect(all).not.toContain(env.VAUBAAN_MASTER_KEY);
    expect(all).not.toContain(env.VAUBAAN_BOOTSTRAP_TOKEN);
  });
});

describe('buildRoot when a step fails after the store is opened', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes the store handle and stops the timers it had started, then rethrows', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let closes = 0;
    let sweepersStarted = false;
    const deps: RootDeps = {
      ...quiet,
      openStore: async ({ encryptor, catalog }) => {
        const store = openMemoryStore({ encryptor, catalog });
        const failing = {
          ...store,
          audit: {
            ...store.audit,
            // The first retention purge runs after the request sweeper and the
            // retention timer are started: from here on, the wiring fails.
            purgeByRetention: async (...args: Parameters<typeof store.audit.purgeByRetention>) => {
              sweepersStarted = true;
              return store.audit.purgeByRetention(...args);
            },
          },
          close: async () => {
            closes += 1;
            await store.close();
          },
        };
        Object.defineProperty(failing, 'sessions', {
          get() {
            if (sweepersStarted) throw new Error('late wiring failure');
            return store.sessions;
          },
        });
        return failing;
      },
    };

    await expect(buildRoot(deps)).rejects.toThrow('late wiring failure');
    expect(sweepersStarted).toBe(true);
    expect(closes).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a root that builds stops its timers and closes the store once on close()', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let closes = 0;
    const root = await buildRoot({
      ...quiet,
      openStore: async ({ encryptor, catalog }) => {
        const store = openMemoryStore({ encryptor, catalog });
        return {
          ...store,
          close: async () => {
            closes += 1;
            await store.close();
          },
        };
      },
    });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await root.close();
    expect(closes).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
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

  it('MemorySessionStore returns null for unknown or expired sessions', async () => {
    let t = 0;
    const sessions = new MemorySessionStore<{ user: string }>(() => t);
    expect(await sessions.get('s1')).toBeNull();
    await sessions.set('s1', { user: 'u' }, 10);
    expect(await sessions.get('s1')).toEqual({ user: 'u' });
    t = 10;
    expect(await sessions.get('s1')).toBeNull();
  });
});
