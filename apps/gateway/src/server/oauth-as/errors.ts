/**
 * Errors of the authorization server, each answered its own way:
 *
 * - `OAuthProtocolError` — a JSON error of the token, registration and
 *   revocation endpoints (RFC 6749 §5.2, RFC 7591 §3.2.2);
 * - `AuthorizationPageError` — the authorization request cannot be trusted
 *   enough to redirect (unknown client, unregistered redirect URI): the human
 *   reads a page, the client receives nothing (OAuth 2.1 §4.1.2.1);
 * - `AuthorizationRedirectError` — the client and its redirect URI are known:
 *   the error goes back to the client through the redirect.
 *
 * The description is written for whoever debugs the client; it never carries a
 * token, a code or a secret.
 */

export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'unsupported_response_type'
  | 'invalid_scope'
  | 'invalid_target'
  | 'access_denied'
  | 'invalid_redirect_uri'
  | 'invalid_client_metadata'
  | 'slow_down'
  | 'server_error';

const BAD_REQUEST = 400;
const UNAUTHORIZED = 401;

export class OAuthProtocolError extends Error {
  readonly status: number;

  constructor(
    readonly code: OAuthErrorCode,
    description: string,
    status?: number,
    /** Set on a `slow_down`: the `Retry-After` of the response, in seconds. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(description);
    this.name = 'OAuthProtocolError';
    this.status = status ?? (code === 'invalid_client' ? UNAUTHORIZED : BAD_REQUEST);
  }
}

const TOO_MANY_REQUESTS = 429;
const MS_PER_SECOND = 1000;

/** The `slow_down` of an exhausted rate limit (429 with `Retry-After`). */
export function slowDown(retryAfterMs: number): OAuthProtocolError {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / MS_PER_SECOND));
  return new OAuthProtocolError(
    'slow_down',
    `too many requests; retry in ${seconds} s`,
    TOO_MANY_REQUESTS,
    seconds,
  );
}

export class AuthorizationPageError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    message: string,
  ) {
    super(message);
    this.name = 'AuthorizationPageError';
  }
}

export class AuthorizationRedirectError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    description: string,
    /** False when the `state` itself is what was refused: it is then not sent back. */
    readonly echoState = true,
  ) {
    super(description);
    this.name = 'AuthorizationRedirectError';
  }
}
