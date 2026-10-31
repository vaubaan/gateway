/**
 * Host-agnostic HTTP handlers of the human-authentication surface
 * (`Request → Response`, never `next`). The Next route handlers under
 * `src/app/**` are one-line adapters over these.
 *
 *   GET  /auth/login?return_to=          the one provider, or the sign-in page to choose
 *   GET  /auth/login/<id>?return_to=     start a sign-in with provider <id>
 *   GET  /auth/callback                  finish a sign-in of the provider `idp`
 *   GET  /auth/callback/<id>             finish a sign-in of provider <id>
 *   POST /logout                         destroy the session (origin-checked)
 *   POST /api/auth/bootstrap             sign in with the bootstrap token (origin-checked)
 *   POST /api/admin/identity-provider    save a sign-in provider (operator, origin-checked)
 *   POST /api/admin/sign-in-providers    the same, under the name of the page
 *   POST /api/admin/sign-in-providers/<id>/remove   remove one (operator, origin-checked)
 *   GET  /auth/test/<id>                 test a provider beside the session (operator): the
 *                                        callback signs nobody in (ADR administrators-live-in-the-instance)
 *   POST /api/admin/sign-in-providers/<id>/enable    switch on, after a passed test (operator)
 *   POST /api/admin/sign-in-providers/<id>/disable   switch off (operator; never the last way in)
 *   POST /api/admin/sign-in-providers/<id>/test/administrator   make the tested identity an administrator
 *
 * Every redirect target is a same-origin path; every error reaches the
 * browser as a closed `LoginErrorCode` in the query string, the detail
 * goes to the log.
 */
import type { AuditWriter } from '@vaubaan/gateway-core';

import type { RateLimiter } from '../compose/ports';
import { entraIssuer } from '../config/sign-in';
import { resolveReturnTo } from '../http/return-to';
import { LimitReachedError } from '../limits';
import type { Logger } from '../logging';
import type { Store } from '../store';
import type { Clock } from '../store/clock';
import { toIso } from '../store/clock';
import {
  ADMINISTRATORS_ERROR_MESSAGES,
  AdministratorsError,
  groupsOfProvider,
  type AdministratorsService,
} from './administrators';
import { admit } from './admission';
import { auditActorId, type Authenticator, type Principal } from './authenticator';
import { BOOTSTRAP_MAX_MISSES, type BootstrapService } from './bootstrap';
import { IdpSettingsError, LOGIN_ERROR_MESSAGES, LoginError, type LoginErrorCode } from './errors';
import { guardMutation, OPERATOR_REFUSALS, refusalResponse } from './guard';
import { notAFormResponse, readForm, splitList, stringField } from '../http/form';
import type { LoginDeps } from './login';
import type { FinishSignIn } from './local-handlers';
import { forbiddenOriginResponse, isSameOrigin } from './origin';
import type { PendingLogin, SessionService } from './session-service';
import type { SignInFlows } from './sign-in-flows';
import { createThrottle } from './throttle';
import {
  signInAuditObjectId,
  signInProviderAuditView,
  type ProviderTestRecord,
  type SaveMode,
  type SignInProvidersService,
} from './sign-in-providers';
import type { SignInProvider } from '../config/sign-in';

export const LOGIN_PAGE = '/login';
export const ADMIN_PAGE = '/admin';
export const BOOTSTRAP_PAGE = '/admin/bootstrap';
/** Settings → Sign-in: the list of providers. */
export const IDP_PAGE = '/admin/identity-provider';
/** The form to add a provider (`?kind=oidc|github`). */
export const NEW_SIGN_IN_PROVIDER_PAGE = `${IDP_PAGE}/new`;
/** The page of one provider saved in Settings. */
export function signInProviderPage(id: string): string {
  return `${IDP_PAGE}/${encodeURIComponent(id)}`;
}
/** The address that starts a sign-in with one provider. */
export function signInStartPath(id: string): string {
  return `/auth/login/${encodeURIComponent(id)}`;
}
/** The address that tests a provider beside the session. */
export function signInTestPath(id: string): string {
  return `/auth/test/${encodeURIComponent(id)}`;
}
/** The page that shows the last test of a provider. */
export function signInTestPage(id: string): string {
  return `${IDP_PAGE}/${encodeURIComponent(id)}/test`;
}
const RETURN_TO_PARAM = 'return_to';

