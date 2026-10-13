/**
 * Errors of the connect flows. A `ConnectError` carries a closed code (what the
 * UI keys its sentence on), an HTTP status, and an optional `detail` that is
 * safe to show to the connecting user: the provider's own error message or a
 * validation sentence — never a credential, never a token.
 */
import type { ConnectionStatus } from '@vaubaan/shared';

export const CONNECT_ERROR_CODES = [
  'provider-unknown',
  'app-not-configured',
  'invalid-input',
  'return-url-refused',
  'rate-limited',
  'state-invalid',
  'provider-denied',
  'token-exchange-failed',
  'installation-not-verified',
  'installation-unverifiable',
  'credential-rejected',
  'provider-unreachable',
  'not-found',
  'connection-revoked',
  'connection-unowned',
  'provider-mismatch',
  'label-read-only',
  'transfer-not-member',
  'not-ownerless',
  'owner-unknown',
  'owner-group-empty',
] as const;

export type ConnectErrorCode = (typeof CONNECT_ERROR_CODES)[number];

export const CONNECT_ERROR_MESSAGES: Readonly<Record<ConnectErrorCode, string>> = {
  'provider-unknown': 'This provider is not available on this instance.',
  'app-not-configured':
    'An operator must register the company app for this provider first (Administration → Provider apps).',
  'invalid-input': 'Some values are missing or do not have the expected format.',
  'return-url-refused': 'The return address is outside this instance and was refused.',
  'rate-limited': 'Too many connection attempts. Wait a minute and retry.',
  'state-invalid':
    'This authorization attempt has expired, was already used, or was started by another session. Start again from Connections.',
  'provider-denied': 'The provider did not grant the authorization.',
  'token-exchange-failed': 'The provider refused to exchange the authorization for a credential.',
  'installation-not-verified':
    'The provider did not confirm that your account has access to this installation; nothing was connected.',
  'installation-unverifiable':
    'This provider cannot prove who performed an installation. An operator must explicitly accept unverified installations for it (Administration → Provider apps).',
  'credential-rejected': 'The provider rejected this credential.',
  'provider-unreachable': 'The provider could not be reached. Retry in a moment.',
  'not-found': 'This connection does not exist or is not yours.',
  'connection-revoked': 'This connection is revoked; revocation is final. Create a new connection.',
  'connection-unowned':
    'This connection has no owner any more. It keeps serving its missions, but it cannot be reconnected until an operator reassigns an owner.',
  'provider-mismatch': 'This connection belongs to another provider.',
  'label-read-only':
    'The environment of this resource is set by the provider plugin and cannot be edited.',
  'transfer-not-member':
    'A connection can only be transferred to a group you belong to: you would otherwise lose it by mistake.',
  'not-ownerless':
    'This connection still has an owner. An operator only reassigns a connection that has none left.',
  'owner-unknown':
    'No active user has this email. A user is known to the instance once they have signed in.',
  'owner-group-empty':
    'This group does not exist or has no member: the connection would still have no owner.',
};

const STATUS_BY_CODE: Readonly<Record<ConnectErrorCode, number>> = {
  'provider-unknown': 404,
  'app-not-configured': 409,
  'invalid-input': 400,
  'return-url-refused': 400,
  'rate-limited': 429,
  'state-invalid': 400,
  'provider-denied': 400,
  'token-exchange-failed': 502,
  'installation-not-verified': 403,
  'installation-unverifiable': 409,
  'credential-rejected': 400,
  'provider-unreachable': 502,
  'not-found': 404,
  'connection-revoked': 409,
  'connection-unowned': 409,
  'provider-mismatch': 409,
  'label-read-only': 409,
  'transfer-not-member': 403,
  'not-ownerless': 409,
  'owner-unknown': 400,
  'owner-group-empty': 400,
};

const MAX_DETAIL_CHARS = 300;

/**
 * Is this the `ConnectError` of that code? By shape, not by `instanceof`, for the pages:
 * a page is bundled apart from the code that built the composition root, so the class it
 * imports is not the one the service threw.
 */
export function isConnectError(err: unknown, code: ConnectErrorCode): boolean {
  return err instanceof Error && err.name === 'ConnectError' && 'code' in err && err.code === code;
}

export class ConnectError extends Error {
  readonly status: number;
  /** Shown to the user next to the code's sentence; truncated, single line. */
  readonly detail: string | null;

  constructor(
    readonly code: ConnectErrorCode,
    detail?: string | null,
    readonly retryAfterMs: number = 0,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ConnectError';
    this.status = STATUS_BY_CODE[code];
    this.detail = detail ? oneLine(detail) : null;
  }
}

/**
 * The connection cannot serve a call: it is `expired` or `revoked`, or gone (`missing`).
 * An `unowned` connection keeps serving (spec §2.3) and never raises this.
 */
export class ConnectionUnavailableError extends Error {
  constructor(
    readonly connectionId: string,
    readonly connectionStatus: ConnectionStatus | 'missing',
  ) {
    super(`connection ${connectionId} is ${connectionStatus}`);
    this.name = 'ConnectionUnavailableError';
  }
}

/** The provider did not answer a refresh (network, 5xx): nothing was changed, retry later. */
export class ProviderUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnreachableError';
  }
}

export function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_DETAIL_CHARS ? `${flat.slice(0, MAX_DETAIL_CHARS - 1)}…` : flat;
}

/** A message from an unknown thrown value, for a log line or a `detail`. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
