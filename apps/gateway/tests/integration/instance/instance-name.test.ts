/**
 * The instance's name on a real instance (spec §4.2, §4.3): the composition
 * root on the `:memory:` store, the Administration handler driven with real
 * requests and web sessions.
 *
 * What is pinned: the host stands in while nothing names the instance; an
 * administrator's name is stored in `instance_config` and audited as
 * `config-changed` on `instance-config:instance-name`; clearing it brings the
 * host back; a non-administrator, a foreign origin and an invalid name change
 * nothing; a name set by the configuration wins and makes the field read-only.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../../../src/server/auth';
import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { memoryStoreDeps } from '../../../src/server/compose/testing';
import { loadInstanceConfig } from '../../../src/server/config';
import { validEnv } from '../../../src/server/config/testing';
import {
  INSTANCE_NAME_ACTION,
  INSTANCE_NAME_KEY,
  INSTANCE_NAME_OBJECT_ID,
  NAME_FIELD,
  NAME_PROBLEM_PARAM,
} from '../../../src/server/instance';

const PUBLIC_URL = 'https://gateway-production-1a2b.up.railway.app';
const HOST = new URL(PUBLIC_URL).host;
const OPERATOR_EMAIL = 'ops@example.com';

type Caller = 'operator' | 'user' | 'nobody';

describe('instance name', () => {
  let root: GatewayRoot | null = null;

  afterEach(async () => {
    await root?.close();
    root = null;
  });

  async function open(env: Record<string, string | undefined> = {}): Promise<GatewayRoot> {
    root = await buildRoot({
      loadConfig: () =>
        loadInstanceConfig({
          env: validEnv({
            VAUBAAN_PUBLIC_URL: PUBLIC_URL,
            VAUBAAN_ADMIN_EMAILS: OPERATOR_EMAIL,
            ...env,
          }),
        }),
      logWrite: () => undefined,
      ...memoryStoreDeps,
    });
    return root;
  }

  async function cookieOf(r: GatewayRoot, as: Caller): Promise<string | null> {
    if (as === 'nobody') return null;
    const user = await r.store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: `idp|${as}`,
      email: as === 'operator' ? OPERATOR_EMAIL : 'dev@example.com',
    });
    const session = await r.auth.sessions.create({
      kind: 'user',
      userId: user.id,
      login: { email: user.email, groups: [] },
    });
    return `${SESSION_COOKIE}=${session.id}`;
  }

  async function save(
    r: GatewayRoot,
    name: string,
    options: { as?: Caller; origin?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      origin: options.origin ?? PUBLIC_URL,
    };
    const cookie = await cookieOf(r, options.as ?? 'operator');
    if (cookie) headers.cookie = cookie;
    return r.instance.handlers.setName(
      new Request(`${PUBLIC_URL}${INSTANCE_NAME_ACTION}`, {
        method: 'POST',
        headers,
        body: new URLSearchParams({ [NAME_FIELD]: name }).toString(),
      }),
    );
  }

  async function nameAudit(r: GatewayRoot) {
    return (await r.store.audit.list({ kind: 'admin' })).filter(
      (e) => e.kind === 'admin' && e.object.id === INSTANCE_NAME_OBJECT_ID,
    );
  }

  it('shows the host of the public URL while nothing names the instance', async () => {
    const r = await open();
    expect(r.config.instanceName).toBeNull();
    expect(await r.instance.name.identity()).toEqual({
      label: HOST,
      name: null,
      host: HOST,
      source: 'default',
    });
  });

  it('stores the name an administrator saves, audited once, then clears it on a blank value', async () => {
    const r = await open();
    const saved = await save(r, '  Dalae prod  ');
    expect(saved.status).toBe(303);
    expect(saved.headers.get('location')).toBe('/admin#instance-name');
    expect(await r.store.config.get(INSTANCE_NAME_KEY)).toBe('Dalae prod');
    expect(await r.instance.name.identity()).toMatchObject({
      label: 'Dalae prod',
      host: HOST,
      source: 'admin',
    });

    const entries = await nameAudit(r);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      act: 'config-changed',
      object: { type: 'instance-config', id: INSTANCE_NAME_OBJECT_ID },
      before: { name: null, source: 'default' },
      after: { name: 'Dalae prod', source: 'admin' },
    });

    // The same name again changes nothing and writes nothing.
    await save(r, 'Dalae prod');
    expect(await nameAudit(r)).toHaveLength(1);

    await save(r, '   ');
    expect(await r.store.config.get(INSTANCE_NAME_KEY)).toBeNull();
    expect((await r.instance.name.identity()).label).toBe(HOST);
    const cleared = await nameAudit(r);
    expect(cleared).toHaveLength(2);
    expect(cleared.map((e) => (e.kind === 'admin' ? [e.before, e.after] : null))).toContainEqual([
      { name: 'Dalae prod', source: 'admin' },
      { name: null, source: 'default' },
    ]);
  });

  it('refuses an invalid name with its reason, and stores nothing', async () => {
    const r = await open();
    const long = await save(r, 'x'.repeat(65));
    expect(long.status).toBe(303);
    expect(long.headers.get('location')).toBe(
      `/admin?${NAME_PROBLEM_PARAM}=too-long#instance-name`,
    );
    const control = await save(r, 'prod\nstaging');
    expect(control.headers.get('location')).toContain(`${NAME_PROBLEM_PARAM}=control-character`);
    expect(await r.store.config.get(INSTANCE_NAME_KEY)).toBeNull();
    expect(await nameAudit(r)).toHaveLength(0);
  });

  it.each([
    ['a signed-in user who is not an administrator', { as: 'user' as const }, 403],
    ['a visitor without a session', { as: 'nobody' as const }, 401],
    ['an administrator posting from another origin', { origin: 'https://evil.example' }, 403],
  ])('refuses %s, and changes nothing', async (_label, options, status) => {
    const r = await open();
    const response = await save(r, 'Hijacked', options);
    expect(response.status).toBe(status);
    expect(await r.store.config.get(INSTANCE_NAME_KEY)).toBeNull();
    expect(await nameAudit(r)).toHaveLength(0);
  });

  it('a name set by the configuration wins over a stored one, and the field is read-only', async () => {
    const r = await open({ VAUBAAN_INSTANCE_NAME: 'Fiabilis AI' });
    await r.store.config.set(INSTANCE_NAME_KEY, 'stored earlier');
    expect(r.instance.name.isLocked()).toBe(true);
    expect(await r.instance.name.identity()).toMatchObject({
      label: 'Fiabilis AI',
      source: 'config',
    });

    const response = await save(r, 'Other');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      `/admin?${NAME_PROBLEM_PARAM}=locked#instance-name`,
    );
    expect(await r.store.config.get(INSTANCE_NAME_KEY)).toBe('stored earlier');
    expect(await nameAudit(r)).toHaveLength(0);
  });
});
