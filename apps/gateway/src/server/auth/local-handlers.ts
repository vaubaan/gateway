/**
 * The anonymous forms of the local accounts (ADR local-accounts-sign-in-provider):
 *
 *   POST /auth/local/<provider>      email + password → a session, or `/login?error=`
 *   POST /api/account/create         an invitation link's token + a password → the
 *                                    account, then the same sign-in
 *   POST /api/account/reset          a reset link's token + a password → `/login`
 *   POST /api/account/forgot         an address → a reset link, mailed when the
 *                                    instance sends mail; one answer for every address
 *
 * Every form is origin-checked, rate-limited (`AUTH_LIMITS`) and answers with a
 * redirect; a refusal is a closed code in the query, never a sentence that says
 * whether an address exists. The sign-in itself is the one every provider gets:
 * `admit()` (the address must still be invited or named by the admin rule), then
 * `completeLogin()` (the `users` row, the deactivation check), then a session.
 */
import type { Logger } from '../logging';
import type { Store } from '../store';
import type { Clock } from '../store/clock';
import type { LocalAccountRecord } from '../store';
import type { AdminGroup, LocalSignInProvider } from '../config/sign-in';
import { admit } from './admission';
import type { IdentityClaims } from './claims';
import { LocalAccountError, LoginError } from './errors';
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
import type { SessionService } from './session-service';
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

/** What sends the mail of a link; absent when the instance sends no mail (wave C). */
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
  readonly sessions: SessionService;
  readonly providers: Pick<SignInProvidersService, 'resolve' | 'views' | 'adminRule'>;
  readonly accounts: LocalAccountsService;
  readonly login: LoginDeps;
  readonly store: Pick<Store, 'invitations'>;
  readonly adminEmails: readonly string[];
  readonly logger: Logger;
  readonly clock: Clock;
  readonly mailer?: LinkMailer;
}

export interface LocalAuthHandlers {
  passwordLogin(request: Request, providerId: string): Promise<Response>;
  createAccount(request: Request): Promise<Response>;
  resetPassword(request: Request): Promise<Response>;
  forgotPassword(request: Request): Promise<Response>;
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
    // The address was proven by the link that created the account, or named by the
    // admin rule for the first administrator.
    emailVerified: true,
    displayName: null,
    groups: [],
  };
}

export function createLocalAuthHandlers(deps: LocalAuthHandlerDeps): LocalAuthHandlers {
  const { logger } = deps;
  const admitted = createThrottle(deps);

  function redirect(path: string, headers: Record<string, string> = {}): Response {
    return new Response(null, {
      status: SEE_OTHER,
      headers: { Location: path, 'Cache-Control': 'no-store', ...headers },
    });
  }

  function loginError(code: string): Response {
    return redirect(`${LOGIN_PAGE}?error=${encodeURIComponent(code)}`);
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

  /** Admission, the `users` row and the session: what every provider's sign-in ends with. */
  async function signIn(
    request: Request,
    provider: LocalSignInProvider,
    account: LocalAccountRecord,
    adminGroup: AdminGroup | null,
    returnTo: string,
  ): Promise<Response> {
    const identity = localIdentity(provider, account);
    const admission = await admit(identity, provider, {
      isInvited: async (email) => (await deps.store.invitations.get(email)) !== null,
      adminEmails: deps.adminEmails,
      adminGroup,
    });
    const rule = await deps.providers.adminRule();
    const outcome = await completeLogin(deps.login, identity, {
      providerId: provider.id,
      adminRule: rule,
    });
    await deps.sessions.destroy(request.headers);
    const session = await deps.sessions.create({
      kind: 'user',
      userId: outcome.user.id,
      login: { email: identity.email, groups: [], provider: provider.id },
    });
    logger.info('sign-in admitted', { provider: provider.id, admission });
    return redirect(returnTo, { 'Set-Cookie': session.setCookie });
  }

  function failLogin(err: unknown): Response {
    if (err instanceof LoginError) {
      logger.warn('sign-in failed', { code: err.code, detail: err.message });
      return loginError(err.code);
    }
    logger.error('sign-in failed unexpectedly', { err });
    return loginError('idp-error');
  }

  return {
    async passwordLogin(request, providerId) {
      if (!isSameOrigin(request.headers, deps.publicUrl)) return forbiddenOriginResponse();
      if (
        !(await admitted(
          request,
          'password',
          AUTH_LIMITS.passwordPerAddress,
          AUTH_LIMITS.passwordPerInstance,
        ))
      ) {
        return loginError('too-many-attempts');
      }
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
        const rule = await deps.providers.adminRule();
        return await signIn(request, provider, check.account, rule.group, returnTo);
      } catch (err) {
        return failLogin(err);
      }
    },

    async createAccount(request) {
      if (!isSameOrigin(request.headers, deps.publicUrl)) return forbiddenOriginResponse();
      if (
        !(await admitted(
          request,
          'password',
          AUTH_LIMITS.passwordPerAddress,
          AUTH_LIMITS.passwordPerInstance,
        ))
      ) {
        return loginError('too-many-attempts');
      }
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
        const rule = await deps.providers.adminRule();
        return await signIn(request, provider, account, rule.group, '/');
      } catch (err) {
        return failLogin(err);
      }
    },

    async resetPassword(request) {
      if (!isSameOrigin(request.headers, deps.publicUrl)) return forbiddenOriginResponse();
      if (
        !(await admitted(
          request,
          'password',
          AUTH_LIMITS.passwordPerAddress,
          AUTH_LIMITS.passwordPerInstance,
        ))
      ) {
        return loginError('too-many-attempts');
      }
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
      if (
        !(await admitted(
          request,
          'forgot',
          AUTH_LIMITS.forgotPerAddress,
          AUTH_LIMITS.forgotPerInstance,
        ))
      ) {
        return loginError('too-many-attempts');
      }
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
  };
}
