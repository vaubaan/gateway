/**
 * The Administration surface refuses a non-operator in every page and route,
 * not only in its layout: the App Router can render a page segment without
 * its layout, so the layout guard is navigation chrome, never the boundary.
 *
 * No browser here: `requireOperator()` and each page are called as the plain
 * async functions they are, over the real composition root (`:memory:`
 * store); only `next/headers` is replaced, to carry the request cookie.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requireOperator } from '@/lib/auth/session';
import { SESSION_COOKIE } from '@/server/auth';
import { getRoot, resetRoot, type GatewayRoot } from '@/server/compose';
import { memoryStoreDeps } from '@/server/compose/testing';
import { loadInstanceConfig } from '@/server/config';
import { validEnv } from '@/server/config/testing';

import { appDir, outcomeOf, renderPage, surfaceFiles } from './guard-harness';

const request = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => request.headers }));

const PUBLIC_URL = 'https://gateway.example.com';
const ADMIN_GROUP = 'gateway-admins';
const ISSUER = 'https://idp.example.com/';
const CLIENT_ID = 'admin-guard-client-id';

const GUARDED_DIR = appDir('admin/(guarded)');
const PAGES = surfaceFiles(GUARDED_DIR, 'page.tsx');
const ROUTES = surfaceFiles(GUARDED_DIR, 'route.ts');

describe('the Administration surface authorizes in every page and route', () => {
  let root: GatewayRoot;

  beforeEach(async () => {
    request.headers = new Headers();
    root = await getRoot({
      loadConfig: () =>
        loadInstanceConfig({
          env: validEnv({ VAUBAAN_PUBLIC_URL: PUBLIC_URL, VAUBAAN_ADMIN_GROUP: ADMIN_GROUP }),
        }),
      logWrite: () => undefined,
      ...memoryStoreDeps,
    });
  });
  afterEach(async () => {
    await resetRoot();
  });

  function present(setCookie: string): void {
    request.headers = new Headers({ cookie: setCookie.split(';')[0] ?? '' });
  }

  async function signInUser(subject: string, groups: readonly string[]): Promise<void> {
    const email = `${subject}@example.com`;
    const user = await root.store.users.upsertFromIdp({ subject, email });
    await root.store.groups.syncIdpMemberships(user.id, groups);
    const session = await root.auth.sessions.create({
      kind: 'user',
      userId: user.id,
      login: { email, groups },
    });
    present(session.setCookie);
  }

  async function signInBootstrap(): Promise<void> {
    present((await root.auth.sessions.create({ kind: 'bootstrap' })).setCookie);
  }

  async function configureIdp(): Promise<void> {
    await root.auth.idp.save({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: 'admin-guard-client-secret',
      claims: { sub: 'sub', email: 'email', groups: 'groups' },
      allowedEmailDomains: [],
    });
  }

  describe('requireOperator()', () => {
    it('sends a visitor with no session to the bootstrap page while the token is the only way in', async () => {
      expect(await outcomeOf(requireOperator)).toEqual({
        kind: 'redirect',
        to: '/admin/bootstrap',
      });
    });

    it('sends a visitor with no session to the sign-in once an identity provider exists', async () => {
      await configureIdp();
      expect(await outcomeOf(requireOperator)).toEqual({ kind: 'redirect', to: '/login' });
    });

    it('treats a cookie that names no session as no session', async () => {
      request.headers = new Headers({ cookie: `${SESSION_COOKIE}=${'A'.repeat(43)}` });
      expect(await outcomeOf(requireOperator)).toMatchObject({ kind: 'redirect' });
    });

    it('answers "not found" to a signed-in user who does not match the admin rule', async () => {
      await signInUser('dev', ['developers']);
      expect(await outcomeOf(requireOperator)).toEqual({ kind: 'not-found' });
    });

    it('returns the root and the principal to an operator', async () => {
      await signInUser('ops', [ADMIN_GROUP]);
      const outcome = await outcomeOf(requireOperator);
      expect(outcome).toMatchObject({
        kind: 'returned',
        value: { root, principal: { kind: 'user', isOperator: true } },
      });
    });

    it('lets the bootstrap operator in while the token is active, and nobody once it is revoked', async () => {
      await signInBootstrap();
      expect(await outcomeOf(requireOperator)).toMatchObject({
        kind: 'returned',
        value: { principal: { kind: 'bootstrap' } },
      });
      await root.auth.bootstrap.revoke();
      expect(await outcomeOf(requireOperator)).toEqual({ kind: 'redirect', to: '/login' });
    });
  });

  it('finds the pages and the routes of the surface', () => {
    expect(PAGES.map((p) => p.name).sort()).toEqual(
      [
        'connections/page.tsx',
        'groups/page.tsx',
        'identity-provider/page.tsx',
        'oauth-clients/page.tsx',
        'page.tsx',
        'provider-apps/page.tsx',
        'telemetry/page.tsx',
        'users/page.tsx',
      ].sort(),
    );
    expect(ROUTES.length).toBeGreaterThan(0);
  });

  describe.each(PAGES)('page $name', ({ path }) => {
    it('calls requireOperator() and never reads the bare decision', () => {
      const source = readFileSync(path, 'utf8');
      expect(source).toMatch(/await requireOperator\(\)/);
      expect(source).not.toMatch(/adminDecision|currentPrincipal/);
      // The guard comes before anything is read from the root.
      const firstRootUse = source.search(/\broot\.[a-zA-Z]/);
      expect(firstRootUse).toBeGreaterThan(source.indexOf('await requireOperator()'));
    });

    it('renders nothing for a visitor with no session', async () => {
      await configureIdp();
      expect(await renderPage(path)).toEqual({ kind: 'redirect', to: '/login' });
    });

    it('renders nothing for a signed-in user who is not an operator', async () => {
      await configureIdp();
      await signInUser('dev', ['developers']);
      expect(await renderPage(path)).toEqual({ kind: 'not-found' });
    });

    it('renders nothing for a bootstrap session whose token was revoked', async () => {
      await configureIdp();
      await signInBootstrap();
      await root.auth.bootstrap.revoke();
      expect(await renderPage(path)).toEqual({ kind: 'redirect', to: '/login' });
    });

    it('renders for an operator', async () => {
      await configureIdp();
      await signInUser('ops', [ADMIN_GROUP]);
      const outcome = await renderPage(path);
      expect(outcome.kind).toBe('returned');
    });
  });

  describe.each(ROUTES)('route $name', ({ path }) => {
    type RouteHandler = (
      request: Request,
      context: { params: Promise<Record<string, string>> },
    ) => Promise<Response>;

    async function post(): Promise<Response> {
      const route = (await import(/* @vite-ignore */ path)) as { POST: RouteHandler };
      const headers = new Headers(request.headers);
      headers.set('origin', PUBLIC_URL);
      headers.set('content-type', 'application/x-www-form-urlencoded');
      return route.POST(
        new Request(`${PUBLIC_URL}/admin/provider-apps/acme`, {
          method: 'POST',
          headers,
          body: '',
        }),
        { params: Promise.resolve({ provider: 'acme', id: 'no-such-id', userId: 'no-such-user' }) },
      );
    }

    it('answers 401 with no session and 403 to a user who is not an operator', async () => {
      expect((await post()).status).toBe(401);
      await signInUser('dev', ['developers']);
      expect((await post()).status).toBe(403);
    });

    it('answers 401 to a bootstrap session whose token was revoked', async () => {
      await signInBootstrap();
      await root.auth.bootstrap.revoke();
      expect((await post()).status).toBe(401);
    });
  });
});
