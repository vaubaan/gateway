/**
 * The sign-in start, the callbacks and the bootstrap endpoint are rate-limited
 * (security review 2026-10-15, auth M1): per client address when it is known,
 * instance-wide always; a guessed bootstrap token is revoked after
 * `BOOTSTRAP_MAX_MISSES` wrong ones.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { AUTH_LIMITS, BOOTSTRAP_MAX_MISSES, BOOTSTRAP_REVOKED_KEY } from '../../../src/server/auth';
import { memoryStoreDeps } from '../../../src/server/compose/testing';
import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { loadInstanceConfig } from '../../../src/server/config';
import { TEST_BOOTSTRAP_TOKEN, validEnv } from '../../../src/server/config/testing';

const PUBLIC_URL = 'https://gateway.example.com';

async function rootWith(env: Record<string, string> = {}): Promise<GatewayRoot> {
  return buildRoot({
    loadConfig: () =>
      loadInstanceConfig({
        env: validEnv({
          VAUBAAN_PUBLIC_URL: PUBLIC_URL,
          VAUBAAN_SIGN_IN_ACME_KIND: 'github',
          VAUBAAN_SIGN_IN_ACME_CLIENT_ID: 'Ov23liExample',
          VAUBAAN_SIGN_IN_ACME_CLIENT_SECRET: 'github-secret-for-tests',
          VAUBAAN_SIGN_IN_ACME_INVITATION_ONLY: 'true',
          ...env,
        }),
      }),
    logWrite: () => undefined,
    ...memoryStoreDeps,
  });
}

function start(root: GatewayRoot, address?: string): Promise<Response> {
  return root.auth.handlers.loginStart(
    new Request(`${PUBLIC_URL}/auth/login/acme`, {
      headers: address ? { 'x-real-ip': address } : {},
    }),
    'acme',
  );
}

describe('sign-in limits', () => {
  let root: GatewayRoot;
  afterEach(async () => {
    await root.close();
  });

  it('per client address, when the address is known', async () => {
    root = await rootWith({ VAUBAAN_CLIENT_IP_HEADER: 'x-real-ip' });
    const { limit } = AUTH_LIMITS.loginStartPerAddress;
    for (let i = 0; i < limit; i += 1) {
      expect((await start(root, '203.0.113.7')).headers.get('location')).not.toContain('error=');
    }
    const refused = await start(root, '203.0.113.7');
    expect(refused.headers.get('location')).toBe('/login?error=too-many-attempts');
    expect(refused.headers.get('set-cookie')).toBeNull();
    // Another address is not held by the first one.
    expect((await start(root, '198.51.100.9')).headers.get('location')).not.toContain('error=');
  });

  it('instance-wide when the address is unknown: the live pending rows are bounded', async () => {
    root = await rootWith();
    const before = await root.store.webSessions.count();
    const { limit } = AUTH_LIMITS.loginStartPerInstance;
    for (let i = 0; i < limit; i += 1) await start(root);
    expect((await start(root)).headers.get('location')).toBe('/login?error=too-many-attempts');
    expect((await root.store.webSessions.count()) - before).toBe(limit);
  });

  it('the bootstrap endpoint: a hard window, then a durable revocation of a guessed token', async () => {
    root = await rootWithoutProvider();
    const post = (token: string): Promise<Response> =>
      root.auth.handlers.bootstrapLogin(
        new Request(`${PUBLIC_URL}/api/auth/bootstrap`, {
          method: 'POST',
          headers: { origin: PUBLIC_URL, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token }).toString(),
        }),
      );
    const { limit } = AUTH_LIMITS.bootstrapPerInstance;
    for (let i = 0; i < limit; i += 1) {
      expect((await post(`wrong-${i}`)).headers.get('location')).toBe(
        '/admin/bootstrap?error=bootstrap-refused',
      );
    }
    expect((await post(TEST_BOOTSTRAP_TOKEN)).headers.get('location')).toBe(
      '/admin/bootstrap?error=too-many-attempts',
    );
  });

  it('revokes the bootstrap token after BOOTSTRAP_MAX_MISSES wrong ones', async () => {
    root = await rootWithoutProvider();
    for (let i = 0; i < BOOTSTRAP_MAX_MISSES - 1; i += 1) {
      expect(await root.auth.bootstrap.recordMiss()).toBe(false);
    }
    expect(await root.auth.bootstrap.recordMiss()).toBe(true);
    expect(await root.store.config.get(BOOTSTRAP_REVOKED_KEY)).not.toBeNull();
    expect(await root.auth.bootstrap.verify(TEST_BOOTSTRAP_TOKEN)).toBe(false);
  });
});

function rootWithoutProvider(): Promise<GatewayRoot> {
  return buildRoot({
    loadConfig: () => loadInstanceConfig({ env: validEnv({ VAUBAAN_PUBLIC_URL: PUBLIC_URL }) }),
    logWrite: () => undefined,
    ...memoryStoreDeps,
  });
}
