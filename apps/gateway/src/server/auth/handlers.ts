/**
 * Host-agnostic HTTP handlers of the human-authentication surface
 * (`Request → Response`, never `next`). The Next route handlers under
 * `src/app/**` are one-line adapters over these.
 *
 *   GET  /auth/login?return_to=   start an OIDC sign-in (redirect to the IdP)
 *   GET  /auth/callback           finish it (code → session cookie)
 *   POST /logout                  destroy the session (origin-checked)
 *   POST /api/auth/bootstrap      sign in with the bootstrap token (origin-checked)
 *   POST /api/admin/identity-provider  save the IdP settings (operator, origin-checked)
 *
 * Every redirect target is a same-origin path; every error reaches the
 * browser as a closed `LoginErrorCode` in the query string, the detail
 * goes to the log.
 */
import type { AuditWriter } from '@vaubaan/gateway-core';

import type { IdpConfig } from '../config/types';
import { resolveReturnTo } from '../http/return-to';
import type { Logger } from '../logging';
import type { Clock } from '../store/clock';
import { toIso } from '../store/clock';
import { auditActorId, type Authenticator } from './authenticator';
import type { BootstrapService } from './bootstrap';
import { assertEmailDomainAllowed, mapClaims } from './claims';
import { IdpSettingsError, LoginError, type LoginErrorCode } from './errors';
import { guardMutation, OPERATOR_REFUSALS, refusalResponse } from './guard';
import { IDP_CONFIG_OBJECT_ID, type IdpSettingsService, splitList } from './idp-settings';
import { completeLogin, type LoginDeps } from './login';
import { forbiddenOriginResponse, isSameOrigin } from './origin';
import { callbackUrl, type RelyingPartyFactory } from './relying-party';
import type { SessionService } from './session-service';

export const LOGIN_PAGE = '/login';
export const ADMIN_PAGE = '/admin';
export const BOOTSTRAP_PAGE = '/admin/bootstrap';
export const IDP_PAGE = '/admin/identity-provider';
const RETURN_TO_PARAM = 'return_to';
const SEE_OTHER = 303;
const BAD_REQUEST = 400;

export interface AuthHandlerDeps {
  readonly publicUrl: URL;
  readonly sessions: SessionService;
  readonly idp: IdpSettingsService;
  readonly bootstrap: BootstrapService;
  readonly relyingParties: RelyingPartyFactory;
  readonly authenticator: Authenticator;
  readonly login: LoginDeps;
  readonly audit: AuditWriter;
  readonly logger: Logger;
  readonly clock: Clock;
}

export interface AuthHandlers {
  loginStart(request: Request): Promise<Response>;
  loginCallback(request: Request): Promise<Response>;
  logout(request: Request): Promise<Response>;
  bootstrapLogin(request: Request): Promise<Response>;
  saveIdpSettings(request: Request): Promise<Response>;
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

