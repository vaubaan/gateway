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
 *
 * Every redirect target is a same-origin path; every error reaches the
 * browser as a closed `LoginErrorCode` in the query string, the detail
 * goes to the log.
 */
import type { AuditWriter } from '@vaubaan/gateway-core';

import type { RateLimiter } from '../compose/ports';
import { UNKNOWN_CLIENT } from '../http/client-ip';
import { LEGACY_PROVIDER_ID } from '../config/sign-in';
import { resolveReturnTo } from '../http/return-to';
import type { Logger } from '../logging';
import type { Store } from '../store';
import type { Clock } from '../store/clock';
import { toIso } from '../store/clock';
import { admit } from './admission';
import { auditActorId, type Authenticator } from './authenticator';
import { BOOTSTRAP_MAX_MISSES, type BootstrapService } from './bootstrap';
import { IdpSettingsError, LoginError, type LoginErrorCode } from './errors';
import { guardMutation, OPERATOR_REFUSALS, refusalResponse } from './guard';
import { splitList } from './idp-settings';
import { completeLogin, type LoginDeps } from './login';
import { forbiddenOriginResponse, isSameOrigin } from './origin';
import type { SessionService } from './session-service';
import type { SignInFlows } from './sign-in-flows';
import {
  signInAuditObjectId,
  signInProviderAuditView,
  type SaveMode,
  type SignInProvidersService,
} from './sign-in-providers';

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
} as const;
const SEE_OTHER = 303;
const BAD_REQUEST = 400;

export interface AuthHandlerDeps {
  readonly publicUrl: URL;
  readonly sessions: SessionService;
  readonly providers: SignInProvidersService;
  readonly flows: SignInFlows;
  readonly bootstrap: BootstrapService;
  readonly authenticator: Authenticator;
  readonly login: LoginDeps;
  readonly store: Pick<Store, 'invitations' | 'users'>;
  /** The admin rule's emails, lower-cased: always admitted (they are named by the configuration). */
  readonly adminEmails: readonly string[];
  readonly audit: AuditWriter;
  readonly logger: Logger;
  readonly clock: Clock;
  /** The instance's limiter (`compose/ports.ts`); single-process today, a shared store when hosted. */
  readonly rateLimiter: RateLimiter;
  /** The client address the per-address limits are keyed on (`http/client-ip.ts`). */
  readonly clientIp: (headers: Headers) => string;
}

export interface AuthHandlers {
  /** `providerId` from the path; absent on `/auth/login`. */
  loginStart(request: Request, providerId?: string): Promise<Response>;
  /** `providerId` from the path; absent on `/auth/callback` (the provider `idp`). */
  loginCallback(request: Request, providerId?: string): Promise<Response>;
  logout(request: Request): Promise<Response>;
  bootstrapLogin(request: Request): Promise<Response>;
  /** Saves a sign-in provider from the Settings form (the single-provider form included). */
  saveIdpSettings(request: Request): Promise<Response>;
  removeSignInProvider(request: Request, providerId: string): Promise<Response>;
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

  /**
   * Takes one slot of each window that applies: the per-address one only when the
   * address is known (an unknown address would be one window for everybody, which the
   * instance-wide window already is). `true` when every window had room.
   */
  async function admitted(
    request: Request,
    scope: string,
    perAddress: { readonly limit: number; readonly windowMs: number } | null,
    perInstance: { readonly limit: number; readonly windowMs: number },
  ): Promise<boolean> {
    const address = deps.clientIp(request.headers);
    if (perAddress && address !== UNKNOWN_CLIENT) {
      const taken = await deps.rateLimiter.take(
        `auth:${scope}:ip:${address}`,
        perAddress.limit,
        perAddress.windowMs,
      );
      if (!taken.allowed) {
        logger.warn('sign-in throttled', { scope, window: 'address' });
        return false;
      }
    }
    const taken = await deps.rateLimiter.take(
      `auth:${scope}:instance`,
      perInstance.limit,
      perInstance.windowMs,
    );
    if (!taken.allowed) logger.warn('sign-in throttled', { scope, window: 'instance' });
    return taken.allowed;
  }

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
        const views = await deps.providers.views();
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
        const rule = await deps.providers.adminRule();
        const started = await deps.flows.for(effective.provider, rule.group).start();
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

