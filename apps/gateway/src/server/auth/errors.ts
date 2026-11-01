/**
 * Errors of the human-authentication module. A `LoginError` carries a closed
 * code the login page can render; the message is for the server log only
 * (it may name the IdP's error) and never reaches the browser.
 */

export const LOGIN_ERROR_CODES = [
  'idp-not-configured',
  'provider-unknown',
  'provider-disabled',
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
  'password-refused',
  'second-factor-refused',
  'second-factor-locked',
  'second-factor-required',
  'user-limit-reached',
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
  'provider-disabled':
    'This sign-in provider is switched off on this gateway. Choose one of the providers below, or ask an administrator.',
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
  'password-refused':
    'The email address or the password is not right, or the account is locked for a few minutes after too many attempts.',
  'second-factor-refused':
    'The code was not accepted. Enter the current code of your authenticator app, or a recovery code.',
  'second-factor-locked':
    'Too many wrong codes were entered for this account. Wait fifteen minutes, then sign in again.',
  'second-factor-required':
    'This account administers the gateway and needs a second factor: the sign-in continues with its enrolment.',
  'user-limit-reached':
    'This gateway already holds as many people as its ceiling allows, so it admits nobody new. Ask an administrator to make room or to raise the ceiling, then sign in again.',
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

/** A local-account act refused (ADR local-accounts-sign-in-provider): a closed code and its sentence. */
export const LOCAL_ACCOUNT_ERROR_CODES = [
  'no-local-provider',
  'link-invalid',
  'account-exists',
  'account-not-found',
  'password-weak',
  'address-invalid',
  'not-admitted',
] as const;
export type LocalAccountErrorCode = (typeof LOCAL_ACCOUNT_ERROR_CODES)[number];

export const LOCAL_ACCOUNT_ERROR_MESSAGES: Readonly<Record<LocalAccountErrorCode, string>> = {
  'no-local-provider': 'This gateway keeps no local accounts.',
  'link-invalid':
    'This link is not valid any more: it was used, it expired, or a newer one replaced it. Ask for another one.',
  'account-exists': 'An account already exists for this address. Sign in, or reset its password.',
  'account-not-found': 'No local account has this address.',
  'password-weak': 'The password is too short or too long.',
  'address-invalid': 'This is not an email address.',
  'not-admitted':
    'This address is not invited to this gateway any more. Ask an administrator to invite it again.',
};

export class LocalAccountError extends Error {
  readonly code: LocalAccountErrorCode;
  /** The sentence for the form: the code's, or a more precise one (a password's problem). */
  readonly sentence: string;
  constructor(code: LocalAccountErrorCode, sentence?: string) {
    super(sentence ? `${code}: ${sentence}` : code);
    this.name = 'LocalAccountError';
    this.code = code;
    this.sentence = sentence ?? LOCAL_ACCOUNT_ERROR_MESSAGES[code];
  }
}
