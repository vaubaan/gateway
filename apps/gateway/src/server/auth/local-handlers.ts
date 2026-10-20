/**
 * The forms of the local accounts (ADR local-accounts-sign-in-provider).
 *
 * Anonymous, origin-checked and rate-limited (`AUTH_LIMITS`), answering with a
 * redirect whose query carries a closed code — never a sentence that says
 * whether an address exists:
 *
 *   POST /auth/local/<provider>         email + password → a session, the second
 *                                       factor's step, or the enrolment's step
 *   POST /auth/local/<provider>/code    the code of the authenticator app, or a
 *                                       recovery code → the session
 *   POST /auth/local/<provider>/enrol   the first code of a new authenticator →
 *                                       the session; the recovery codes shown once
 *   POST /api/account/create            an invitation link's token + a password
 *   POST /api/account/reset             a reset link's token + a password
 *   POST /api/account/forgot            an address; one answer for every address
 *
 * Signed in (`guardMutation`, role `user`), from Settings → Security:
 *
 *   POST /settings/security/second-factor/begin     a new secret to enrol
 *   POST /settings/security/second-factor/confirm   the code that confirms it
 *   POST /settings/security/second-factor/remove    after a fresh sign-in
 *   POST /settings/security/password                the current password and a new one
 *
 * The sign-in itself is the one every provider gets: `admit()` (the address must
 * still be invited, or an administrator), then `completeLogin()` (the
 * `users` row, the deactivation check), then a session. Between the password
 * and the session a `PendingLocalStep` holds the second factor's turn, bound to
 * the browser by the pending-login cookie: an account with a second factor is
 * asked for it; an administrator who has none enrols one
 * before the session exists (D4 of the ADR).
 */
import type { LocalSignInProvider, SignInProvider } from '../config/sign-in';
import { NoticeStore, type Notice } from '../connections/pending';
import { createNoticeRedirect } from '../connections/notice-redirect';
import type { SessionStore } from '../compose/ports';
import type { Logger } from '../logging';
import type { Store } from '../store';
import type { Clock } from '../store/clock';
import type { LocalAccountRecord } from '../store';
import type { AdministratorsService } from './administrators';
import { waiverApplies, type SecondFactorService } from './second-factor';
import { admit } from './admission';
import type { Authenticator, UserPrincipal } from './authenticator';
import type { IdentityClaims } from './claims';
import { LocalAccountError, LoginError } from './errors';
import { guardMutation, OPERATOR_REFUSALS, refusalResponse } from './guard';
import { AUTH_LIMITS, LOGIN_PAGE, notAFormResponse, readForm, safeReturnTo } from './handlers';
import {
  CREATE_ACCOUNT_PAGE,
  FORGOT_PASSWORD_PAGE,
  LINK_TOKEN_PARAM,
  RESET_PASSWORD_PAGE,
  type LocalAccountsService,
} from './local-accounts';
import { completeLogin, type LoginDeps } from './login';
import { forbiddenOriginResponse, isSameOrigin } from './origin';
import type { PendingLocalStep, SessionService } from './session-service';
import type { SignInProvidersService } from './sign-in-providers';
import { createThrottle, type ThrottleDeps } from './throttle';

const SEE_OTHER = 303;
const RETURN_TO_PARAM = 'return_to';
/** The query parameter of a refused account form: a `LocalAccountErrorCode`. */
export const ACCOUNT_ERROR_PARAM = 'error';
/** `?sent=1` on the forgot page: the answer, whatever the address. */
export const FORGOT_SENT_PARAM = 'sent';
/** `?reset=done` on the sign-in page after a reset. */
export const RESET_DONE_PARAM = 'reset';
/** The page that asks for the code of the authenticator app. */
export const SECOND_FACTOR_PAGE = '/login/code';
/** The page that enrols a second factor during a sign-in. */
export const ENROL_PAGE = '/login/second-factor';
/** Settings → Security: the person's own password and second factor. */
export const SECURITY_PAGE = '/settings/security';
/** `?enrol=1` on Settings → Security: an enrolment is in progress (the step cookie holds the secret). */
export const ENROL_PARAM = 'enrol';
/** A second factor is removed only within this long after signing in. */
export const FRESH_SIGN_IN_FOR_FACTOR_MS = 10 * 60_000;

