/**
 * Errors of the connect flows. A `ConnectError` carries a closed code (what the
 * UI keys its sentence on), an HTTP status, and an optional `detail` that is
 * safe to show to the connecting user: a validation sentence, the provider's
 * status in the gateway's own words (`providerFailureReason`), or a refusal
 * the plugin wrote itself (`CredentialRefusal`) — never the provider's text,
 * never a credential, never a token.
 */
import type { ConnectionStatus } from '@vaubaan/shared';

export const CONNECT_ERROR_CODES = [
  'provider-unknown',
  'invalid-input',
  'return-url-refused',
  'rate-limited',
  'state-invalid',
  'provider-denied',
  'token-exchange-failed',
  'client-registration-failed',
  'broker-not-configured',
  'broker-failed',
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
  'connection-limit-reached',
] as const;

export type ConnectErrorCode = (typeof CONNECT_ERROR_CODES)[number];

export const CONNECT_ERROR_MESSAGES: Readonly<Record<ConnectErrorCode, string>> = {
  'provider-unknown': 'This service is not available on this gateway.',
  'invalid-input': 'Some values are missing or do not have the expected format.',
  'return-url-refused': 'The return address is outside this gateway and was refused.',
  'rate-limited': 'Too many attempts to connect. Wait a minute and retry.',
  'state-invalid':
    'This authorization attempt has expired, was already used, or was started by another session. Start again from Accounts.',
  'provider-denied': 'The service did not grant the authorization.',
  'token-exchange-failed': 'The service refused to exchange the authorization for a credential.',
  'client-registration-failed':
    'The service refused to register this gateway as one of its apps. Retry in a moment; if it keeps refusing, the service may not allow new apps for your organisation.',
  'broker-not-configured':
    'This service is connected through an OAuth broker, and this gateway is enrolled with none for it. An administrator configures one (oauth_brokers).',
  'broker-failed':
    'The OAuth broker this gateway is enrolled with could not complete the connection. Retry in a moment; if it keeps failing, tell an administrator.',
  'credential-rejected': 'The service rejected this credential.',
  'provider-unreachable': 'The service could not be reached. Retry in a moment.',
  'not-found': 'This account does not exist or is not yours.',
  'connection-revoked': 'This account is disconnected, for good. Connect a new one.',
  'connection-unowned':
    'This account has no owner any more. It keeps serving its missions, but it cannot be reconnected until an administrator names a new owner.',
  'provider-mismatch': 'This account belongs to another service.',
  'label-read-only': 'The environment of this resource is set by the service and cannot be edited.',
  'transfer-not-member':
    'An account can only be transferred to a team you belong to: you would otherwise lose it by mistake.',
  'not-ownerless':
    'This account still has an owner. An administrator only names an owner for an account that has none left.',
  'owner-unknown':
    'Nobody active has this email. A person is known to the gateway once they have signed in.',
  'owner-group-empty':
    'This team does not exist or has no member: the account would still have no owner.',
  'connection-limit-reached':
    'This gateway holds as many connected accounts as its ceiling allows: nothing was connected. An account disconnected for good frees a place; an administrator can raise the ceiling.',
};

const STATUS_BY_CODE: Readonly<Record<ConnectErrorCode, number>> = {
  'provider-unknown': 404,
  'invalid-input': 400,
  'return-url-refused': 400,
  'rate-limited': 429,
  'state-invalid': 400,
  'provider-denied': 400,
  'token-exchange-failed': 502,
  'client-registration-failed': 502,
  'broker-not-configured': 409,
  'broker-failed': 502,
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
  'connection-limit-reached': 409,
};

const MAX_DETAIL_CHARS = 300;

/**
 * Is this a `ConnectError` (of that code, when one is given)? By shape, not by
 * `instanceof`, for the pages: a page is bundled apart from the code that built the
 * composition root, so the class it imports is not the one the service threw.
 */
export function isConnectError(err: unknown, code?: ConnectErrorCode): boolean {
  if (!(err instanceof Error) || err.name !== 'ConnectError' || !('code' in err)) return false;
  return code === undefined || err.code === code;
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

/**
 * The OAuth broker of a brokered connection is down, slow, refused the call or
 * is no longer configured (ADR google-calendar-through-an-oauth-broker, "the
 * connection shows the broker's failure, not an expiry"): nothing changed,
 * retry later. A `ProviderUnreachableError`, so every caller that leaves the
 * connection alone on a transient failure does so here too.
 */
export class OAuthBrokerUnavailableError extends ProviderUnreachableError {
  constructor(
    readonly broker: string,
    message: string,
  ) {
    super(message);
    this.name = 'OAuthBrokerUnavailableError';
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