  return {
    async loginStart(request) {
      const current = await deps.idp.current();
      if (!current) return loginError('idp-not-configured');
      const returnTo = safeReturnTo(
        new URL(request.url).searchParams.get(RETURN_TO_PARAM),
        deps.publicUrl,
      );
      try {
        const started = await deps.relyingParties.for(current.settings).start();
        const pending = await deps.sessions.createPending({
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

    async loginCallback(request) {
      const clearPending = deps.sessions.clearPendingCookie();
      const pending = await deps.sessions.takePending(request.headers);
      if (!pending) return loginError('login-expired', { 'Set-Cookie': clearPending });
      const current = await deps.idp.current();
      if (!current) return loginError('idp-not-configured', { 'Set-Cookie': clearPending });

      // The callback URL the IdP redirected to is the public one (TLS terminator in
      // front); only the query string is taken from the request.
      const url = callbackUrl(deps.publicUrl);
      url.search = new URL(request.url).search;
      try {
        const finished = await deps.relyingParties.for(current.settings).finish(url, pending);
        for (const warning of finished.warnings) logger.warn('sign-in warning', { warning });
        const identity = mapClaims(finished.claims, current.settings.claims, {
          userinfoFailed: finished.userinfoFailed,
        });
        assertEmailDomainAllowed(identity.email, current.settings.allowedEmailDomains);
        const outcome = await completeLogin(deps.login, identity);
        // A sign-in replaces the session the browser already had, it does not add one.
        await deps.sessions.destroy(request.headers);
        const session = await deps.sessions.create({
          kind: 'user',
          userId: outcome.user.id,
          login: { email: identity.email, groups: identity.groups },
        });
        // Validated again where it becomes a `Location`: a pending sign-in stored by
        // an older build cannot leave the instance.
        const location = safeReturnTo(pending.returnTo, deps.publicUrl);
        const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
        headers.append('Set-Cookie', session.setCookie);
        headers.append('Set-Cookie', clearPending);
        return new Response(null, { status: SEE_OTHER, headers });
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
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      const token = stringField(form, 'token');
      if (!(await deps.bootstrap.verify(token))) {
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
      const before = await deps.idp.stored();
      try {
        const saved = await deps.idp.save({
          issuer: stringField(form, 'issuer'),
          clientId: stringField(form, 'client_id'),
          clientSecret: stringField(form, 'client_secret') || null,
          claims: {
            sub: stringField(form, 'claim_sub'),
            email: stringField(form, 'claim_email'),
            groups: stringField(form, 'claim_groups'),
          },
          allowedEmailDomains: splitList(stringField(form, 'allowed_email_domains')),
        });
        const actor = auditActorId(guard.principal);
        try {
          await deps.audit.write({
            kind: 'admin',
            ts: toIso(deps.clock.now()),
            user_id: actor,
            act: 'config-changed',
            object: { type: 'instance-config', id: IDP_CONFIG_OBJECT_ID },
            before: before ? idpAuditView(before) : null,
            after: idpAuditView(saved),
            delegated_client_id: null,
          });
        } catch (err) {
          // The settings are committed; a missing entry must at least be loud.
          logger.error('audit entry not written for a saved configuration change', {
            actor,
            object: IDP_CONFIG_OBJECT_ID,
            err,
          });
        }
        logger.info('identity provider settings saved', { issuer: saved.issuer.origin });
        return redirect(`${IDP_PAGE}?saved=1`);
      } catch (err) {
        if (err instanceof IdpSettingsError) {
          const params = new URLSearchParams();
          for (const p of err.problems) params.append('problem', p);
          return redirect(`${IDP_PAGE}?${params.toString()}`);
        }
        throw err;
      }
    },
  };

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

/** What an administrative audit entry records of the IdP settings: never the client secret. */
function idpAuditView(
  settings: Pick<IdpConfig, 'issuer' | 'clientId' | 'claims' | 'allowedEmailDomains'>,
): Record<string, unknown> {
  return {
    issuer: settings.issuer.href,
    client_id: settings.clientId,
    claims: settings.claims,
    allowed_email_domains: settings.allowedEmailDomains,
  };
}

/**
 * Where the Administration surface sends a visitor with no session: the
 * bootstrap page while the token is the only way in, the sign-in otherwise.
 */
export async function adminSignInPage(auth: {
  readonly bootstrap: Pick<BootstrapService, 'state'>;
  readonly idp: Pick<IdpSettingsService, 'current'>;
}): Promise<string> {
  const [bootstrap, idp] = await Promise.all([auth.bootstrap.state(), auth.idp.current()]);
  return bootstrap.status === 'active' && !idp ? BOOTSTRAP_PAGE : LOGIN_PAGE;
}

/** The form body of a mutation, or `null` when the body is not a form. */
export async function readForm(request: Request): Promise<FormData | null> {
  try {
    return await request.formData();
  } catch {
    return null;
  }
}

/** 400: a mutation that takes a form received something else. */
export function notAFormResponse(): Response {
  return new Response(
    JSON.stringify({ error: 'invalid-request', reason: 'a form body is required' }),
    {
      status: BAD_REQUEST,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    },
  );
}

function stringField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
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
