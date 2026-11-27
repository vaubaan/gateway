/**
 * Sign-in with Google, Microsoft or GitHub on a local instance, through Vaubaan's
 * installed-app clients, back on the loopback (ADR
 * local-instance-carries-installed-oauth-clients; intent "Sign in with Google, Microsoft or
 * GitHub on my computer"). The providers are faked behind the sign-in `fetch`: their token
 * endpoints and GitHub's API. The "browser" steps are requests: the provider's redirect to
 * `http://127.0.0.1:3000/oauth/loopback`, then the public URL.
 */
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { loadInstanceConfig } from '../../../src/server/config';
import {
  installedClients,
  type InstalledClient,
} from '../../../src/server/config/installed-clients';
import { MICROSOFT_CONSUMERS_TENANT } from '../../../src/server/auth/installed-sign-in';
import { openMemoryStore } from '../../../src/server/store';
import { ManualClock } from '../../../src/server/store/clock';
import { REPOSITORY_PLUGINS } from '../../support/plugins/repository';

const ORIGIN = 'http://localhost:3000';
const LOOPBACK = 'http://127.0.0.1:3000/oauth/loopback';
const CLIENTS: InstalledClient[] = [
  { provider: 'google', clientId: 'google-client', clientSecret: 'google-secret' },
  { provider: 'microsoft', clientId: 'microsoft-client', clientSecret: null },
  { provider: 'github', clientId: 'github-client', clientSecret: 'github-secret' },
];
const WORK_TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';

interface Person {
  readonly sub: string;
  readonly email: string;
  readonly claims?: Record<string, unknown>;
}

function jwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part(payload)}.signature`;
}

/** The providers' token endpoints and GitHub's API, for the person who consents next. */
class FakeProviders {
  next: Person = { sub: 'g-1', email: 'me@example.com' };
  tenant = MICROSOFT_CONSUMERS_TENANT;
  readonly requests: string[] = [];
  private readonly codes = new Map<string, { nonce: string; provider: string; person: Person }>();

  /** The provider's consent: the redirect it sends the browser to. */
  consent(authorizeUrl: string): string {
    const url = new URL(authorizeUrl);
    const p = url.searchParams;
    const provider = url.hostname.includes('google')
      ? 'google'
      : url.hostname.includes('microsoft')
        ? 'microsoft'
        : 'github';
    const code = randomBytes(12).toString('hex');
    this.codes.set(code, { nonce: p.get('nonce') ?? '', provider, person: this.next });
    const back = new URL(p.get('redirect_uri') ?? '');
    back.searchParams.set('code', code);
    back.searchParams.set('state', p.get('state') ?? '');
    return back.href;
  }

  fetch = async (url: string, init?: { body?: unknown }): Promise<Response> => {
    this.requests.push(url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url === 'https://api.github.com/user') {
      return json({ id: 4242, login: 'me', name: 'Me' });
    }
    if (url === 'https://api.github.com/user/emails') {
      return json([{ email: this.next.email, primary: true, verified: true }]);
    }
    const form = new URLSearchParams(String(init?.body ?? ''));
    const issued = this.codes.get(form.get('code') ?? '');
    if (!issued) return json({ error: 'invalid_grant' }, 400);
    this.codes.delete(form.get('code') ?? '');
    if (form.get('redirect_uri') !== LOOPBACK) return json({ error: 'redirect_uri_mismatch' }, 400);
    if (url === 'https://github.com/login/oauth/access_token') {
      return json({ access_token: 'gh-token' });
    }
    const now = Math.floor(Date.now() / 1000);
    const base = {
      sub: issued.person.sub,
      nonce: issued.nonce,
      exp: now + 600,
      email: issued.person.email,
      ...issued.person.claims,
    };
    if (url === 'https://oauth2.googleapis.com/token') {
      return json({
        id_token: jwt({
          iss: 'https://accounts.google.com',
          aud: 'google-client',
          email_verified: true,
          ...base,
        }),
      });
    }
    if (url === 'https://login.microsoftonline.com/common/oauth2/v2.0/token') {
      return json({
        id_token: jwt({
          iss: `https://login.microsoftonline.com/${this.tenant}/v2.0`,
          aud: 'microsoft-client',
          tid: this.tenant,
          ...base,
        }),
      });
    }
    return new Response('not found', { status: 404 });
  };
}

