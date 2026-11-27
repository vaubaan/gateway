/**
 * The HTTP side of the installed-app clients' flows (`loopback.ts`; ADR
 * local-instance-carries-installed-oauth-clients):
 *
 *   POST /auth/loopback/start     same origin; `{ signInProvider, purpose, return_to }` →
 *                                 `{ authorizeUrl }` and the binding cookie. The page then
 *                                 sends its window there: a browser follows, the desktop
 *                                 app opens it in the default browser.
 *   GET  /oauth/loopback          the providers' redirect, on `127.0.0.1` (no cookie of
 *                                 the public URL): finishes the exchange, then sends the
 *                                 browser to `/auth/loopback/done?flow=<state>`.
 *   GET  /auth/loopback/done      the browser that holds the binder completes the flow
 *                                 (a session, or the setup); any other is shown a page that
 *                                 says to go back to Vaubaan (`/login/elsewhere`).
 *   POST /auth/loopback/status    same origin; the starting window polls it: `pending`,
 *                                 `none`, or `done` with where to go, the cookies set.
 *
 * Only an installed sign-in provider starts here; the others keep `/auth/login/<id>`.
 */
import type { RateLimiter } from '../compose/ports';
import type { SignInProvider } from '../config/sign-in';
import { notAFormResponse, readForm, stringField } from '../http/form';
import type { Logger } from '../logging';
import { groupsOfSignInProvider, type AdministratorsService } from './administrators';
import type { Authenticator } from './authenticator';
import type { BootstrapService } from './bootstrap';
import type { IdentityClaims } from './claims';
import { LoginError } from './errors';
import { AUTH_LIMITS, LOGIN_PAGE, safeReturnTo } from './handlers';
import { installedProviderOf } from './installed-sign-in';
import type { FinishSignIn } from './local-handlers';
import type { FinishedLoopback, LoopbackPurpose, LoopbackService } from './loopback';
import { forbiddenOriginResponse, isSameOrigin } from './origin';
import type { SignInProvidersService } from './sign-in-providers';
import { createThrottle } from './throttle';

export const LOOPBACK_START_PATH = '/auth/loopback/start';
export const LOOPBACK_STATUS_PATH = '/auth/loopback/status';
export const LOOPBACK_DONE_PATH = '/auth/loopback/done';
/** The page a browser without the binder lands on: "go back to Vaubaan". */
export const SIGNED_IN_ELSEWHERE_PAGE = '/login/elsewhere';
/** Where a failed setup flow sends the window back. */
export const WELCOME_PAGE = '/welcome';

/**
 * Turns the setup's flow into the first administrator (`users/handlers.ts`), in the request
 * of the window that started it, whose session must still be `starterSessionId`.
 */
export type CompleteSetup = (
  request: Request,
  signInProvider: SignInProvider,
  identity: IdentityClaims,
  starterSessionId: string | null,
) => Promise<Response>;

export interface LoopbackHandlerDeps {
  readonly publicUrl: URL;
  readonly loopback: LoopbackService;
  readonly signInProviders: SignInProvidersService;
  readonly administrators: AdministratorsService;
  readonly authenticator: Authenticator;
  readonly bootstrap: Pick<BootstrapService, 'state'>;
  readonly finishSignIn: FinishSignIn;
  /** Set once the users' handlers exist (`AuthModule.completeSetupWith`). */
  readonly completeSetup: () => CompleteSetup | null;
  readonly rateLimiter: RateLimiter;
  readonly clientIp: (headers: Headers) => string;
  readonly logger: Logger;
}

export interface LoopbackHandlers {
  loopbackStart(request: Request): Promise<Response>;
  loopbackCallback(request: Request): Promise<Response>;
  loopbackDone(request: Request): Promise<Response>;
  loopbackStatus(request: Request): Promise<Response>;
}

const NO_STORE = { 'Cache-Control': 'no-store' };

