import { describe, expect, it } from 'vitest';

import { loadInstanceConfig } from '../config';
import { validEnv } from '../config/testing';
import { buildRoot } from '../compose/root';
import { memoryStoreDeps } from '../compose/testing';
import { openMemoryStore } from '../store';
import { healthHandler, healthResponse } from './healthz';

const deps = {
  loadConfig: () => loadInstanceConfig({ env: validEnv() }),
  logWrite: () => undefined,
  build: { version: '2.0.0-test', commit: 'abc1234' },
  ...memoryStoreDeps,
};

describe('/healthz', () => {
  it('answers 200 with build stamps and the store kind, never configuration values', async () => {
    const root = await buildRoot(deps);
    const res = await healthResponse(root);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: 'ok',
      version: '2.0.0-test',
      commit: 'abc1234',
      store: { kind: 'memory', status: 'ok' },
    });
    expect(typeof body.uptime_seconds).toBe('number');
    expect(JSON.stringify(body)).not.toContain('example.com');
    await root.close();
  });

  it('answers 503 degraded when the store does not ping', async () => {
    const root = await buildRoot({
      ...deps,
      openStore: async ({ encryptor, catalog }) => ({
        ...openMemoryStore({ encryptor, catalog }),
        ping: async () => Promise.reject(new Error('locked')),
      }),
    });
    const res = await healthResponse(root);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      status: 'degraded',
      store: { kind: 'memory', status: 'error' },
    });
    await root.close();
  });

  it('answers 503 unavailable when the root cannot be built', async () => {
    const handler = healthHandler(() => Promise.reject(new Error('no config')));
    const res = await handler();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: 'unavailable' });
  });
});
