/**
 * The key handed over by the instance (ADR
 * master-key-generated-and-handed-over-by-the-instance) on a real root over the
 * `:memory:` store: the download for an operator signed in recently, audited
 * before the key leaves and never carrying it; the handover confirmation of
 * Setup; every refusal (no session, a plain user, a foreign origin, a stale
 * sign-in, no confirmation).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../../../src/server/auth';
import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { memoryStoreDeps } from '../../../src/server/compose/testing';
import { loadInstanceConfig } from '../../../src/server/config';
import { validEnv } from '../../../src/server/config/testing';
import { createMasterKeyHandlers } from '../../../src/server/master-key/handlers';
import {
  CONFIRMED_FIELD,
  FRESH_SIGN_IN_MS,
  FROM_FIELD,
  KEY_PROBLEM_PARAM,
  MASTER_KEY_DOWNLOAD_ACTION,
  MASTER_KEY_FILE_NAME,
  MASTER_KEY_GENERATED_KEY,
  MASTER_KEY_HANDED_OVER_KEY,
  MASTER_KEY_HANDOVER_ACTION,
  MASTER_KEY_OBJECT_ID,
} from '../../../src/server/master-key';

const PUBLIC_URL = 'https://gateway.example.com';
const OPERATOR_EMAIL = 'ops@example.com';

type Caller = 'operator' | 'bootstrap' | 'user' | 'nobody';

describe('the master key handed over by the instance', () => {
  let root: GatewayRoot | null = null;

  afterEach(async () => {
    await root?.close();
    root = null;
  });

  async function open(): Promise<GatewayRoot> {
    root = await buildRoot({
      loadConfig: () =>
        loadInstanceConfig({
          env: validEnv({
            VAUBAAN_PUBLIC_URL: PUBLIC_URL,
            VAUBAAN_ADMIN_EMAILS: OPERATOR_EMAIL,
            VAUBAAN_MASTER_KEY_VERSION: '2',
          }),
        }),
      logWrite: () => undefined,
      ...memoryStoreDeps,
    });
    return root;
  }

  async function cookieOf(r: GatewayRoot, as: Caller): Promise<string | null> {
    if (as === 'nobody') return null;
    if (as === 'bootstrap') {
      const session = await r.auth.sessions.create({ kind: 'bootstrap' });
      return `${SESSION_COOKIE}=${session.id}`;
    }
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

  async function post(
    r: GatewayRoot,
    action: string,
    fields: Record<string, string>,
    options: { as?: Caller; origin?: string; cookie?: string | null } = {},
  ): Promise<Request> {
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      origin: options.origin ?? PUBLIC_URL,
    };
    const cookie =
      options.cookie !== undefined ? options.cookie : await cookieOf(r, options.as ?? 'operator');
    if (cookie) headers.cookie = cookie;
    return new Request(`${PUBLIC_URL}${action}`, {
      method: 'POST',
      headers,
      body: new URLSearchParams(fields).toString(),
    });
  }

  async function download(
    r: GatewayRoot,
    fields: Record<string, string> = { [FROM_FIELD]: 'settings', [CONFIRMED_FIELD]: 'on' },
    options: { as?: Caller; origin?: string; cookie?: string | null } = {},
  ): Promise<Response> {
    return r.masterKey.handlers.download(
      await post(r, MASTER_KEY_DOWNLOAD_ACTION, fields, options),
    );
  }

  async function keyAudit(r: GatewayRoot) {
    return (await r.store.audit.list({ kind: 'admin' })).filter(
      (e) => e.kind === 'admin' && e.object.id === MASTER_KEY_OBJECT_ID,
    );
  }

  it('hands the key file to an operator who just signed in, audited by name before it leaves', async () => {
    const r = await open();
    const res = await download(r);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="${MASTER_KEY_FILE_NAME}"`,
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).toBe(`${Buffer.from(r.config.encryption.masterKey).toString('base64')}\n`);

    const entries = await keyAudit(r);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry).toMatchObject({
      act: 'master-key-downloaded',
      object: { type: 'instance-config', id: MASTER_KEY_OBJECT_ID },
      before: null,
      after: { key_version: 2, from: 'settings' },
    });
    expect(entry?.kind === 'admin' ? entry.user_id : null).not.toBe('bootstrap');
    expect(JSON.stringify(entry)).not.toContain(text.trim());
  });

  it('hands it to the bootstrap operator from the setup step, audited as "bootstrap", no box needed', async () => {
    const r = await open();
    const res = await download(r, { [FROM_FIELD]: 'setup' }, { as: 'bootstrap' });
    expect(res.status).toBe(200);
    const entries = await keyAudit(r);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      user_id: 'bootstrap',
      act: 'master-key-downloaded',
      after: { key_version: 2, from: 'setup' },
    });
  });

  it('from Settings the box must be ticked, and the refusal says so', async () => {
    const r = await open();
    const res = await download(r, { [FROM_FIELD]: 'settings' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(
      `/admin/encryption?${KEY_PROBLEM_PARAM}=not-confirmed`,
    );
    expect(await keyAudit(r)).toHaveLength(0);
  });

  it('refuses a sign-in older than the fresh window, from either page, writing nothing', async () => {
    const r = await open();
    const later = new Date(Date.now() + FRESH_SIGN_IN_MS + 1_000);
    const handlers = createMasterKeyHandlers({
      publicUrl: r.config.publicUrl,
      authenticator: r.auth.authenticator,
      sessions: r.auth.sessions,
      service: r.masterKey.service,
      audit: r.store.auditWriter,
      logger: r.logger,
      clock: { now: () => later },
    });
    const settings = await handlers.download(
      await post(r, MASTER_KEY_DOWNLOAD_ACTION, {
        [FROM_FIELD]: 'settings',
        [CONFIRMED_FIELD]: 'on',
      }),
    );
    expect(settings.status).toBe(303);
    expect(settings.headers.get('location')).toBe(
      `/admin/encryption?${KEY_PROBLEM_PARAM}=sign-in-again`,
    );
    const setup = await handlers.download(
      await post(r, MASTER_KEY_DOWNLOAD_ACTION, { [FROM_FIELD]: 'setup' }, { as: 'bootstrap' }),
    );
    expect(setup.headers.get('location')).toBe(
      `/admin?${KEY_PROBLEM_PARAM}=sign-in-again#encryption-key`,
    );
    expect(await keyAudit(r)).toHaveLength(0);
  });

  it('refuses a visitor without a session (401), a plain user (403) and a foreign origin (403)', async () => {
    const r = await open();
    expect((await download(r, undefined, { as: 'nobody' })).status).toBe(401);
    expect((await download(r, undefined, { as: 'user' })).status).toBe(403);
    expect((await download(r, undefined, { origin: 'https://evil.example.com' })).status).toBe(403);
    expect(await keyAudit(r)).toHaveLength(0);
  });

  it('refuses the key when its audit entry cannot be written', async () => {
    const r = await open();
    const handlers = createMasterKeyHandlers({
      publicUrl: r.config.publicUrl,
      authenticator: r.auth.authenticator,
      sessions: r.auth.sessions,
      service: r.masterKey.service,
      audit: {
        write: async () => {
          throw new Error('disk full');
        },
      },
      logger: r.logger,
      clock: { now: () => new Date() },
    });
    await expect(
      handlers.download(
        await post(r, MASTER_KEY_DOWNLOAD_ACTION, {
          [FROM_FIELD]: 'settings',
          [CONFIRMED_FIELD]: 'on',
        }),
      ),
    ).rejects.toThrow('disk full');
  });

  it('the handover: pending once generated, confirmed by the ticked box, audited once', async () => {
    const r = await open();
    expect(await r.masterKey.service.state()).toMatchObject({
      keyVersion: 2,
      file: null,
      generatedAt: null,
      handedOverAt: null,
      handoverPending: false,
    });
    await r.masterKey.service.recordGenerated();
    expect((await r.masterKey.service.state()).handoverPending).toBe(true);

    const unticked = await r.masterKey.handlers.confirmHandover(
      await post(r, MASTER_KEY_HANDOVER_ACTION, {}, { as: 'bootstrap' }),
    );
    expect(unticked.status).toBe(303);
    expect(unticked.headers.get('location')).toBe(
      `/admin?${KEY_PROBLEM_PARAM}=not-confirmed#encryption-key`,
    );
    expect(await r.store.config.get(MASTER_KEY_HANDED_OVER_KEY)).toBeNull();

    const ticked = await r.masterKey.handlers.confirmHandover(
      await post(r, MASTER_KEY_HANDOVER_ACTION, { [CONFIRMED_FIELD]: 'on' }, { as: 'bootstrap' }),
    );
    expect(ticked.status).toBe(303);
    expect(ticked.headers.get('location')).toBe('/admin');
    const state = await r.masterKey.service.state();
    expect(state.handoverPending).toBe(false);
    expect(state.handedOverAt).toMatch(/^\d{4}-/);
    expect(await r.store.config.get(MASTER_KEY_GENERATED_KEY)).toBe(state.generatedAt);

    const entries = await keyAudit(r);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      user_id: 'bootstrap',
      act: 'config-changed',
      before: { handed_over_at: null },
      after: { handed_over_at: state.handedOverAt },
    });

    // A second confirmation keeps the first timestamp and writes nothing.
    await r.masterKey.handlers.confirmHandover(
      await post(r, MASTER_KEY_HANDOVER_ACTION, { [CONFIRMED_FIELD]: 'on' }),
    );
    expect((await r.masterKey.service.state()).handedOverAt).toBe(state.handedOverAt);
    expect(await keyAudit(r)).toHaveLength(1);
  });

  it('the confirmation is an operator act too: a plain user and a foreign origin are refused', async () => {
    const r = await open();
    await r.masterKey.service.recordGenerated();
    const user = await r.masterKey.handlers.confirmHandover(
      await post(r, MASTER_KEY_HANDOVER_ACTION, { [CONFIRMED_FIELD]: 'on' }, { as: 'user' }),
    );
    expect(user.status).toBe(403);
    const foreign = await r.masterKey.handlers.confirmHandover(
      await post(
        r,
        MASTER_KEY_HANDOVER_ACTION,
        { [CONFIRMED_FIELD]: 'on' },
        { origin: 'https://evil.example.com' },
      ),
    );
    expect(foreign.status).toBe(403);
    expect((await r.masterKey.service.state()).handoverPending).toBe(true);
  });
});