function json(body: unknown, status = 200, cookies: readonly string[] = []): Response {
  const headers = new Headers({ 'Content-Type': 'application/json', ...NO_STORE });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

function seeOther(location: string, cookies: readonly string[] = []): Response {
  const headers = new Headers({ Location: location, ...NO_STORE });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
}

export function createLoopbackHandlers(deps: LoopbackHandlerDeps): LoopbackHandlers {
  const admitted = createThrottle(deps);

  async function installed(id: string): Promise<SignInProvider | null> {
    const effective = await deps.signInProviders.resolve(id);
    if (!effective || installedProviderOf(effective.signInProvider) === null) return null;
    return effective.signInProvider;
  }

  async function adminGroups(signInProvider: SignInProvider) {
    return groupsOfSignInProvider(await deps.administrators.current(), signInProvider.id);
  }

  /** What the outcome becomes, in the request of the window that started the flow. */
  async function complete(request: Request, record: FinishedLoopback): Promise<Response> {
    const failedAt = record.purpose === 'setup' ? WELCOME_PAGE : LOGIN_PAGE;
    if ('error' in record.outcome) return seeOther(`${failedAt}?error=${record.outcome.error}`);
    const signInProvider = await installed(record.signInProviderId);
    if (!signInProvider) return seeOther(`${failedAt}?error=sign-in-provider-unknown`);
    if (record.purpose === 'setup') {
      const completeSetup = deps.completeSetup();
      if (!completeSetup) return seeOther(`${WELCOME_PAGE}?error=idp-not-configured`);
      return completeSetup(
        request,
        signInProvider,
        record.outcome.identity,
        record.starterSessionId,
      );
    }
    try {
      return await deps.finishSignIn(
        request,
        signInProvider,
        record.outcome.identity,
        safeReturnTo(record.returnTo, deps.publicUrl),
      );
    } catch (err) {
      // Admission refused, a deactivated person, the ceiling of users: as `/auth/callback`.
      if (err instanceof LoginError) {
        deps.logger.warn('sign-in failed', { code: err.code, detail: err.message });
        return seeOther(`${LOGIN_PAGE}?error=${err.code}`);
      }
      deps.logger.error('sign-in failed unexpectedly', { err });
      return seeOther(`${LOGIN_PAGE}?error=idp-error`);
    }
  }

  return {
    async loopbackStart(request) {
      if (!isSameOrigin(request.headers, deps.publicUrl)) return forbiddenOriginResponse();
      if (
        !(await admitted(
          request,
          'login-start',
          AUTH_LIMITS.loginStartPerAddress,
          AUTH_LIMITS.loginStartPerInstance,
        ))
      ) {
        return json({ error: 'too-many-attempts' }, 429);
      }
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      const signInProvider = await installed(stringField(form, 'signInProvider'));
      if (!signInProvider) return json({ error: 'sign-in-provider-unknown' }, 404);
      const purpose: LoopbackPurpose =
        stringField(form, 'purpose') === 'setup' ? 'setup' : 'sign-in';
      let starterSessionId: string | null = null;
      if (purpose === 'setup') {
        // Only the holder of the setup link, while the setup is open.
        const principal = await deps.authenticator.authenticate(request.headers);
        if (principal?.kind !== 'bootstrap' || (await deps.bootstrap.state()).status !== 'active') {
          return json({ error: 'bootstrap-unavailable' }, 403);
        }
        starterSessionId = principal.sessionId;
      }
      try {
        const started = await deps.loopback.start({
          signInProvider,
          adminGroups: await adminGroups(signInProvider),
          purpose,
          returnTo: safeReturnTo(stringField(form, 'return_to') || null, deps.publicUrl, '/'),
          starterSessionId,
        });
        return json({ authorizeUrl: started.authorizeUrl.href }, 200, [started.setCookie]);
      } catch (err) {
        deps.logger.warn('sign-in failed to start', { err });
        return json({ error: 'idp-error' }, 502);
      }
    },

    async loopbackCallback(request) {
      const done = new URL(LOOPBACK_DONE_PATH, deps.publicUrl);
      if (
        !(await admitted(
          request,
          'callback',
          AUTH_LIMITS.callbackPerAddress,
          AUTH_LIMITS.callbackPerInstance,
        ))
      ) {
        return seeOther(`${LOGIN_PAGE}?error=too-many-attempts`);
      }
      const record = await deps.loopback.callback(new URL(request.url), installed, adminGroups);
      if (record) done.searchParams.set('flow', record.state);
      // On to the public URL, where the window that started the flow holds its cookie.
      return seeOther(done.href);
    },

    async loopbackDone(request) {
      const taken = await deps.loopback.take(request.headers);
      if (taken !== null && taken !== 'pending') {
        const response = await complete(request, taken);
        response.headers.append('Set-Cookie', deps.loopback.clearCookie());
        return response;
      }
      // Another browser (the desktop app's default one), or nothing to take: a page.
      const flow = new URL(request.url).searchParams.get('flow') ?? '';
      const page = new URL(SIGNED_IN_ELSEWHERE_PAGE, deps.publicUrl);
      const outcome = await deps.loopback.outcomeOf(flow);
      page.searchParams.set('outcome', outcome === null ? 'expired' : outcome);
      return seeOther(`${page.pathname}${page.search}`);
    },

    async loopbackStatus(request) {
      if (!isSameOrigin(request.headers, deps.publicUrl)) return forbiddenOriginResponse();
      const taken = await deps.loopback.take(request.headers);
      if (taken === 'pending') return json({ status: 'pending' });
      if (taken === null) return json({ status: 'none' });
      const response = await complete(request, taken);
      const cookies = [...response.headers.getSetCookie(), deps.loopback.clearCookie()];
      const location = response.headers.get('Location') ?? '/';
      return json({ status: 'done', location }, 200, cookies);
    },
  };
}