    async loginCallback(request, providerId = LEGACY_PROVIDER_ID) {
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

      // The callback URL the provider redirected to is the public one (TLS terminator in
      // front); only the query string is taken from the request.
      const url = deps.flows.callbackUrl(provider.id);
      url.search = new URL(request.url).search;
      try {
        const rule = await deps.providers.adminRule();
        const finished = await deps.flows.for(provider, rule.group).finish(url, pending);
        for (const warning of finished.warnings) logger.warn('sign-in warning', { warning });
        const identity = finished.identity;
        const admission = await admit(identity, provider, {
          isInvited: async (email) => (await deps.store.invitations.get(email)) !== null,
          adminEmails: deps.adminEmails,
          adminGroup: rule.group,
        });
        const outcome = await completeLogin(deps.login, identity, {
          providerId: provider.id,
          adminRule: rule,
        });
        // A sign-in replaces the session the browser already had, it does not add one.
        await deps.sessions.destroy(request.headers);
        const session = await deps.sessions.create({
          kind: 'user',
          userId: outcome.user.id,
          login: { email: identity.email, groups: identity.groups, provider: provider.id },
        });
        logger.info('sign-in admitted', { provider: provider.id, admission });
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
      // The single-provider form of earlier versions sends no id: it edits `idp`.
      const id = stringField(form, 'provider_id') || LEGACY_PROVIDER_ID;
      const kind = stringField(form, 'kind') || 'oidc';
      const requested = stringField(form, 'mode');
      const mode: SaveMode =
        requested === 'create' || requested === 'update'
          ? requested
          : (await deps.providers.view(id))
            ? 'update'
            : 'create';
      const admission = stringField(form, 'admission');
      const input = {
        id,
        kind,
        name: stringField(form, 'name'),
        issuer: stringField(form, 'issuer'),
        clientId: stringField(form, 'client_id'),
        clientSecret: stringField(form, 'client_secret') || null,
        claims: {
          sub: stringField(form, 'claim_sub') || 'sub',
          email: stringField(form, 'claim_email') || 'email',
          groups: stringField(form, 'claim_groups') || 'groups',
        },
        // The page's three admission rules (`admission`); the single-provider form sends
        // the domains and `invitation_only` alone.
        allowedEmailDomains:
          admission === 'everyone' || admission === 'invited'
            ? []
            : splitList(stringField(form, 'allowed_email_domains')),
        invitationOnly: admission
          ? admission === 'invited'
          : stringField(form, 'invitation_only') === 'true',
      };
      try {
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
          // A refused new provider comes back as it was typed — never the secret.
          params.set('kind', kind);
          params.set('id', id);
          for (const field of [
            'name',
            'issuer',
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
          // The single-provider form has no page of its own for a new provider: back to the list.
          const page = stringField(form, 'provider_id') ? NEW_SIGN_IN_PROVIDER_PAGE : IDP_PAGE;
          return redirect(`${page}?${params.toString()}`);
        }
        throw err;
      }
    },

    async removeSignInProvider(request, providerId) {
      const guard = await guardMutation(request, deps, 'operator');
      if (!guard.ok) return refusalResponse(guard, OPERATOR_REFUSALS);
      try {
        const removed = await deps.providers.remove(providerId);
        // Its users can no longer sign in; what they had open ends now. Their missions,
        // keys and connected apps follow the rules of a deactivation: they stop only
        // when an administrator deactivates them (handbook authentication).
        const ended = await deps.store.users.endSessionsOfIssuer(removed.issuer.href);
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