/** What sends the mail of a link; absent when the instance sends no mail. */
export interface LinkMailer {
  sendLink(input: {
    readonly kind: 'invite' | 'reset';
    readonly to: string;
    readonly url: URL;
    readonly expiresAt: string;
  }): Promise<void>;
}

export interface LocalAuthHandlerDeps extends ThrottleDeps {
  readonly publicUrl: URL;
  /** The name the authenticator app shows for this gateway. */
  readonly instanceLabel: string;
  readonly sessions: SessionService;
  /** The web-session store, for the one-time notices (the recovery codes shown once). */
  readonly sessionStore: SessionStore;
  readonly authenticator: Authenticator;
  readonly providers: Pick<SignInProvidersService, 'resolve' | 'views' | 'state'>;
  readonly accounts: LocalAccountsService;
  readonly login: LoginDeps;
  readonly store: Pick<Store, 'invitations' | 'users'>;
  /** Who administers: admitted without an invitation, and never without a second factor. */
  readonly administrators: AdministratorsService;
  /** The second factor of every person (ADR administrators-live-in-the-instance, §7). */
  readonly secondFactors: SecondFactorService;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly mailer?: LinkMailer;
}

export interface LocalAuthHandlers {
  passwordLogin(request: Request, providerId: string): Promise<Response>;
  /** The code of the second factor's step, of any provider (`providerId`: the route's, if any). */
  secondFactorLogin(request: Request, providerId?: string): Promise<Response>;
  /** The first code of the enrolment's step, of any provider. */
  enrolAtSignIn(request: Request, providerId?: string): Promise<Response>;
  createAccount(request: Request): Promise<Response>;
  resetPassword(request: Request): Promise<Response>;
  forgotPassword(request: Request): Promise<Response>;
  beginSecondFactor(request: Request): Promise<Response>;
  confirmSecondFactor(request: Request): Promise<Response>;
  removeSecondFactor(request: Request): Promise<Response>;
  changePassword(request: Request): Promise<Response>;
}

function stringField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

/** The identity a local account signs in as: the provider's issuer, the account id. */
export function localIdentity(
  provider: LocalSignInProvider,
  account: LocalAccountRecord,
): IdentityClaims {
  return {
    issuer: provider.issuer.href,
    subject: account.id,
    email: account.email,
    // The address was proven by the link that created the account, or typed by the
    // setup for the first administrator.
    emailVerified: true,
    displayName: null,
    groups: [],
  };
}

/** The local account behind a signed-in user, when they signed in through local accounts. */
export function localAccountIdOf(
  principal: Pick<UserPrincipal, 'user'>,
  local: Pick<LocalSignInProvider, 'issuer'>,
): string | null {
  const issuer = principal.user.issuer?.replace(/\/+$/, '') ?? null;
  return issuer === local.issuer.href.replace(/\/+$/, '') ? principal.user.subject : null;
}

/** What every provider's sign-in ends with (`proceed`): admission, the user, the second factor. */
export type FinishSignIn = (
  request: Request,
  provider: SignInProvider,
  identity: IdentityClaims,
  returnTo: string,
) => Promise<Response>;

