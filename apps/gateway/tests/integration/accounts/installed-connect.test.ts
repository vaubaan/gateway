/**
 * Connect Google Calendar and Outlook with no client of my own (ADR
 * local-instance-carries-installed-oauth-clients; intent of the same name in "Run Vaubaan on
 * my computer"): on a local instance, a plugin that declares `broker: { provider, scopes }`
 * connects through Vaubaan's installed-app client, back on the loopback, with no broker.
 * The providers' consent and token endpoints are faked behind the service fetch; the
 * "browsers" are requests: the provider's redirect to `http://127.0.0.1:3000/oauth/loopback`,
 * then the public URL with or without the person's session.
 */
import { randomBytes } from 'node:crypto';
import { createRegistry } from '@vaubaan/plugin-sdk';
import type { OAuth2BrokeredSpec } from '@vaubaan/plugin-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { loadInstanceConfig } from '../../../src/server/config';
import type { InstalledClient } from '../../../src/server/config/installed-clients';
import { INSTALLED_BROKER } from '../../../src/server/accounts/installed-broker';
import { ManualClock } from '../../../src/server/store/clock';
import type { UserRecord } from '../../../src/server/store/types';
import { fixturePlugin } from '../../support/accounts/testing';
import { memoryStoreDeps } from '../../support/compose/testing';

const ORIGIN = 'http://localhost:3000';
const LOOPBACK = 'http://127.0.0.1:3000/oauth/loopback';
const CLIENTS: InstalledClient[] = [
  { provider: 'google', clientId: 'google-client', clientSecret: 'google-secret' },
  { provider: 'microsoft', clientId: 'microsoft-client', clientSecret: null },
];
const CALENDAR: OAuth2BrokeredSpec = {
  kind: 'oauth2',
  broker: { provider: 'google' },
  scopes: [
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    'https://www.googleapis.com/auth/calendar.events',
  ],
};
const OUTLOOK: OAuth2BrokeredSpec = {
  kind: 'oauth2',
  broker: { provider: 'microsoft' },
  scopes: ['User.Read', 'Mail.ReadWrite', 'Calendars.ReadWrite'],
};
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke';
const MICROSOFT_TOKEN = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

/** The providers' token and revocation endpoints. */
class FakeProviders {
  readonly calls: { url: string; form: URLSearchParams }[] = [];
  private readonly codes = new Map<string, { challenge: string; redirect: string }>();
  private serial = 0;

  /** The consent: the redirect the provider sends the browser to. */
  consent(authorizeUrl: string): string {
    const url = new URL(authorizeUrl);
    const code = `code-${++this.serial}`;
    this.codes.set(code, {
      challenge: url.searchParams.get('code_challenge') ?? '',
      redirect: url.searchParams.get('redirect_uri') ?? '',
    });
    const back = new URL(url.searchParams.get('redirect_uri') ?? '');
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state') ?? '');
    return back.href;
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const form = new URLSearchParams(String(init?.body ?? ''));
    this.calls.push({ url, form });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url === GOOGLE_REVOKE) return new Response(null, { status: 200 });
    if (url !== GOOGLE_TOKEN && url !== MICROSOFT_TOKEN) return json({ error: 'not_found' }, 404);
    if (form.get('grant_type') === 'refresh_token') {
      const token = form.get('refresh_token') ?? '';
      if (token.startsWith('dead')) return json({ error: 'invalid_grant' }, 400);
      const next = `${token}+`;
      return json({
        access_token: `access-of-${next}`,
        expires_in: 3600,
        // Microsoft rotates the refresh token; Google does not.
        ...(url === MICROSOFT_TOKEN ? { refresh_token: next } : {}),
      });
    }
    const issued = this.codes.get(form.get('code') ?? '');
    this.codes.delete(form.get('code') ?? '');
    if (!issued || issued.redirect !== form.get('redirect_uri')) {
      return json({ error: 'invalid_grant' }, 400);
    }
    return json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 });
  };
}

async function rootWith(
  providers: FakeProviders,
  clients: readonly InstalledClient[] = CLIENTS,
): Promise<{ root: GatewayRoot; clock: ManualClock }> {
  const clock = new ManualClock('2026-11-27T10:00:00Z');
  const env = {
    VAUBAAN_MASTER_KEY: randomBytes(32).toString('base64'),
    VAUBAAN_UPDATES_CHECK: 'false',
    VAUBAAN_STORE_PATH: ':memory:',
    VAUBAAN_LOCAL: 'true',
  };
  const root = await buildRoot({
    ...memoryStoreDeps,
    loadConfig: () => {
      const loaded = loadInstanceConfig({ env });
      return {
        ...loaded,
        config: { ...loaded.config, bootstrapToken: 'b'.repeat(43), installedClients: clients },
      };
    },
    logWrite: () => undefined,
    clock,
    serviceFetch: providers.fetch,
    buildRegistry: async () =>
      createRegistry([
        fixturePlugin({ id: 'calco', displayName: 'Cal Co', credential: CALENDAR }),
        fixturePlugin({ id: 'outmo', displayName: 'Out Mo', credential: OUTLOOK }),
      ]),
  });
  return { root, clock };
}

