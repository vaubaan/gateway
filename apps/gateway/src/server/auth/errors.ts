/**
 * Errors of the human-authentication module. A `LoginError` carries a closed
 * code the login page can render; the message is for the server log only
 * (it may name the IdP's error) and never reaches the browser.
 */

export const LOGIN_ERROR_CODES = [
  'idp-not-configured',
  'discovery-failed',
  'login-expired',
  'state-mismatch',
  'idp-error',
  'claims-missing',
  'email-not-verified',
  'email-domain-not-allowed',
  'groups-overage',
  'account-deactivated',
  'bootstrap-refused',
  'bootstrap-unavailable',
] as const;
export type LoginErrorCode = (typeof LOGIN_ERROR_CODES)[number];

export function isLoginErrorCode(raw: string): raw is LoginErrorCode {
  return (LOGIN_ERROR_CODES as readonly string[]).includes(raw);
}

/** What the login page says for each code. One sentence, no IdP detail. */
export const LOGIN_ERROR_MESSAGES: Readonly<Record<LoginErrorCode, string>> = {
  'idp-not-configured': 'No identity provider is configured on this instance yet.',
  'discovery-failed':
    'The identity provider could not be reached. Try again or contact the operator.',
  'login-expired': 'The sign-in attempt expired. Start again.',
  'state-mismatch': 'The sign-in response did not match the attempt that started it. Start again.',
  'idp-error': 'The identity provider refused the sign-in.',
  'claims-missing': 'The identity provider did not return the claims this instance requires.',
  'email-not-verified':
    'The identity provider has not verified this email address. Verify it there, then sign in again.',
  'email-domain-not-allowed': 'This email domain is not allowed on this instance.',
  'groups-overage':
    'Your account belongs to more groups than the identity provider puts in a sign-in token, so this instance cannot read them and refuses the sign-in rather than ignore them. Ask the operator: the groups claim must be limited to the groups assigned to this application.',
  'account-deactivated':
    'This account was deactivated on this instance by an operator. Ask an operator to reactivate it.',
  'bootstrap-refused': 'The bootstrap token was not accepted.',
  'bootstrap-unavailable': 'Bootstrap sign-in is no longer available on this instance.',
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
