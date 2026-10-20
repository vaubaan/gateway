/**
 * `POST /admin/provider-apps/<provider>` and the form handlers of the
 * Connections surface, at their edges: an audit entry that cannot be written
 * after the change is committed, and a body that is not a form.
 *
 * Over the real composition root (`:memory:` store) with a fixture plugin.
 */
import { createRegistry } from '@vaubaan/plugin-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SESSION_COOKIE } from '../../../../src/server/auth';
import { buildRoot, type GatewayRoot } from '../../../../src/server/compose/root';
import { memoryStoreDeps } from '../../../../src/server/compose/testing';
import { loadInstanceConfig } from '../../../../src/server/config';
import { validEnv } from '../../../../src/server/config/testing';
import {
  connectPagePath,
  NOTICE_PARAM,
  providerAppActionPath,
} from '../../../../src/server/connections';
import { fixturePlugin, OAUTH_SPEC } from '../../../../src/server/connections/testing';
import type { UserRecord } from '../../../../src/server/store/types';

const PUBLIC_URL = 'https://gateway.example.com';
const OPERATOR_EMAIL = 'ops@example.com';
const CLIENT_SECRET = 'oauth-client-secret-value';
const AUDIT_NOT_WRITTEN = 'audit entry not written';

describe('provider-app handler: audit failure and malformed bodies', () => {
  let root: GatewayRoot;
  let operator: UserRecord;
  let lines: string[];

  beforeEach(async () => {
    lines = [];
    root = await buildRoot({
      loadConfig: () =>
        loadInstanceConfig({
          env: validEnv({ VAUBAAN_PUBLIC_URL: PUBLIC_URL, VAUBAAN_ADMIN_EMAILS: OPERATOR_EMAIL }),
        }),
      logWrite: (_level, line) => lines.push(line),
      buildRegistry: async () =>
        createRegistry([fixturePlugin({ id: 'oauthco', credential: OAUTH_SPEC })]),
      providerFetch: async () => {
        throw new Error('no provider is reachable from a test');
      },
      ...memoryStoreDeps,
    });
    operator = await root.store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'idp|ops',
      email: OPERATOR_EMAIL,
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await root.close();
  });

  async function operatorHeaders(contentType: string): Promise<Headers> {
    const session = await root.auth.sessions.create({
      kind: 'user',
      userId: operator.id,
      login: { email: operator.email, groups: [] },
    });
    return new Headers({
      'content-type': contentType,
      origin: PUBLIC_URL,
      cookie: `${SESSION_COOKIE}=${session.id}`,
    });
  }

  async function formPost(path: string, fields: Record<string, string>): Promise<Request> {
    return new Request(`${PUBLIC_URL}${path}`, {
      method: 'POST',
      headers: await operatorHeaders('application/x-www-form-urlencoded'),
      body: new URLSearchParams(fields).toString(),
    });
  }

  async function jsonPost(path: string): Promise<Request> {
    return new Request(`${PUBLIC_URL}${path}`, {
      method: 'POST',
      headers: await operatorHeaders('application/json'),
      body: '{"field.client_id":"x"}',
    });
  }

  function auditFails(): void {
    vi.spyOn(root.store.auditWriter, 'write').mockRejectedValueOnce(new Error('audit down'));
  }

  function errorLineFor(provider: string): Record<string, unknown> {
    const line = lines.find((l) => l.includes(AUDIT_NOT_WRITTEN));
    expect(line).toBeDefined();
    expect(line).not.toContain(CLIENT_SECRET);
    const parsed = JSON.parse(line ?? '{}') as Record<string, unknown>;
    expect(parsed).toMatchObject({ level: 'error', actor: operator.id, provider });
    return parsed;
  }

  function expectSavedRedirect(response: Response, provider: string): void {
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location') ?? '', PUBLIC_URL);
    expect(location.pathname).toBe(connectPagePath(provider));
    expect(location.searchParams.get(NOTICE_PARAM)).toBeTruthy();
  }

  it('a saved provider app whose audit entry cannot be written stands, and is logged at error', async () => {
    auditFails();
    const response = await root.connections.handlers.saveProviderApp(
      await formPost(providerAppActionPath('oauthco'), {
        'field.client_id': 'cid',
        'field.client_secret': CLIENT_SECRET,
      }),
      'oauthco',
    );
    // The settings are committed: the operator is told so, not shown a server error.
    expectSavedRedirect(response, 'oauthco');
    const status = await root.providerApps.status('oauthco');
    expect(status.values).toMatchObject({ client_id: 'cid' });
    expect(status.secretsSet).toContain('client_secret');
    errorLineFor('oauthco');
  });

  it('writes the audit entry and no error line when the audit works', async () => {
    const write = vi.spyOn(root.store.auditWriter, 'write');
    const response = await root.connections.handlers.saveProviderApp(
      await formPost(providerAppActionPath('oauthco'), {
        'field.client_id': 'cid',
        'field.client_secret': CLIENT_SECRET,
      }),
      'oauthco',
    );
    expectSavedRedirect(response, 'oauthco');
    expect(lines.some((l) => l.includes(AUDIT_NOT_WRITTEN))).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toMatchObject({
      kind: 'admin',
      act: 'config-changed',
      user_id: operator.id,
      object: { type: 'instance-config', id: 'provider-app:oauthco' },
    });
    await expect(write.mock.results[0]?.value).resolves.toBeUndefined();
  });

  it('answers 400 to a body that is not a form, on every form handler, and writes nothing', async () => {
    const responses = [
      await root.connections.handlers.saveProviderApp(
        await jsonPost(providerAppActionPath('oauthco')),
        'oauthco',
      ),
      await root.connections.handlers.connect(
        await jsonPost('/accounts/connect/oauthco'),
        'oauthco',
      ),
      await root.connections.handlers.updateResource(
        await jsonPost('/accounts/c1/resources/r1'),
        'c1',
        'r1',
      ),
    ];
    for (const response of responses) {
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid-request' });
    }
    expect((await root.providerApps.status('oauthco')).secretsSet).toEqual([]);
    expect(await root.store.connections.list()).toEqual([]);
  });
});