export function createLocalAuthHandlers(
  deps: LocalAuthHandlerDeps,
): LocalAuthHandlers & { readonly proceed: FinishSignIn } {
  const { logger } = deps;
  const admitted = createThrottle(deps);
  const notices = new NoticeStore(deps.sessionStore);
  const redirectWithNotice = createNoticeRedirect(
    { publicUrl: deps.publicUrl, notices },
    SECURITY_PAGE,
  );

  function redirect(path: string, headers: Record<string, string> = {}): Response {
    return new Response(null, {
      status: SEE_OTHER,
      headers: { Location: path, 'Cache-Control': 'no-store', ...headers },
    });
  }

  function redirectWithCookies(path: string, cookies: readonly string[]): Response {
    const headers = new Headers({ Location: path, 'Cache-Control': 'no-store' });
    for (const cookie of cookies) headers.append('Set-Cookie', cookie);
    return new Response(null, { status: SEE_OTHER, headers });
  }

  function loginError(code: string, headers: Record<string, string> = {}): Response {
    return redirect(`${LOGIN_PAGE}?error=${encodeURIComponent(code)}`, headers);
  }

  function refused(page: string, token: string | null, code: string): Response {
    const params = new URLSearchParams({ [ACCOUNT_ERROR_PARAM]: code });
    if (token) params.set(LINK_TOKEN_PARAM, token);
    return redirect(`${page}?${params.toString()}`);
  }

  /** The one local provider of the instance, or `null`. */
  async function localProvider(id?: string): Promise<LocalSignInProvider | null> {
    if (id !== undefined) {
      const effective = await deps.providers.resolve(id);
      return effective?.provider.kind === 'local' ? effective.provider : null;
    }
    const view = (await deps.providers.views()).find((p) => p.kind === 'local');
    if (!view) return null;
    const effective = await deps.providers.resolve(view.id);
    return effective?.provider.kind === 'local' ? effective.provider : null;
  }

  async function throttled(request: Request, scope: 'password' | 'forgot'): Promise<boolean> {
    return !(await admitted(
      request,
      scope,
      scope === 'forgot' ? AUTH_LIMITS.forgotPerAddress : AUTH_LIMITS.passwordPerAddress,
      scope === 'forgot' ? AUTH_LIMITS.forgotPerInstance : AUTH_LIMITS.passwordPerInstance,
    ));
  }

  /** A session for the person, replacing the one the browser had; the pending cookie cleared. */
  async function openSession(
    request: Request,
    step: Pick<PendingLocalStep, 'userId' | 'providerId' | 'login'>,
  ): Promise<{ readonly sessionId: string; readonly setCookie: string }> {
    await deps.sessions.destroy(request.headers);
    const session = await deps.sessions.create({
      kind: 'user',
      userId: step.userId,
      login: { email: step.login.email, groups: [...step.login.groups], provider: step.providerId },
    });
    return { sessionId: session.id, setCookie: session.setCookie };
  }

  /**
   * What every provider's sign-in ends with, once the provider vouched for the
   * identity (the password of a local account, the callback of OpenID Connect or
   * GitHub): admission, the `users` row, then the second factor's step — the code when
   * the person has a factor, its enrolment when they have none — or, when the
   * provider's waiver applies (never to an administrator), the session (ADR
   * administrators-live-in-the-instance, §7). Throws the `LoginError` of a refusal.
   */
  async function proceed(
    request: Request,
    provider: SignInProvider,
    identity: IdentityClaims,
    returnTo: string,
  ): Promise<Response> {
    const admission = await admit(identity, provider, {
      isInvited: async (email) => (await deps.store.invitations.get(email)) !== null,
      isAdministrator: () => deps.administrators.admits(identity, provider.id),
    });
    const outcome = await completeLogin(deps.login, identity, {
      providerId: provider.id,
      administrators: deps.administrators,
    });
    logger.info('sign-in admitted', { provider: provider.id, admission });
    const base = {
      providerId: provider.id,
      userId: outcome.user.id,
      login: { email: identity.email, groups: identity.groups },
      returnTo,
    };
    if (await deps.secondFactors.has(outcome.user.id)) {
      const step = await deps.sessions.createLocalStep({ ...base, step: 'second-factor' });
      return redirect(SECOND_FACTOR_PAGE, { 'Set-Cookie': step.setCookie });
    }
    const { waiver } = await deps.providers.state(provider.id);
    if (!waiverApplies(waiver, { isOperator: outcome.isOperator, amr: identity.amr })) {
      const enrolment = deps.secondFactors.beginEnrolment(deps.instanceLabel, identity.email);
      const step = await deps.sessions.createLocalStep({
        ...base,
        step: 'enrol',
        totpSecret: enrolment.secret,
      });
      logger.info('sign-in continues with the enrolment of a second factor', {
        provider: provider.id,
      });
      return redirect(ENROL_PAGE, { 'Set-Cookie': step.setCookie });
    }
    const session = await openSession(request, base);
    const headers = new Headers({ Location: returnTo, 'Cache-Control': 'no-store' });
    headers.append('Set-Cookie', session.setCookie);
    headers.append('Set-Cookie', deps.sessions.clearPendingCookie());
    return new Response(null, { status: SEE_OTHER, headers });
  }

  /** The step's person may still sign in: active, not deactivated meanwhile. */
  async function stillActive(step: PendingLocalStep): Promise<boolean> {
    const user = await deps.store.users.getById(step.userId);
    return user !== null && user.status === 'active';
  }

  function failLogin(err: unknown, headers: Record<string, string> = {}): Response {
    if (err instanceof LoginError) {
      logger.warn('sign-in failed', { code: err.code, detail: err.message });
      return loginError(err.code, headers);
    }
    logger.error('sign-in failed unexpectedly', { err });
    return loginError('idp-error', headers);
  }

  /** The step of the request when it is the expected one for this provider; else `null`. */
  async function takeStep(
    request: Request,
    providerId: string | undefined,
    expected: PendingLocalStep['step'],
  ): Promise<PendingLocalStep | null> {
    const step = await deps.sessions.takeLocalStep(request.headers);
    if (!step || step.step !== expected) return null;
    if (providerId !== undefined && step.providerId !== providerId) return null;
    return step;
  }

  /** The recovery codes, shown once on Settings → Security, as a notice read once. */
  async function codesNotice(
    sessionId: string,
    recoveryCodes: readonly string[],
    title: string,
  ): Promise<string> {
    return notices.put(sessionId, {
      tone: 'success',
      title,
      lines: [
        'Keep these recovery codes somewhere safe: each one signs you in once when your authenticator app is not at hand. They are shown only now.',
        ...recoveryCodes,
      ],
    });
  }

  /** The signed-in local account behind a Settings → Security mutation, or the refusal. */
  async function localUserOf(
    request: Request,
  ): Promise<
    | { readonly ok: true; readonly principal: UserPrincipal; readonly accountId: string }
    | { readonly ok: false; readonly response: Response }
  > {
    const guard = await guardMutation(request, deps, 'user');
    if (!guard.ok) return { ok: false, response: refusalResponse(guard, OPERATOR_REFUSALS) };
    const local = await localProvider();
    const accountId = local ? localAccountIdOf(guard.principal, local) : null;
    if (!accountId) {
      const notice: Notice = {
        tone: 'danger',
        title: 'Not a local account',
        lines: [
          'You signed in through a provider that keeps your password and second factor; change them there.',
        ],
      };
      return {
        ok: false,
        response: await redirectWithNotice(guard.principal.sessionId, SECURITY_PAGE, notice),
      };
    }
    return { ok: true, principal: guard.principal, accountId };
  }

  return {
    proceed,
    async passwordLogin(request, providerId) {
      if (!isSameOrigin(request.headers, deps.publicUrl)) return forbiddenOriginResponse();
      if (await throttled(request, 'password')) return loginError('too-many-attempts');
      const provider = await localProvider(providerId);
      if (!provider) return loginError('provider-unknown');
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      const returnTo = safeReturnTo(stringField(form, RETURN_TO_PARAM), deps.publicUrl, '/');
      const check = await deps.accounts.checkPassword(
        provider.id,
        stringField(form, 'email'),
        stringField(form, 'password'),
      );
      if (!check.ok) {
        logger.warn('sign-in failed', { code: 'password-refused', cause: check.cause });
        return loginError('password-refused');
      }
      try {
        return await proceed(request, provider, localIdentity(provider, check.account), returnTo);
      } catch (err) {
        return failLogin(err, { 'Set-Cookie': deps.sessions.clearPendingCookie() });
      }
    },

    async secondFactorLogin(request, providerId) {
      if (!isSameOrigin(request.headers, deps.publicUrl)) return forbiddenOriginResponse();
      if (await throttled(request, 'password')) return loginError('too-many-attempts');
      const step = await takeStep(request, providerId, 'second-factor');
      if (!step) {
        return loginError('login-expired', { 'Set-Cookie': deps.sessions.clearPendingCookie() });
      }
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      const check = await deps.secondFactors.check(step.userId, stringField(form, 'code'));
      if (!check.ok) {
        // The step is kept: the person may try again, within the same ten minutes.
        const again = await deps.sessions.createLocalStep(step);
        logger.warn('sign-in failed', { code: 'second-factor-refused' });
        return redirect(`${SECOND_FACTOR_PAGE}?error=second-factor-refused`, {
          'Set-Cookie': again.setCookie,
        });
      }
      if (!(await stillActive(step))) return loginError('account-deactivated');
      if (check.by === 'recovery-code') {
        logger.info('sign-in by recovery code', {
          provider: step.providerId,
          left: check.recoveryCodesLeft,
        });
      }
      const session = await openSession(request, step);
      return redirectWithCookies(safeReturnTo(step.returnTo, deps.publicUrl, '/'), [
        session.setCookie,
        deps.sessions.clearPendingCookie(),
      ]);
    },

    async enrolAtSignIn(request, providerId) {
      if (!isSameOrigin(request.headers, deps.publicUrl)) return forbiddenOriginResponse();
      if (await throttled(request, 'password')) return loginError('too-many-attempts');
      const step = await takeStep(request, providerId, 'enrol');
      if (!step?.totpSecret) {
        return loginError('login-expired', { 'Set-Cookie': deps.sessions.clearPendingCookie() });
      }
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      if (!(await stillActive(step))) return loginError('account-deactivated');
      const confirmed = await deps.secondFactors.confirmEnrolment(
        { id: step.userId, email: step.login.email },
        step.totpSecret,
        stringField(form, 'code'),
        step.userId,
      );
      if (!confirmed) {
        const again = await deps.sessions.createLocalStep(step);
        logger.warn('sign-in failed', { code: 'second-factor-refused', at: 'enrolment' });
        return redirect(`${ENROL_PAGE}?error=second-factor-refused`, {
          'Set-Cookie': again.setCookie,
        });
      }
      const session = await openSession(request, step);
      const noticeId = await codesNotice(
        session.sessionId,
        confirmed.recoveryCodes,
        'Second factor set up',
      );
      // The recovery codes are shown once, on Security, which then leads on to where the
      // sign-in was going (an authorization in progress, a page).
      const next = safeReturnTo(step.returnTo, deps.publicUrl, '/');
      const query = new URLSearchParams({ notice: noticeId });
      if (next !== SECURITY_PAGE) query.set(RETURN_TO_PARAM, next);
      return redirectWithCookies(`${SECURITY_PAGE}?${query.toString()}`, [
        session.setCookie,
        deps.sessions.clearPendingCookie(),
      ]);
    },

    async createAccount(request) {
      if (!isSameOrigin(request.headers, deps.publicUrl)) return forbiddenOriginResponse();
      if (await throttled(request, 'password')) return loginError('too-many-attempts');
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      const token = stringField(form, LINK_TOKEN_PARAM);
      const password = stringField(form, 'password');
      if (password !== stringField(form, 'password_again')) {
        return refused(CREATE_ACCOUNT_PAGE, token, 'password-mismatch');
      }
      let account: LocalAccountRecord;
      try {
        account = await deps.accounts.createAccountFromLink(token, password);
      } catch (err) {
        if (err instanceof LocalAccountError) {
          return refused(CREATE_ACCOUNT_PAGE, err.code === 'link-invalid' ? null : token, err.code);
        }
        throw err;
      }
      const provider = await localProvider(account.provider);
      if (!provider) return loginError('provider-unknown');
      try {
        return await proceed(request, provider, localIdentity(provider, account), '/');
      } catch (err) {
        return failLogin(err, { 'Set-Cookie': deps.sessions.clearPendingCookie() });
      }
    },

    async resetPassword(request) {
      if (!isSameOrigin(request.headers, deps.publicUrl)) return forbiddenOriginResponse();
      if (await throttled(request, 'password')) return loginError('too-many-attempts');
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      const token = stringField(form, LINK_TOKEN_PARAM);
      const password = stringField(form, 'password');
      if (password !== stringField(form, 'password_again')) {
        return refused(RESET_PASSWORD_PAGE, token, 'password-mismatch');
      }
      try {
        await deps.accounts.resetPasswordFromLink(token, password);
      } catch (err) {
        if (err instanceof LocalAccountError) {
          return refused(RESET_PASSWORD_PAGE, err.code === 'link-invalid' ? null : token, err.code);
        }
        throw err;
      }
      // Every open session of that person stays: a reset is not a sign-out (deactivation is).
      return redirect(`${LOGIN_PAGE}?${RESET_DONE_PARAM}=done`);
    },

    async forgotPassword(request) {
      if (!isSameOrigin(request.headers, deps.publicUrl)) return forbiddenOriginResponse();
      if (await throttled(request, 'forgot')) return loginError('too-many-attempts');
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      const email = stringField(form, 'email');
      const provider = await localProvider();
      // One answer whatever the address, whether the instance sends mail or not: the
      // page said beforehand what to expect. A link is made only for an existing account
      // and only when a mail can carry it; nothing is ever shown here.
      if (provider && deps.mailer) {
        const account = await deps.accounts.accountOf(provider.id, email);
        if (account) {
          try {
            const issued = await deps.accounts.createLink({
              kind: 'reset',
              providerId: provider.id,
              email: account.email,
              createdBy: 'self',
            });
            await deps.mailer.sendLink({
              kind: 'reset',
              to: account.email,
              url: issued.url,
              expiresAt: issued.link.expiresAt,
            });
          } catch (err) {
            logger.error('password reset mail failed', { err });
          }
        }
      }
      return redirect(`${FORGOT_PASSWORD_PAGE}?${FORGOT_SENT_PARAM}=1`);
    },

    async beginSecondFactor(request) {
      const guard = await guardMutation(request, deps, 'user');
      if (!guard.ok) return refusalResponse(guard, OPERATOR_REFUSALS);
      const who = guard.principal;
      const enrolment = deps.secondFactors.beginEnrolment(deps.instanceLabel, who.user.email);
      const step = await deps.sessions.createLocalStep({
        step: 'enrol',
        providerId: who.providerId ?? '',
        userId: who.user.id,
        login: { email: who.user.email, groups: [] },
        returnTo: SECURITY_PAGE,
        totpSecret: enrolment.secret,
      });
      return redirect(`${SECURITY_PAGE}?${ENROL_PARAM}=1`, { 'Set-Cookie': step.setCookie });
    },

    async confirmSecondFactor(request) {
      const guard = await guardMutation(request, deps, 'user');
      if (!guard.ok) return refusalResponse(guard, OPERATOR_REFUSALS);
      const who = guard.principal;
      const step = await deps.sessions.takeLocalStep(request.headers);
      const clear = deps.sessions.clearPendingCookie();
      if (step?.step !== 'enrol' || step.userId !== who.user.id || !step.totpSecret) {
        return redirectWithNotice(who.sessionId, SECURITY_PAGE, {
          tone: 'danger',
          title: 'Enrolment expired',
          lines: ['Start again: the secret shown is no longer the one to confirm.'],
        });
      }
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      const confirmed = await deps.secondFactors.confirmEnrolment(
        who.user,
        step.totpSecret,
        stringField(form, 'code'),
        who.user.id,
      );
      if (!confirmed) {
        const again = await deps.sessions.createLocalStep(step);
        const notice: Notice = {
          tone: 'danger',
          title: 'Code not accepted',
          lines: ['Enter the current code of the authenticator app, for the entry you just added.'],
        };
        const id = await notices.put(who.sessionId, notice);
        return redirect(`${SECURITY_PAGE}?${ENROL_PARAM}=1&notice=${encodeURIComponent(id)}`, {
          'Set-Cookie': again.setCookie,
        });
      }
      const id = await codesNotice(who.sessionId, confirmed.recoveryCodes, 'Second factor set up');
      return redirect(`${SECURITY_PAGE}?notice=${encodeURIComponent(id)}`, {
        'Set-Cookie': clear,
      });
    },

    async removeSecondFactor(request) {
      const guard = await guardMutation(request, deps, 'user');
      if (!guard.ok) return refusalResponse(guard, OPERATOR_REFUSALS);
      const who = guard.principal;
      const session = await deps.sessions.read(request.headers);
      const createdAt = session ? Date.parse(session.record.createdAt) : NaN;
      const fresh =
        Number.isFinite(createdAt) &&
        deps.clock.now().getTime() - createdAt < FRESH_SIGN_IN_FOR_FACTOR_MS;
      if (!fresh) {
        return redirectWithNotice(who.sessionId, SECURITY_PAGE, {
          tone: 'danger',
          title: 'Sign in again first',
          lines: [
            'Removing the second factor needs a session opened in the last ten minutes. Sign out, sign in again, then remove it.',
          ],
        });
      }
      if (who.isOperator) {
        return redirectWithNotice(who.sessionId, SECURITY_PAGE, {
          tone: 'danger',
          title: 'Administrators keep a second factor',
          lines: ['You administer this gateway: replace the second factor instead of removing it.'],
        });
      }
      await deps.secondFactors.reset(who.user, who.user.id);
      return redirectWithNotice(who.sessionId, SECURITY_PAGE, {
        tone: 'success',
        title: 'Second factor removed',
        lines: [
          'Your next sign-in asks you to set one up again, unless your sign-in provider’s own second factor stands in for it.',
        ],
      });
    },

    async changePassword(request) {
      const who = await localUserOf(request);
      if (!who.ok) return who.response;
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      const local = await localProvider();
      const current = stringField(form, 'current_password');
      const password = stringField(form, 'password');
      if (password !== stringField(form, 'password_again')) {
        return redirectWithNotice(who.principal.sessionId, SECURITY_PAGE, {
          tone: 'danger',
          title: 'Password not changed',
          lines: ['The two new passwords differ. Type the same one twice.'],
        });
      }
      const check = local
        ? await deps.accounts.checkPassword(local.id, who.principal.user.email, current)
        : { ok: false as const, cause: 'unknown' as const };
      if (!check.ok) {
        return redirectWithNotice(who.principal.sessionId, SECURITY_PAGE, {
          tone: 'danger',
          title: 'Password not changed',
          lines: ['The current password is not right, or the account is locked for a few minutes.'],
        });
      }
      try {
        await deps.accounts.changePassword(who.accountId, password, who.principal.user.id);
      } catch (err) {
        if (err instanceof LocalAccountError) {
          return redirectWithNotice(who.principal.sessionId, SECURITY_PAGE, {
            tone: 'danger',
            title: 'Password not changed',
            lines: [err.sentence],
          });
        }
        throw err;
      }
      return redirectWithNotice(who.principal.sessionId, SECURITY_PAGE, {
        tone: 'success',
        title: 'Password changed',
        lines: ['Your open sessions stay open; the next sign-in takes the new password.'],
      });
    },
  };
}
