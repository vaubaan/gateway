/**
 * Every page and route under `(app)` authenticates itself. The `(app)` layout
 * redirects a visitor with no session, but the App Router can render a page
 * segment without its layout, so the layout is never the boundary.
 *
 * The pages and routes are discovered on disk: a new one that forgets its
 * guard fails here. Pages are called as the plain async functions they are,
 * over the real composition root (`:memory:` store); only `next/headers` is
 * replaced, to carry the request cookie.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NeedsUser } from '@/components/auth/NeedsUser';
import { currentUser, requirePrincipal } from '@/lib/auth/session';
import { currentActor } from '@/lib/accounts/session';
import { getRoot, resetRoot, type GatewayRoot } from '@/server/compose';
import { memoryStoreDeps } from '../../support/compose/testing';
import { loadInstanceConfig } from '@/server/config';
import { validEnv } from '../../support/config/testing';

import { appDir, outcomeOf, renderPage, surfaceFiles, type Outcome } from './guard-harness';

const request = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => request.headers }));

const PUBLIC_URL = 'https://gateway.example.com';
const APP_DIR = appDir('(app)');
const PAGES = surfaceFiles(APP_DIR, 'page.tsx');
const ROUTES = surfaceFiles(APP_DIR, 'route.ts');

/** The session helpers a page of the surface may use as its guard. */
const PAGE_GUARD = /await (currentUser|currentActor|requirePrincipal)\(\)/;
/** The pages that render for the bootstrap operator too: they show nothing that belongs to a user. */
const PAGES_FOR_ANY_SESSION: readonly string[] = [
  // The overview, the record and the timeline: each reads what the session may read,
  // nothing for the token.
  'activity/page.tsx',
  'activity/record/page.tsx',
  'activity/timeline/page.tsx',
  // The reference documents the instance: it shows no account and no mission.
  'reference/page.tsx',
  'reference/[id]/page.tsx',
  // Settings leads the bootstrap operator to Administration; the gallery holds invented specimens.
  'settings/page.tsx',
  'design/page.tsx',
];

/**
 * The pages that lead a session elsewhere and render nothing themselves, with
 * where they lead. None today: `/activity` is the Overview, and leads to the
 * Record only an address that carries the Record's filters.
 */
const REDIRECTING_PAGES: Readonly<Record<string, string>> = {};

/**
 * The handlers a route of the surface may delegate to. Each was read in
 * `src/server/accounts/handlers.ts` and authenticates before anything
 * else: `connect`, `discover`, `revoke` and `updateResource` through
 * `guardMutation` (origin, then session, then "a user"), `callback` through
 * `guardSession` (a top-level GET from the service carries no `Origin`).
 * `oauth.handlers.revokeDelegation` (`src/server/oauth-as/handlers.ts`) goes
 * through `guardMutation` too. The behaviour is asserted below, route by route.
 */