const MINUTE_MS = 60_000;
/**
 * Sign-in limits (security review 2026-10-15, auth M1). A sign-in start writes a
 * pending row: per client address when the address is known (`trusted_proxies` or
 * `client_ip_header`), and an instance-wide ceiling that bounds the live pending rows
 * (`LOGIN_STARTS_PER_INSTANCE` per `LOGIN_TTL`, the life of one row) whatever the
 * address. The callbacks cost a digest and a read: generous limits. The bootstrap
 * token is a one-time secret: a hard instance-wide window, and a durable miss counter
 * that revokes it (`BOOTSTRAP_MAX_MISSES`).
 */
export const AUTH_LIMITS = {
  loginStartPerAddress: { limit: 20, windowMs: MINUTE_MS },
  loginStartPerInstance: { limit: 1000, windowMs: 10 * MINUTE_MS },
  callbackPerAddress: { limit: 30, windowMs: MINUTE_MS },
  callbackPerInstance: { limit: 2000, windowMs: MINUTE_MS },
  bootstrapPerInstance: { limit: 10, windowMs: 10 * MINUTE_MS },
  /** The password form of the local accounts, and the forms that take a link. */
  passwordPerAddress: { limit: 10, windowMs: MINUTE_MS },
  passwordPerInstance: { limit: 300, windowMs: MINUTE_MS },
  /** "Forgot your password": each answer may send a mail. */
  forgotPerAddress: { limit: 3, windowMs: 10 * MINUTE_MS },
  forgotPerInstance: { limit: 30, windowMs: 10 * MINUTE_MS },
} as const;
const SEE_OTHER = 303;

export interface AuthHandlerDeps {
  readonly publicUrl: URL;
  readonly sessions: SessionService;
  readonly providers: SignInProvidersService;
  readonly flows: SignInFlows;
  readonly bootstrap: BootstrapService;
  readonly authenticator: Authenticator;
  readonly login: LoginDeps;
  readonly store: Pick<Store, 'invitations' | 'users'>;
  /** Who administers: admitted although nobody invited them, and named at sign-in. */
  readonly administrators: AdministratorsService;
  readonly audit: AuditWriter;
  readonly logger: Logger;
  readonly clock: Clock;
  /** The instance's limiter (`compose/ports.ts`); single-process today, a shared store when hosted. */
  readonly rateLimiter: RateLimiter;
  /** The client address the per-address limits are keyed on (`http/client-ip.ts`). */
  readonly clientIp: (headers: Headers) => string;
  /**
   * Whether an OpenID Connect issuer answers its discovery document: why not, or
   * `null` (`RelyingPartyFactory.checkIssuer`). A test reads it before it starts.
   */
  readonly checkIssuer?: (issuer: URL) => Promise<string | null>;
  /** Admission, the user, the second factor's step or the session (`local-handlers.ts`). */
  readonly finishSignIn: FinishSignIn;
}

export interface AuthHandlers {
  /** `providerId` from the path; absent on `/auth/login`. */
  loginStart(request: Request, providerId?: string): Promise<Response>;
  /** `providerId` from the path; absent on `/auth/callback` (the provider `idp`). */
  loginCallback(request: Request, providerId: string): Promise<Response>;
  logout(request: Request): Promise<Response>;
  bootstrapLogin(request: Request): Promise<Response>;
  /** Saves a sign-in provider from the Settings form (the single-provider form included). */
  saveIdpSettings(request: Request): Promise<Response>;
  removeSignInProvider(request: Request, providerId: string): Promise<Response>;
  /** `GET /auth/test/<id>`: a test of the provider, in another window, beside the session. */
  testStart(request: Request, providerId: string): Promise<Response>;
  enableSignInProvider(request: Request, providerId: string): Promise<Response>;
  disableSignInProvider(request: Request, providerId: string): Promise<Response>;
  /** The identity the session's last test of this provider returned becomes an administrator. */
  makeAdministratorFromTest(request: Request, providerId: string): Promise<Response>;
  /** Field `waiver`: `always`, `amr`, or `none` (ADR administrators-live-in-the-instance, §7). */
  setSecondFactorWaiver(request: Request, providerId: string): Promise<Response>;
}