function cookieOf(res: Response, name: string): string | null {
  const header = res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`));
  return header?.split(';')[0] ?? null;
}

function form(path: string, cookies: readonly (string | null)[], fields: Record<string, string>) {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: ORIGIN,
      cookie: cookies.filter(Boolean).join('; '),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

function get(url: string, cookies: readonly (string | null)[] = []): Request {
  return new Request(url, { headers: { cookie: cookies.filter(Boolean).join('; ') } });
}

async function rootWith(
  providers: FakeProviders,
  clients: readonly InstalledClient[] = CLIENTS,
  local = true,
): Promise<GatewayRoot> {
  const clock = new ManualClock(new Date().toISOString());
  const env: Record<string, string> = {
    VAUBAAN_MASTER_KEY: randomBytes(32).toString('base64'),
    VAUBAAN_UPDATES_CHECK: 'false',
    VAUBAAN_STORE_PATH: ':memory:',
  };
  if (local) env.VAUBAAN_LOCAL = 'true';
  else {
    env.VAUBAAN_PUBLIC_URL = 'https://gateway.example.com';
    env.VAUBAAN_BOOTSTRAP_TOKEN = randomBytes(24).toString('hex');
  }
  return buildRoot({
    loadConfig: () => {
      const loaded = loadInstanceConfig({ env });
      return {
        ...loaded,
        config: {
          ...loaded.config,
          bootstrapToken: local ? 'b'.repeat(43) : loaded.config.bootstrapToken,
          installedClients: local ? clients : [],
        },
      };
    },
    logWrite: () => undefined,
    bundled: REPOSITORY_PLUGINS,
    clock,
    oidc: { fetch: providers.fetch },
    openStore: async ({ encryptor, catalog }) => openMemoryStore({ encryptor, catalog, clock }),
  });
}

/** Starts a flow from a window: its consent address and the cookie that binds it. */
async function start(
  root: GatewayRoot,
  signInProvider: string,
  purpose: 'sign-in' | 'setup',
  session: string | null = null,
): Promise<{ authorizeUrl: string; binder: string }> {
  const res = await root.auth.handlers.loopbackStart(
    form('/auth/loopback/start', [session], { signInProvider, purpose, return_to: '/' }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { authorizeUrl: string };
  const binder = cookieOf(res, 'vbn_loopback');
  expect(binder).not.toBeNull();
  return { authorizeUrl: body.authorizeUrl, binder: binder ?? '' };
}

/** The provider sends the browser to the loopback, which sends it on to the public URL. */
async function backOnLoopback(root: GatewayRoot, redirect: string): Promise<string> {
  const res = await root.auth.handlers.loopbackCallback(get(redirect));
  expect(res.status).toBe(303);
  return res.headers.get('location') ?? '';
}

async function setUpWithKey(root: GatewayRoot): Promise<string> {
  await root.masterKey.service.recordGenerated();
  await root.masterKey.service.confirmHandover();
  return `vbn_session=${(await root.auth.sessions.create({ kind: 'bootstrap' })).id}`;
}

describe('signing in with Google, Microsoft or GitHub on my computer', () => {
  let providers: FakeProviders;
  let root: GatewayRoot;

  beforeEach(async () => {
    providers = new FakeProviders();
    root = await rootWith(providers);
  });
  afterEach(async () => {
    await root.close();
  });

  it('offers Google, Microsoft and GitHub beside email and password, and the setup creates the first administrator with Google', async () => {
    const offered = (await root.auth.signInProviders.views()).filter(
      (p) => p.source === 'installed',
    );
    expect(offered.map((p) => [p.id, p.enabled])).toEqual([
      ['google', true],
      ['microsoft', true],
      ['github', true],
    ]);

    const bootstrap = await setUpWithKey(root);
    const { authorizeUrl, binder } = await start(root, 'google', 'setup', bootstrap);
    const onward = await backOnLoopback(root, providers.consent(authorizeUrl));
    expect(onward).toMatch(/^http:\/\/localhost:3000\/auth\/loopback\/done\?flow=/);

    // The same browser: it holds the binder and the setup's session.
    const done = await root.auth.handlers.loopbackDone(get(onward, [binder, bootstrap]));
    expect(done.headers.get('location')).toBe('/');
    expect((await root.auth.bootstrap.state()).status).toBe('revoked');
    const principal = await root.auth.authenticator.authenticate(
      new Headers({ cookie: cookieOf(done, 'vbn_session') ?? '' }),
    );
    expect(principal).toMatchObject({ kind: 'user', isOperator: true });
    if (principal?.kind === 'user') {
      expect(principal.user).toMatchObject({
        issuer: 'https://accounts.google.com',
        subject: 'g-1',
        email: 'me@example.com',
      });
    }
  });

  it('in the desktop app, the browser that consented is told to go back, and the app’s window takes the session', async () => {
    const bootstrap = await setUpWithKey(root);
    const { authorizeUrl, binder } = await start(root, 'microsoft', 'setup', bootstrap);

    // The window polls while the person is in the default browser.
    const waiting = await root.auth.handlers.loopbackStatus(
      form('/auth/loopback/status', [binder, bootstrap], {}),
    );
    expect(await waiting.json()).toEqual({ status: 'pending' });

    // The default browser comes back without the window's cookies.
    const onward = await backOnLoopback(root, providers.consent(authorizeUrl));
    const elsewhere = await root.auth.handlers.loopbackDone(get(onward));
    expect(elsewhere.headers.get('location')).toBe('/login/elsewhere?outcome=done');
    expect(elsewhere.headers.getSetCookie()).toEqual([]);

    const taken = await root.auth.handlers.loopbackStatus(
      form('/auth/loopback/status', [binder, bootstrap], {}),
    );
    expect(await taken.json()).toEqual({ status: 'done', location: '/' });
    const principal = await root.auth.authenticator.authenticate(
      new Headers({ cookie: cookieOf(taken, 'vbn_session') ?? '' }),
    );
    expect(principal).toMatchObject({ kind: 'user', isOperator: true });
  });

  it('asks only the identity, never a calendar or a mailbox', async () => {
    const scopes: Record<string, string | null> = {};
    for (const id of ['google', 'microsoft', 'github']) {
      const url = new URL((await start(root, id, 'sign-in')).authorizeUrl);
      expect(url.searchParams.get('redirect_uri')).toBe(LOOPBACK);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      scopes[id] = url.searchParams.get('scope');
    }
    expect(scopes).toEqual({
      google: 'openid email',
      microsoft: 'openid email profile',
      github: 'read:user user:email',
    });
  });

  it('signs nobody in with a flow replayed, or taken by a window that did not start it', async () => {
    const bootstrap = await setUpWithKey(root);
    const first = await start(root, 'google', 'setup', bootstrap);
    const redirect = providers.consent(first.authorizeUrl);
    await backOnLoopback(root, redirect);

    // The provider's redirect replayed: nothing waits under that state any more.
    expect(await backOnLoopback(root, redirect)).toBe(`${ORIGIN}/auth/loopback/done`);

    // Another window, with a flow of its own, takes nothing of this one.
    const other = await start(root, 'google', 'setup', bootstrap);
    const stranger = await root.auth.handlers.loopbackStatus(
      form('/auth/loopback/status', [other.binder, bootstrap], {}),
    );
    expect(await stranger.json()).toEqual({ status: 'pending' });
    const forged = await root.auth.handlers.loopbackStatus(
      form(
        '/auth/loopback/status',
        [`vbn_loopback=${'x'.repeat(43)}${first.binder.slice(56)}`],
        {},
      ),
    );
    expect(await forged.json()).toEqual({ status: 'none' });
    expect((await root.auth.bootstrap.state()).status).toBe('active');

    // Taken once by its window; a second take finds nothing.
    const taken = await root.auth.handlers.loopbackStatus(
      form('/auth/loopback/status', [first.binder, bootstrap], {}),
    );
    expect((await taken.json()) as unknown).toMatchObject({ status: 'done' });
    const again = await root.auth.handlers.loopbackStatus(
      form('/auth/loopback/status', [first.binder], {}),
    );
    expect(await again.json()).toEqual({ status: 'none' });
  });

  it('refuses a setup flow when the window’s session is no longer the setup’s that started it', async () => {
    const bootstrap = await setUpWithKey(root);
    const { authorizeUrl, binder } = await start(root, 'google', 'setup', bootstrap);
    await backOnLoopback(root, providers.consent(authorizeUrl));
    const otherSession = `vbn_session=${(await root.auth.sessions.create({ kind: 'bootstrap' })).id}`;
    const res = await root.auth.handlers.loopbackStatus(
      form('/auth/loopback/status', [binder, otherSession], {}),
    );
    expect(await res.json()).toEqual({ status: 'done', location: '/' });
    expect(cookieOf(res, 'vbn_session')).toBeNull();
    expect((await root.auth.bootstrap.state()).status).toBe('active');
  });

  it('signs in an invited person with GitHub, and refuses a Microsoft work address it cannot call verified', async () => {
    const bootstrap = await setUpWithKey(root);
    const setup = await start(root, 'google', 'setup', bootstrap);
    await backOnLoopback(root, providers.consent(setup.authorizeUrl));
    await root.auth.handlers.loopbackStatus(
      form('/auth/loopback/status', [setup.binder, bootstrap], {}),
    );
    await root.users.invitations.invite('bootstrap', 'friend@example.com');

    providers.next = { sub: 'n/a', email: 'friend@example.com' };
    const github = await start(root, 'github', 'sign-in');
    await backOnLoopback(root, providers.consent(github.authorizeUrl));
    const signedIn = await root.auth.handlers.loopbackStatus(
      form('/auth/loopback/status', [github.binder], {}),
    );
    const body = (await signedIn.json()) as { status: string; location: string };
    expect(body).toEqual({ status: 'done', location: '/' });
    const user = await root.auth.authenticator.authenticate(
      new Headers({ cookie: cookieOf(signedIn, 'vbn_session') ?? '' }),
    );
    expect(user).toMatchObject({
      kind: 'user',
      user: { issuer: 'https://github.com', subject: '4242' },
    });

    providers.tenant = WORK_TENANT;
    providers.next = { sub: 'm-work', email: 'friend@example.com' };
    const microsoft = await start(root, 'microsoft', 'sign-in');
    await backOnLoopback(root, providers.consent(microsoft.authorizeUrl));
    const refused = await root.auth.handlers.loopbackStatus(
      form('/auth/loopback/status', [microsoft.binder], {}),
    );
    expect(await refused.json()).toEqual({
      status: 'done',
      location: '/login?error=email-not-verified',
    });
    expect(cookieOf(refused, 'vbn_session')).toBeNull();
  });
});

describe('a build without a provider’s client', () => {
  it('offers no button for that provider', async () => {
    expect(
      installedClients(
        { google: 'g', microsoft: 'm', github: 'h' },
        { google: '', microsoft: '', github: 's' },
      ).map((c) => c.provider),
    ).toEqual(['microsoft', 'github']);
    const providers = new FakeProviders();
    const root = await rootWith(providers, CLIENTS.slice(1));
    try {
      const ids = (await root.auth.signInProviders.views()).map((p) => p.id);
      expect(ids).toEqual(['microsoft', 'github']);
    } finally {
      await root.close();
    }
  });

  it('carries none outside local mode', async () => {
    const root = await rootWith(new FakeProviders(), CLIENTS, false);
    try {
      expect(await root.auth.signInProviders.views()).toEqual([]);
    } finally {
      await root.close();
    }
  });
});