function form(path: string, cookie: string | null, fields: Record<string, string>): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: ORIGIN,
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

function get(url: string, cookie: string | null = null): Request {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}

describe('connecting Google Calendar and Outlook with no client of my own', () => {
  let providers: FakeProviders;
  let root: GatewayRoot;
  let clock: ManualClock;
  let me: UserRecord;
  let session: string;

  beforeEach(async () => {
    providers = new FakeProviders();
    ({ root, clock } = await rootWith(providers));
    me = await root.store.users.upsertFromIdp({
      issuer: 'https://accounts.google.com',
      subject: 'g-1',
      email: 'me@example.com',
    });
    session = `vbn_session=${
      (
        await root.auth.sessions.create({
          kind: 'user',
          userId: me.id,
          login: { email: me.email, groups: [] },
        })
      ).id
    }`;
  });
  afterEach(async () => {
    await root.close();
  });

  /** The page's start: where the window is sent, as JSON. */
  async function start(service: string): Promise<URL> {
    const res = await root.accounts.handlers.connect(
      form(`/accounts/connect/${service}`, session, { respond: 'json' }),
      service,
    );
    expect(res.status).toBe(200);
    return new URL(((await res.json()) as { location: string }).location);
  }

  /** The provider's redirect on the loopback: where the browser is sent on. */
  async function backOnLoopback(redirect: string): Promise<string> {
    const res = await root.accounts.handlers.loopbackConnect(get(redirect));
    expect(res?.status).toBe(303);
    return res?.headers.get('location') ?? '';
  }

  async function finish(callback: string): Promise<string> {
    const res = await root.accounts.handlers.callback(
      get(callback, session),
      new URL(callback).pathname.split('/').at(-1) ?? '',
    );
    return res.headers.get('location') ?? '';
  }

  it('connects Google Calendar with no broker, asking the plugin’s scopes only, the refresh token sealed on this computer', async () => {
    expect((await root.accounts.service.service('calco'))?.unavailable).toBeNull();
    const consent = await start('calco');
    expect(consent.origin + consent.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(consent.searchParams.get('client_id')).toBe('google-client');
    expect(consent.searchParams.get('redirect_uri')).toBe(LOOPBACK);
    expect(consent.searchParams.get('scope')).toBe(CALENDAR.scopes.join(' '));
    expect(consent.searchParams.get('include_granted_scopes')).toBe('true');
    expect(consent.searchParams.get('code_challenge_method')).toBe('S256');

    const onward = await backOnLoopback(providers.consent(consent.href));
    expect(onward).toMatch(/^http:\/\/localhost:3000\/connections\/loopback\/done\?state=/);
    // The same browser holds the session: on to the service's callback, which connects.
    const done = await root.accounts.handlers.loopbackConnectDone(get(onward, session));
    const callback = done.headers.get('location') ?? '';
    expect(callback).toMatch(
      /^http:\/\/localhost:3000\/connections\/callback\/calco\?state=.+&grant=/,
    );
    await finish(callback);

    const [account] = await root.store.accounts.listOwnedBy([{ kind: 'user', id: me.id }]);
    expect(account?.service).toBe('calco');
    const resolved = await root.accounts.credentials.resolve(account?.id ?? '');
    expect(resolved.brokerGrant).toEqual({ broker: INSTALLED_BROKER, refreshToken: 'refresh-1' });
    expect(resolved.credential).toMatchObject({ accessToken: 'access-1', refreshToken: null });
    // The account page says how it signed in: Vaubaan's client on this computer.
    const detail = await root.accounts.service.get({ user: me, groups: [] }, account?.id ?? '');
    expect(detail.oauth_broker).toMatchObject({ name: INSTALLED_BROKER, installed: true });
    const exchange = providers.calls.find((c) => c.url === GOOGLE_TOKEN);
    expect(exchange?.form.get('client_secret')).toBe('google-secret');
    expect(exchange?.form.get('code_verifier')).toBeTruthy();
  });

  it('in the desktop app, the browser that consented is told to go back, and the window finishes the connection', async () => {
    const consent = await start('outmo');
    expect(consent.searchParams.get('scope')).toBe(`offline_access ${OUTLOOK.scopes.join(' ')}`);
    expect(consent.searchParams.get('response_mode')).toBe('query');

    const waiting = await root.accounts.handlers.loopbackConnectStatus(
      form('/connections/loopback/status', session, {}),
    );
    expect(await waiting.json()).toEqual({ status: 'pending' });

    const onward = await backOnLoopback(providers.consent(consent.href));
    // The default browser has no session of this person: nothing is taken there.
    const elsewhere = await root.accounts.handlers.loopbackConnectDone(get(onward));
    expect(elsewhere.headers.get('location')).toBe('/login/elsewhere?outcome=done');

    const taken = await root.accounts.handlers.loopbackConnectStatus(
      form('/connections/loopback/status', session, {}),
    );
    const body = (await taken.json()) as { status: string; location: string };
    expect(body.status).toBe('done');
    await finish(body.location);
    const accounts = await root.store.accounts.listOwnedBy([{ kind: 'user', id: me.id }]);
    expect(accounts.map((a) => a.service)).toEqual(['outmo']);
    // The Microsoft public client sends no secret.
    const exchange = providers.calls.find((c) => c.url === MICROSOFT_TOKEN);
    expect(exchange?.form.has('client_secret')).toBe(false);
  });

  it('refreshes at the provider with the installed client, keeping the refresh token Microsoft rotates', async () => {
    const consent = await start('outmo');
    const onward = await backOnLoopback(providers.consent(consent.href));
    const done = await root.accounts.handlers.loopbackConnectDone(get(onward, session));
    await finish(done.headers.get('location') ?? '');
    const [account] = await root.store.accounts.listOwnedBy([{ kind: 'user', id: me.id }]);
    const id = account?.id ?? '';

    const first = await root.accounts.credentials.refresh(id);
    expect(first.brokerGrant?.refreshToken).toBe('refresh-1+');
    expect(first.credential).toMatchObject({ accessToken: 'access-of-refresh-1+' });
    clock.advance(60_000);
    const second = await root.accounts.credentials.refresh(id);
    expect(second.brokerGrant?.refreshToken).toBe('refresh-1++');
    const refreshes = providers.calls.filter((c) => c.form.get('grant_type') === 'refresh_token');
    expect(refreshes.map((c) => c.form.get('refresh_token'))).toEqual(['refresh-1', 'refresh-1+']);
    expect(refreshes.every((c) => !c.form.has('client_secret'))).toBe(true);
  });

  it('revokes a Google grant at Google’s revocation endpoint when the account is disconnected', async () => {
    const consent = await start('calco');
    const onward = await backOnLoopback(providers.consent(consent.href));
    const done = await root.accounts.handlers.loopbackConnectDone(get(onward, session));
    await finish(done.headers.get('location') ?? '');
    const [account] = await root.store.accounts.listOwnedBy([{ kind: 'user', id: me.id }]);
    await root.accounts.service.revoke({ user: me, groups: [] }, account?.id ?? '');
    const revocation = providers.calls.find((c) => c.url === GOOGLE_REVOKE);
    expect(revocation?.form.get('token')).toBe('refresh-1');
  });

  it('takes nothing from a flow replayed, or polled by another person', async () => {
    const consent = await start('calco');
    const redirect = providers.consent(consent.href);
    await backOnLoopback(redirect);
    // The provider's redirect replayed: the outcome stays the first one.
    const again = await backOnLoopback(redirect);
    expect(again).toBe(`${ORIGIN}/connections/loopback/done`);

    const other = await root.store.users.upsertFromIdp({
      issuer: 'https://accounts.google.com',
      subject: 'g-2',
      email: 'other@example.com',
    });
    const otherSession = `vbn_session=${
      (
        await root.auth.sessions.create({
          kind: 'user',
          userId: other.id,
          login: { email: other.email, groups: [] },
        })
      ).id
    }`;
    const stranger = await root.accounts.handlers.loopbackConnectStatus(
      form('/connections/loopback/status', otherSession, {}),
    );
    expect(await stranger.json()).toEqual({ status: 'none' });
  });
});

describe('a local instance without the installed client of a provider', () => {
  it('lists its plugins as not configured', async () => {
    const { root } = await rootWith(new FakeProviders(), []);
    try {
      expect((await root.accounts.service.service('calco'))?.unavailable).not.toBeNull();
    } finally {
      await root.close();
    }
  });
});
