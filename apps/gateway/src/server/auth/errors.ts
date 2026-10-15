/**
 * Errors of the human-authentication module. A `LoginError` carries a closed
 * code the login page can render; the message is for the server log only
 * (it may name the IdP's error) and never reaches the browser.
 */

export const LOGIN_ERROR_CODES = [
  'idp-not-configured',
  'provider-unknown',
  'discovery-failed',
  'login-expired',
  'state-mismatch',
  'idp-error',
  'claims-missing',
  'email-not-verified',
  'email-domain-not-allowed',
  'not-invited',
  'groups-overage',
  'groups-unavailable',
  'account-deactivated',
  'bootstrap-refused',
  'bootstrap-unavailable',
  'too-many-attempts',
] as const;
export type LoginErrorCode = (typeof LOGIN_ERROR_CODES)[number];

export function isLoginErrorCode(raw: string): raw is LoginErrorCode {
  return (LOGIN_ERROR_CODES as readonly string[]).includes(raw);
}

/** What the login page says for each code. One sentence, no IdP detail. */
export const LOGIN_ERROR_MESSAGES: Readonly<Record<LoginErrorCode, string>> = {
  'idp-not-configured': 'No identity provider is configured on this gateway yet.',
  'provider-unknown':
    'This sign-in provider is not offered by this gateway (any more). Choose one of the providers below.',
  'discovery-failed':
    'The identity provider could not be reached. Try again or contact the administrator of this gateway.',
  'login-expired': 'The sign-in attempt expired. Start again.',
  'state-mismatch': 'The sign-in response did not match the attempt that started it. Start again.',
  'idp-error': 'The identity provider refused the sign-in.',
  'claims-missing': 'The identity provider did not return the claims this gateway requires.',
  'email-not-verified':
    'The identity provider has not verified this email address. Verify it there, then sign in again.',
  'email-domain-not-allowed':
    'This email domain is not allowed on this gateway, and the address is not invited. Ask an administrator to invite it.',
  'not-invited':
    'This address is not invited to this gateway. Ask an administrator to invite it, then sign in again.',
  'groups-overage':
    'Your account belongs to more groups than the identity provider puts in a sign-in token, so this gateway cannot read them and refuses the sign-in rather than ignore them. Ask the administrator: the groups claim must be limited to the groups assigned to this application.',
  'groups-unavailable':
    'The identity provider did not return your groups this time, so this gateway refuses the sign-in rather than sign you in without them. Try again in a moment; if it keeps happening, tell the administrator.',
  'account-deactivated':
    'This account was deactivated on this gateway by an administrator. Ask an administrator to reactivate it.',
  'bootstrap-refused': 'The bootstrap token was not accepted.',
  'bootstrap-unavailable': 'Bootstrap sign-in is no longer available on this gateway.',
  'too-many-attempts':
    'Too many sign-in attempts reached this gateway in the last minutes. Wait a few minutes, then try again.',
};

export class LoginError extends Error {
  readonly code: LoginErrorCode;
  constructor(code: LoginErrorCode, detail?: string, options?: { cause?: unknown }) {
    super(detail ? `${code}: ${detail}` : code, options);
    this.name = 'LoginError';
    this.code = code;
  }
}

/** Invalid operator input on the identity-provider form: one message per problem. */
export class IdpSettingsError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`invalid identity provider settings: ${problems.join('; ')}`);
    this.name = 'IdpSettingsError';
    this.problems = problems;
  }
}