export function createAuthHandlers(deps: AuthHandlerDeps): AuthHandlers {
  const { logger } = deps;

  function redirect(path: string, headers: Record<string, string> = {}): Response {
    const h = new Headers({ Location: path, 'Cache-Control': 'no-store' });
    for (const [k, v] of Object.entries(headers)) h.append(k, v);
    return new Response(null, { status: SEE_OTHER, headers: h });
  }

  function loginError(code: LoginErrorCode, extraHeaders: Record<string, string> = {}): Response {
    return redirect(`${LOGIN_PAGE}?error=${code}`, extraHeaders);
  }

  async function writeAudit(
    actor: string,
    objectId: string,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    try {
      await deps.audit.write({
        kind: 'admin',
        ts: toIso(deps.clock.now()),
        user_id: actor,
        act: 'config-changed',
        object: { type: 'instance-config', id: objectId },
        before,
        after,
        delegated_client_id: null,
      });
    } catch (err) {
      // The change is committed; a missing entry must at least be loud.
      logger.error('audit entry not written for a saved configuration change', {
        actor,
        object: objectId,
        err,
      });
    }
  }

  const admitted = createThrottle({
    rateLimiter: deps.rateLimiter,
    clientIp: deps.clientIp,
    logger,
  });

  return {
    async loginStart(request, providerId) {
      if (
        !(await admitted(
          request,
          'login-start',
          AUTH_LIMITS.loginStartPerAddress,
          AUTH_LIMITS.loginStartPerInstance,
        ))
      ) {
        return loginError('too-many-attempts');
      }
      const returnTo = safeReturnTo(
        new URL(request.url).searchParams.get(RETURN_TO_PARAM),
        deps.publicUrl,
      );
      let id = providerId;
      if (id === undefined) {
        const views = (await deps.providers.views()).filter((view) => view.enabled);
        if (views.length === 0) return loginError('idp-not-configured');
        const [only] = views;
        if (views.length > 1 || !only) {
          // Several providers: the person chooses on the sign-in page, which keeps where to go.
          return redirect(`${LOGIN_PAGE}?${RETURN_TO_PARAM}=${encodeURIComponent(returnTo)}`);
        }
        id = only.id;
      }
      try {
        const effective = await deps.providers.resolve(id);
        if (!effective) return loginError('provider-unknown');
        if (!(await deps.providers.state(id)).enabled) return loginError('provider-disabled');
        const administrators = await deps.administrators.current();
        const started = await deps.flows
          .for(effective.provider, groupsOfProvider(administrators, effective.provider.id))
          .start();
        const pending = await deps.sessions.createPending({
          providerId: effective.provider.id,
          state: started.state,
          nonce: started.nonce,
          codeVerifier: started.codeVerifier,
          returnTo,
        });
        return redirect(started.redirectTo.href, { 'Set-Cookie': pending.setCookie });
      } catch (err) {
        return failLogin(err);
      }
    },

    async loginCallback(request, providerId) {
      const clearPending = deps.sessions.clearPendingCookie();
      if (
        !(await admitted(
          request,
          'callback',
          AUTH_LIMITS.callbackPerAddress,
          AUTH_LIMITS.callbackPerInstance,
        ))
      ) {
        return loginError('too-many-attempts');
      }
      const pending = await deps.sessions.takePending(request.headers);
      if (!pending) return loginError('login-expired', { 'Set-Cookie': clearPending });
      // The attempt was started for one provider: the callback of another never completes it.
      if (pending.providerId !== providerId) {
        logger.warn('sign-in failed', {
          code: 'state-mismatch',
          detail: `a callback of provider '${providerId}' for an attempt started with '${pending.providerId}'`,
        });
        return loginError('state-mismatch', { 'Set-Cookie': clearPending });
      }
      const effective = await deps.providers.resolve(providerId);
      if (!effective) return loginError('provider-unknown', { 'Set-Cookie': clearPending });
      const provider = effective.provider;
      if (pending.testerSessionId !== undefined) {
        return finishTest(request, provider, pending, clearPending);
      }
      if (!(await deps.providers.state(provider.id)).enabled) {
        return loginError('provider-disabled', { 'Set-Cookie': clearPending });
      }

      // The callback URL the provider redirected to is the public one (TLS terminator in
      // front); only the query string is taken from the request.
      const url = deps.flows.callbackUrl(provider.id);
      url.search = new URL(request.url).search;
      try {
        const administrators = await deps.administrators.current();
        const finished = await deps.flows
          .for(provider, groupsOfProvider(administrators, provider.id))
          .finish(url, pending);
        for (const warning of finished.warnings) logger.warn('sign-in warning', { warning });
        // Admission, the user, then the second factor's step or the session — what every
        // provider's sign-in ends with. The return path is validated again where it
        // becomes a `Location`: a pending sign-in stored by an older build cannot leave.
        return await deps.finishSignIn(
          request,
          provider,
          finished.identity,
          safeReturnTo(pending.returnTo, deps.publicUrl),
        );
      } catch (err) {
        return failLogin(err, { 'Set-Cookie': clearPending });
      }
    },

    async logout(request) {
      if (!isSameOrigin(request.headers, deps.publicUrl)) return forbiddenOriginResponse();
      const cleared = await deps.sessions.destroy(request.headers);
      return redirect(LOGIN_PAGE, { 'Set-Cookie': cleared });
    },

    async bootstrapLogin(request) {
      if (!isSameOrigin(request.headers, deps.publicUrl)) return forbiddenOriginResponse();
      const state = await deps.bootstrap.state();
      if (state.status !== 'active') {
        return redirect(`${BOOTSTRAP_PAGE}?error=bootstrap-unavailable`);
      }
      if (!(await admitted(request, 'bootstrap', null, AUTH_LIMITS.bootstrapPerInstance))) {
        return redirect(`${BOOTSTRAP_PAGE}?error=too-many-attempts`);
      }
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      const token = stringField(form, 'token');
      if (!(await deps.bootstrap.verify(token))) {
        const revoked = await deps.bootstrap.recordMiss();
        if (revoked) {
          logger.error('bootstrap token revoked after too many wrong tokens', {
            misses: BOOTSTRAP_MAX_MISSES,
          });
          return redirect(`${BOOTSTRAP_PAGE}?error=bootstrap-unavailable`);
        }
        logger.warn('bootstrap token refused');
        return redirect(`${BOOTSTRAP_PAGE}?error=bootstrap-refused`);
      }
      await deps.sessions.destroy(request.headers);
      const session = await deps.sessions.create({ kind: 'bootstrap' });
      logger.info('bootstrap operator signed in');
      return redirect(ADMIN_PAGE, { 'Set-Cookie': session.setCookie });
    },

    async saveIdpSettings(request) {
      const guard = await guardMutation(request, deps, 'operator');
      if (!guard.ok) return refusalResponse(guard, OPERATOR_REFUSALS);

      const form = await readForm(request);
      if (!form) return notAFormResponse();
      const id = stringField(form, 'provider_id');
      const kind = stringField(form, 'kind') || 'oidc';
      const requested = stringField(form, 'mode');
      const mode: SaveMode =
        requested === 'create' || requested === 'update'
          ? requested
          : (await deps.providers.view(id))
            ? 'update'
            : 'create';
      const admission = stringField(form, 'admission');
      // The Entra ID preset asks for the tenant and writes the issuer itself; a tenant that
      // is neither a GUID nor a domain is left blank, which the service refuses by name.
      const tenant = stringField(form, 'tenant');
      const preset = stringField(form, 'preset');
      const issuerFromTenant = tenant ? entraIssuer(tenant) : null;
      const input = {
        id,
        kind,
        name: stringField(form, 'name'),
        issuer: tenant ? (issuerFromTenant?.href ?? '') : stringField(form, 'issuer'),
        clientId: stringField(form, 'client_id'),
        clientSecret: stringField(form, 'client_secret') || null,
        claims: {
          sub: stringField(form, 'claim_sub') || 'sub',
          email: stringField(form, 'claim_email') || 'email',
          groups: stringField(form, 'claim_groups') || 'groups',
        },
        // The page's three admission rules (`admission`); a client that posts the form
        // itself may send the domains and `invitation_only` instead.
        allowedEmailDomains:
          admission === 'everyone' || admission === 'invited'
            ? []
            : splitList(stringField(form, 'allowed_email_domains')),
        invitationOnly: admission
          ? admission === 'invited'
          : stringField(form, 'invitation_only') === 'true',
      };
      try {
        if (tenant && !issuerFromTenant) {
          throw new IdpSettingsError([
            `'${tenant}' is not an Entra ID tenant: give the tenant ID (a GUID) or the tenant domain, such as contoso.onmicrosoft.com`,
          ]);
        }
        const { saved, before } = await deps.providers.save(input, mode);
        const actor = auditActorId(guard.principal);
        await writeAudit(
          actor,
          signInAuditObjectId(saved.id),
          before ? signInProviderAuditView(before) : null,
          signInProviderAuditView(saved),
        );
        logger.info('sign-in provider saved', {
          provider: saved.id,
          kind: saved.kind,
          issuer: saved.issuer.origin,
        });
        return redirect(`${IDP_PAGE}?saved=${encodeURIComponent(saved.id)}`);
      } catch (err) {
        if (err instanceof IdpSettingsError) {
          const params = new URLSearchParams();
          for (const p of err.problems) params.append('problem', p);
          if (mode === 'update') return redirect(`${signInProviderPage(id)}?${params.toString()}`);
          // A refused new provider comes back as it was typed — never the secret; a preset
          // comes back on its own page.
          params.set('kind', preset || kind);
          params.set('id', id);
          for (const field of [
            'name',
            'issuer',
            'tenant',
            'client_id',
            'claim_sub',
            'claim_email',
            'claim_groups',
            'allowed_email_domains',
            'invitation_only',
            'admission',
          ]) {
            const value = stringField(form, field);
            if (value) params.set(field, value);
          }
          return redirect(`${NEW_SIGN_IN_PROVIDER_PAGE}?${params.toString()}`);
        }
        throw err;
      }
    },

    async testStart(request, providerId) {
      const principal = await deps.authenticator.authenticate(request.headers);
      const decision = await deps.authenticator.authorizeAdmin(principal);
      if (!decision.ok) {
        return decision.status === 401
          ? redirect(`${LOGIN_PAGE}?${RETURN_TO_PARAM}=${encodeURIComponent(IDP_PAGE)}`)
          : statusResponse(403, decision.reason);
      }
      if (
        !(await admitted(
          request,
          'login-start',
          AUTH_LIMITS.loginStartPerAddress,
          AUTH_LIMITS.loginStartPerInstance,
        ))
      ) {
        return redirect(
          `${IDP_PAGE}?problem=${encodeURIComponent(LOGIN_ERROR_MESSAGES['too-many-attempts'])}`,
        );
      }
      const effective = await deps.providers.resolve(providerId);
      if (!effective || effective.provider.kind === 'local') {
        return redirect(
          `${IDP_PAGE}?problem=${encodeURIComponent('Only a provider people are sent to (OpenID Connect, GitHub) is tested here.')}`,
        );
      }
      const provider = effective.provider;
      const tester = decision.principal;
      if (provider.kind === 'oidc' && deps.checkIssuer) {
        // The check of the form (#81), before anything is started: a test that cannot
        // even find the provider says why, rather than "could not be reached".
        const problem = await deps.checkIssuer(provider.issuer);
        if (problem !== null) {
          await recordTest(provider.id, tester, {
            outcome: 'failed',
            error: 'discovery-failed',
            detail: problem,
          });
          return redirect(signInTestPage(provider.id));
        }
      }
      try {
        const administrators = await deps.administrators.current();
        const started = await deps.flows
          .for(provider, groupsOfProvider(administrators, provider.id))
          .start();
        const pending = await deps.sessions.createPending({
          providerId: provider.id,
          state: started.state,
          nonce: started.nonce,
          codeVerifier: started.codeVerifier,
          returnTo: signInTestPage(provider.id),
          testerSessionId: tester.sessionId,
        });
        return redirect(started.redirectTo.href, { 'Set-Cookie': pending.setCookie });
      } catch (err) {
        await recordTest(provider.id, tester, {
          outcome: 'failed',
          error: err instanceof LoginError ? err.code : 'idp-error',
        });
        return redirect(signInTestPage(provider.id));
      }
    },

    async enableSignInProvider(request, providerId) {
      const guard = await guardMutation(request, deps, 'operator');
      if (!guard.ok) return refusalResponse(guard, OPERATOR_REFUSALS);
      try {
        const provider = await deps.providers.setEnabled(providerId, true);
        await writeAct(
          auditActorId(guard.principal),
          'sign-in-provider-enabled',
          provider.id,
          {
            enabled: false,
          },
          { enabled: true },
        );
        return redirect(`${IDP_PAGE}?enabled=${encodeURIComponent(provider.id)}`);
      } catch (err) {
        return problemRedirect(err, IDP_PAGE);
      }
    },

    async disableSignInProvider(request, providerId) {
      const guard = await guardMutation(request, deps, 'operator');
      if (!guard.ok) return refusalResponse(guard, OPERATOR_REFUSALS);
      try {
        await deps.administrators.assertNoLockout({ withoutProvider: providerId });
        const provider = await deps.providers.setEnabled(providerId, false);
        // Its users stop here, as for a removal — except the administrator who did it.
        const ended = await deps.store.users.endSessionsOfIssuer(
          provider.issuer.href,
          guard.principal.kind === 'user' ? guard.principal.user.id : null,
        );
        await writeAct(
          auditActorId(guard.principal),
          'sign-in-provider-disabled',
          provider.id,
          {
            enabled: true,
          },
          { enabled: false, users: ended },
        );
        logger.warn('sign-in provider switched off', { provider: provider.id, users: ended });
        return redirect(`${IDP_PAGE}?disabled=${encodeURIComponent(provider.id)}&people=${ended}`);
      } catch (err) {
        return problemRedirect(err, IDP_PAGE);
      }
    },

    async makeAdministratorFromTest(request, providerId) {
      const guard = await guardMutation(request, deps, 'operator');
      if (!guard.ok) return refusalResponse(guard, OPERATOR_REFUSALS);
      const page = signInTestPage(providerId);
      try {
        const test = (await deps.providers.state(providerId)).test;
        // The result this session saw, never a field of the form.
        if (
          !test ||
          test.outcome !== 'passed' ||
          !test.identity ||
          test.sessionId !== guard.principal.sessionId
        ) {
          throw new AdministratorsError(
            'not-found',
            'no passed test of this provider in this session',
          );
        }
        // Naming somebody who is not a user yet adds one (spec §4.3 bis).
        const known = await deps.store.users.getByIdentity(
          test.identity.issuer,
          test.identity.subject,
        );
        if (!known) {
          const reached = await deps.login.ceilings?.refusal('users');
          if (reached) throw new LimitReachedError(reached);
        }
        const user = await deps.store.users.ensureIdentity({
          issuer: test.identity.issuer,
          subject: test.identity.subject,
          email: test.identity.email,
          displayName: test.identity.displayName,
        });
        await deps.administrators.grantUser(
          user.id,
          auditActorId(guard.principal),
          guard.principal.kind === 'bootstrap' ? 'setup' : 'granted',
        );
        return redirect(`${page}?administrator=1`);
      } catch (err) {
        return problemRedirect(err, page);
      }
    },

    async setSecondFactorWaiver(request, providerId) {
      const guard = await guardMutation(request, deps, 'operator');
      if (!guard.ok) return refusalResponse(guard, OPERATOR_REFUSALS);
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      const field = stringField(form, 'waiver');
      const waiver = field === 'always' || field === 'amr' ? field : null;
      try {
        const { provider, before } = await deps.providers.setWaiver(providerId, waiver);
        await deps.audit.write({
          kind: 'admin',
          ts: toIso(deps.clock.now()),
          user_id: auditActorId(guard.principal),
          act: 'second-factor-waiver-changed',
          object: { type: 'instance-config', id: signInAuditObjectId(provider.id) },
          before: { waiver: before },
          after: { waiver },
          delegated_client_id: null,
        });
        logger.warn('second factor waiver changed', { provider: provider.id, waiver });
        return redirect(`${IDP_PAGE}?waiver=${encodeURIComponent(provider.id)}`);
      } catch (err) {
        return problemRedirect(err, IDP_PAGE);
      }
    },

    async removeSignInProvider(request, providerId) {
      const guard = await guardMutation(request, deps, 'operator');
      if (!guard.ok) return refusalResponse(guard, OPERATOR_REFUSALS);
      try {
        // No self-lockout: the last administrators' only way in stays.
        await deps.administrators.assertNoLockout({ withoutProvider: providerId });
        const removed = await deps.providers.remove(providerId);
        // Its users can no longer sign in; what they had open ends now — except the
        // session of the administrator who removed it. Their missions, keys and
        // connected apps follow the rules of a deactivation: they stop only when an
        // administrator deactivates them (handbook authentication).
        const ended = await deps.store.users.endSessionsOfIssuer(
          removed.issuer.href,
          guard.principal.kind === 'user' ? guard.principal.user.id : null,
        );
        const actor = auditActorId(guard.principal);
        await writeAudit(
          actor,
          signInAuditObjectId(removed.id),
          { ...signInProviderAuditView(removed), users: ended },
          null,
        );
        logger.warn('sign-in provider removed', { provider: removed.id, users: ended });
        return redirect(`${IDP_PAGE}?removed=${encodeURIComponent(removed.id)}&people=${ended}`);
      } catch (err) {
        if (err instanceof IdpSettingsError || err instanceof AdministratorsError) {
          const problems =
            err instanceof AdministratorsError
              ? [ADMINISTRATORS_ERROR_MESSAGES[err.code]]
              : err.problems;
          const params = new URLSearchParams();
          for (const p of problems) params.append('problem', p);
          return redirect(`${IDP_PAGE}?${params.toString()}`);
        }
        throw err;
      }
    },
  };

  /** Back to `page` with the problem in words, for the errors an act of Settings may meet. */
  function problemRedirect(err: unknown, page: string): Response {
    let problems: readonly string[];
    if (err instanceof IdpSettingsError) problems = err.problems;
    else if (err instanceof LimitReachedError) problems = [err.message];
    else if (err instanceof AdministratorsError) {
      problems = [ADMINISTRATORS_ERROR_MESSAGES[err.code]];
    } else throw err;
    const params = new URLSearchParams();
    for (const p of problems) params.append('problem', p);
    return redirect(`${page}?${params.toString()}`);
  }

  async function writeAct(
    actor: string,
    act: 'sign-in-provider-enabled' | 'sign-in-provider-disabled' | 'sign-in-provider-tested',
    providerId: string,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    await deps.audit.write({
      kind: 'admin',
      ts: toIso(deps.clock.now()),
      user_id: actor,
      act,
      object: { type: 'instance-config', id: signInAuditObjectId(providerId) },
      before,
      after,
      delegated_client_id: null,
    });
  }

  async function recordTest(
    providerId: string,
    tester: Principal,
    result: Omit<ProviderTestRecord, 'at' | 'by' | 'sessionId'>,
  ): Promise<void> {
    const record: ProviderTestRecord = {
      ...result,
      at: toIso(deps.clock.now()),
      by: auditActorId(tester),
      sessionId: tester.sessionId,
    };
    await deps.providers.recordTest(providerId, record);
    await writeAct(record.by, 'sign-in-provider-tested', providerId, null, {
      outcome: record.outcome,
      ...(record.error ? { error: record.error } : {}),
      ...(record.identity ? { email: record.identity.email } : {}),
      ...(record.verdict ? { verdict: record.verdict } : {}),
    });
    logger.info('sign-in provider tested', {
      provider: providerId,
      outcome: record.outcome,
      error: record.error ?? null,
    });
  }

  /**
   * The callback of a test: the provider's answer is read to the end, then shown with
   * the verdict a sign-in would get — and nothing is written of it: no user, no group,
   * no session, no designation consumed, no token revoked. The tester's session stays.
   */
  async function finishTest(
    request: Request,
    provider: SignInProvider,
    pending: PendingLogin,
    clearPending: string,
  ): Promise<Response> {
    const principal = await deps.authenticator.authenticate(request.headers);
    const decision = await deps.authenticator.authorizeAdmin(principal);
    if (!decision.ok || decision.principal.sessionId !== pending.testerSessionId) {
      logger.warn('sign-in test refused', { code: 'state-mismatch', provider: provider.id });
      return loginError('state-mismatch', { 'Set-Cookie': clearPending });
    }
    const tester = decision.principal;
    const url = deps.flows.callbackUrl(provider.id);
    url.search = new URL(request.url).search;
    try {
      const administrators = await deps.administrators.current();
      const finished = await deps.flows
        .for(provider, groupsOfProvider(administrators, provider.id))
        .finish(url, pending);
      const identity = finished.identity;
      const administrator = await deps.administrators.admits(identity, provider.id);
      let verdict: NonNullable<ProviderTestRecord['verdict']>;
      try {
        const reason = await admit(identity, provider, {
          isInvited: async (email) => (await deps.store.invitations.get(email)) !== null,
          isAdministrator: async () => administrator,
        });
        verdict = { admitted: true, reason, administrator };
      } catch (err) {
        if (!(err instanceof LoginError)) throw err;
        verdict = { admitted: false, refusal: err.code, administrator: false };
      }
      await recordTest(provider.id, tester, {
        outcome: 'passed',
        identity: {
          issuer: identity.issuer,
          subject: identity.subject,
          email: identity.email,
          emailVerified: identity.emailVerified === true,
          displayName: identity.displayName,
          groups: identity.groups,
          ...(identity.amr ? { amr: identity.amr } : {}),
        },
        verdict,
      });
    } catch (err) {
      if (!(err instanceof LoginError)) {
        logger.error('sign-in test failed unexpectedly', { err });
      }
      await recordTest(provider.id, tester, {
        outcome: 'failed',
        error: err instanceof LoginError ? err.code : 'idp-error',
      });
    }
    return redirect(safeReturnTo(pending.returnTo, deps.publicUrl, IDP_PAGE), {
      'Set-Cookie': clearPending,
    });
  }

  function failLogin(err: unknown, extraHeaders: Record<string, string> = {}): Response {
    if (err instanceof LoginError) {
      logger.warn('sign-in failed', { code: err.code, detail: err.message });
      return loginError(err.code, extraHeaders);
    }
    logger.error('sign-in failed unexpectedly', { err });
    return loginError('idp-error', extraHeaders);
  }
}

/**
 * The path to land on after sign-in: a path of this instance, else `fallback`.
 * Stricter than `resolveReturnTo` on one point: only a path is accepted
 * (`/admin`), not an absolute URL nor a relative reference.
 */
export function safeReturnTo(raw: string | null, publicUrl: URL, fallback = LOGIN_PAGE): string {
  if (!raw || !raw.startsWith('/')) return fallback;
  return resolveReturnTo(raw, publicUrl) ?? fallback;
}

/**
 * Where the Administration surface sends a visitor with no session: the
 * bootstrap page while the token is the only way in, the sign-in otherwise.
 */
export async function adminSignInPage(auth: {
  readonly bootstrap: Pick<BootstrapService, 'state'>;
  readonly providers: Pick<SignInProvidersService, 'views'>;
}): Promise<string> {
  const [bootstrap, providers] = await Promise.all([
    auth.bootstrap.state(),
    auth.providers.views(),
  ]);
  return bootstrap.status === 'active' && providers.length === 0 ? BOOTSTRAP_PAGE : LOGIN_PAGE;
}

export function statusResponse(status: number, reason: string): Response {
  return new Response(
    JSON.stringify({ error: status === 401 ? 'unauthenticated' : 'forbidden', reason }),
    {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    },
  );
}