const AUTHENTICATING_HANDLERS: readonly string[] = [
  // `POST /accounts/new/<service>/install`: `guardMutation` with the role `user` first.
  'pluginInstall.handlers.installForConnection',
  'accounts.handlers.connect',
  'accounts.handlers.callback',
  // `GET /reference/<id>/connect/<file>`: `guardSession` with the role `user` first.
  'accounts.handlers.connectFile',
  'accounts.handlers.discover',
  'accounts.handlers.revoke',
  'accounts.handlers.updateResource',
  'accounts.handlers.setDefaultEnv',
  // `transfer` (accounts) and the share acts (`src/server/shares/handlers.ts`): `guardMutation`
  // first, like the others.
  'accounts.handlers.transfer',
  'shares.handlers.share',
  'shares.handlers.revoke',
  'oauth.handlers.revokeDelegation',
  // Settings → Security (`src/server/auth/local-handlers.ts`): `guardMutation` with the role
  // `user`, then the sign-in account behind the session (ADR local-accounts-sign-in-provider).
  'auth.handlers.beginSecondFactor',
  'auth.handlers.confirmSecondFactor',
  'auth.handlers.removeSecondFactor',
  'auth.handlers.changePassword',
];
const DELEGATION = /\(await getRoot\(\)\)\.([a-zA-Z]+\.handlers\.[a-zA-Z]+)\(request\b/g;

/** Values for every dynamic segment of the surface; none names an existing object. */
const PARAMS = {
  id: 'no-such-id',
  service: 'no-such-service',
  resourceId: 'no-such-resource',
  shareId: 'no-such-share',
  file: 'no-such-file.png',
};

function isNeedsUser(outcome: Outcome): boolean {
  if (outcome.kind !== 'returned') return false;
  const { value } = outcome;
  return typeof value === 'object' && value !== null && 'type' in value && value.type === NeedsUser;
}

describe('the human surface authenticates in every page and route', () => {
  let root: GatewayRoot;

  beforeEach(async () => {
    request.headers = new Headers();
    root = await getRoot({
      loadConfig: () => loadInstanceConfig({ env: validEnv({ VAUBAAN_PUBLIC_URL: PUBLIC_URL }) }),
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

  async function signInUser(subject: string): Promise<void> {
    const email = `${subject}@example.com`;
    const user = await root.store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject,
      email,
    });
    const session = await root.auth.sessions.create({
      kind: 'user',
      userId: user.id,
      login: { email, groups: [] },
    });
    present(session.setCookie);
  }

  async function signInBootstrap(): Promise<void> {
    present((await root.auth.sessions.create({ kind: 'bootstrap' })).setCookie);
  }

  describe('the session helpers', () => {
    it('send a visitor with no session to the sign-in', async () => {
      for (const helper of [requirePrincipal, currentUser, currentActor]) {
        expect(await outcomeOf(helper)).toEqual({ kind: 'redirect', to: '/login' });
      }
    });

    it('answer null to the bootstrap operator where a user is needed, and only there', async () => {
      await signInBootstrap();
      expect(await outcomeOf(currentUser)).toEqual({ kind: 'returned', value: null });
      expect(await outcomeOf(currentActor)).toEqual({ kind: 'returned', value: null });
      expect(await outcomeOf(requirePrincipal)).toMatchObject({
        kind: 'returned',
        value: { principal: { kind: 'bootstrap' } },
      });
    });

    it('treat a bootstrap session whose token was revoked as no session', async () => {
      await signInBootstrap();
      await root.auth.bootstrap.revoke();
      expect(await outcomeOf(currentUser)).toEqual({ kind: 'redirect', to: '/login' });
    });

    // The first `currentActor()` loads the account service and its plugins cold: about 5 s
    // already on main, so the default 5 s timeout made this test flaky in CI.
    it('return the user, with the actor of the account service', { timeout: 30_000 }, async () => {
      await signInUser('ada');
      expect(await outcomeOf(currentUser)).toMatchObject({
        kind: 'returned',
        value: { root, principal: { kind: 'user' }, user: { email: 'ada@example.com' } },
      });
      expect(await outcomeOf(currentActor)).toMatchObject({
        kind: 'returned',
        value: { root, actor: { user: { email: 'ada@example.com' }, groups: [] } },
      });
    });
  });

  it('finds the pages and the routes of the surface', () => {
    expect(PAGES.length).toBeGreaterThanOrEqual(10);
    expect(ROUTES.length).toBeGreaterThanOrEqual(5);
    for (const name of PAGES_FOR_ANY_SESSION) {
      expect(PAGES.map((page) => page.name)).toContain(name);
    }
  });

  describe.each(PAGES)('page $name', ({ path, name }) => {
    const forAnySession = PAGES_FOR_ANY_SESSION.includes(name);
    const leadsTo = REDIRECTING_PAGES[name];

    it('calls a session helper before it reads anything from the root', () => {
      const source = readFileSync(path, 'utf8');
      const guard = source.search(PAGE_GUARD);
      expect(guard).toBeGreaterThan(-1);
      // The bare principal would let a page forget the "no session" case.
      expect(source).not.toMatch(/currentPrincipal|getRoot/);
      const firstRootUse = source.search(/\broot\.[a-zA-Z]/);
      if (firstRootUse !== -1) expect(firstRootUse).toBeGreaterThan(guard);
    });

    it('renders nothing for a visitor with no session', async () => {
      expect(await renderPage(path, PARAMS)).toEqual({ kind: 'redirect', to: '/login' });
    });

    it('renders nothing for a bootstrap session whose token was revoked', async () => {
      await signInBootstrap();
      await root.auth.bootstrap.revoke();
      expect(await renderPage(path, PARAMS)).toEqual({ kind: 'redirect', to: '/login' });
    });

    it(
      leadsTo
        ? 'leads any session to the page it stands for'
        : forAnySession
          ? 'renders for the bootstrap operator'
          : 'renders only <NeedsUser /> for the bootstrap operator',
      async () => {
        await signInBootstrap();
        const outcome = await renderPage(path, PARAMS);
        if (leadsTo) {
          expect(outcome.kind).toBe('redirect');
          expect(outcome.kind === 'redirect' && outcome.to.split('?')[0]).toBe(leadsTo);
          await signInUser('ada');
          expect(await renderPage(path, PARAMS)).toMatchObject({ kind: 'redirect' });
          return;
        }
        // A page for any session that is addressed by id answers "not found" for an unknown one.
        expect(forAnySession ? ['returned', 'not-found'] : ['returned']).toContain(outcome.kind);
        expect(isNeedsUser(outcome)).toBe(!forAnySession);
      },
    );

    it('answers a signed-in user with the page, or "not found" for an object that does not exist', async () => {
      await signInUser('ada');
      const outcome = await renderPage(path, PARAMS);
      if (leadsTo) {
        expect(outcome).toMatchObject({ kind: 'redirect' });
        return;
      }
      expect(['returned', 'not-found']).toContain(outcome.kind);
      expect(isNeedsUser(outcome)).toBe(false);
    });
  });

  describe.each(ROUTES)('route $name', ({ path }) => {
    type RouteHandler = (
      request: Request,
      context: { params: Promise<Record<string, string>> },
    ) => Promise<Response>;
    type RouteModule = Partial<Record<'GET' | 'POST', RouteHandler>>;

    /** Calls every method the route exports, same-origin, with the current cookie. */
    async function call(): Promise<Response[]> {
      const route = (await import(/* @vite-ignore */ path)) as RouteModule;
      const responses: Response[] = [];
      for (const method of ['GET', 'POST'] as const) {
        const handler = route[method];
        if (!handler) continue;
        const headers = new Headers(request.headers);
        headers.set('origin', PUBLIC_URL);
        const init: RequestInit = { method, headers };
        if (method === 'POST') {
          headers.set('content-type', 'application/x-www-form-urlencoded');
          init.body = '';
        }
        responses.push(
          await handler(new Request(`${PUBLIC_URL}/accounts/x`, init), {
            params: Promise.resolve(PARAMS),
          }),
        );
      }
      return responses;
    }

    /** 401, 403, or a redirect to the sign-in: never the action. */
    function refused(response: Response): boolean {
      if (response.status === 401 || response.status === 403) return true;
      return response.status === 303 && response.headers.get('location') === '/login';
    }

    it('only delegates to a handler known to authenticate', () => {
      const source = readFileSync(path, 'utf8');
      const delegations = [...source.matchAll(DELEGATION)].map((match) => match[1]);
      expect(delegations.length).toBeGreaterThan(0);
      for (const delegation of delegations) expect(AUTHENTICATING_HANDLERS).toContain(delegation);
      // An adapter and nothing else: no session or store access of its own.
      expect(source).not.toMatch(/\.store\b|cookies\(|headers\(/);
    });

    it('refuses a caller with no session', async () => {
      const responses = await call();
      expect(responses.length).toBeGreaterThan(0);
      for (const response of responses) expect(refused(response)).toBe(true);
    });

    it('refuses the bootstrap operator: accounts belong to users', async () => {
      await signInBootstrap();
      for (const response of await call()) expect(refused(response)).toBe(true);
    });

    it('lets a signed-in user through to the handler', async () => {
      await signInUser('ada');
      for (const response of await call()) expect(refused(response)).toBe(false);
    });
  });
});
