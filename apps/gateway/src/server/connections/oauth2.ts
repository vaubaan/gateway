/**
 * The generic OAuth 2.0 client of the host, driven entirely by a plugin's
 * `OAuth2CredentialSpec` (ADR plugin-contract-and-credential-spec D2):
 *
 *   - the authorization request (RFC 6749 §4.1.1) with PKCE S256 (RFC 7636)
 *     and the resource indicator (RFC 8707) when the spec asks for them;
 *   - the code exchange (§4.1.3);
 *   - the `refresh_token` grant (§6), with rotation of the refresh token.
 *
 * Client authentication follows `clientAuthMethod` (§2.3.1): HTTP Basic with
 * form-encoded credentials, credentials in the body, or none for a public
 * client. The client secret is used here and nowhere else: plugins never
 * receive it.
 *
 * Nothing is read from the environment and no URL is written here: the
 * endpoints come from the spec, the redirect URI from the caller (built on
 * `public_url`), `fetch` is injected.
 */
import { createHash, randomBytes } from 'node:crypto';

import type {
  OAuth2ClientAuthMethod,
  OAuth2CredentialSpec,
  OAuth2Secret,
} from '@vaubaan/plugin-sdk';

import { oneLine } from './errors';

const STATE_BYTES = 32;
const VERIFIER_BYTES = 32;
const MS_PER_SECOND = 1000;
/** A token endpoint that does not answer within this delay is unreachable. */
export const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

/** Parameters the host sets itself; `extraAuthorizationParams` can never override them. */
const RESERVED_AUTHORIZATION_PARAMS = new Set([
  'response_type',
  'client_id',
  'redirect_uri',
  'scope',
  'state',
  'code_challenge',
  'code_challenge_method',
  'resource',
]);

/** OAuth error codes meaning "this grant or client is no longer accepted" (RFC 6749 §5.2). */
const REJECTED_GRANT_ERRORS = new Set([
  'invalid_grant',
  'invalid_client',
  'unauthorized_client',
  'invalid_token',
  'access_denied',
]);

export interface OAuth2Client {
  readonly clientId: string;
  /** `null` for a public client (`clientAuthMethod: 'none'`). */
  readonly clientSecret: string | null;
}

export interface OAuth2Io {
  readonly fetch: typeof fetch;
  readonly now: () => Date;
}

/**
 * What a token request needs to know about the endpoint. An
 * `OAuth2CredentialSpec` is one; so is the `userVerification` block of an
 * `app-install` spec (`install-verification.ts`).
 */
export interface TokenEndpoint {
  readonly tokenUrl: string;
  readonly clientAuthMethod: OAuth2ClientAuthMethod;
  readonly resourceIndicator?: string;
}

/** Opaque, unguessable, URL-safe: the single-use nonce of a flow (`state`). */
export function newState(): string {
  return randomBytes(STATE_BYTES).toString('base64url');
}

export function newCodeVerifier(): string {
  return randomBytes(VERIFIER_BYTES).toString('base64url');
}

export function codeChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export interface AuthorizationRequest {
  readonly redirectUri: string;
  readonly state: string;
  /** Required when `spec.pkce` is true. */
  readonly codeVerifier: string | null;
}

export function buildAuthorizationUrl(
  spec: OAuth2CredentialSpec,
  client: OAuth2Client,
  request: AuthorizationRequest,
): URL {
  const url = new URL(spec.authorizationUrl);
  for (const [name, value] of Object.entries(spec.extraAuthorizationParams ?? {})) {
    if (!RESERVED_AUTHORIZATION_PARAMS.has(name)) url.searchParams.set(name, value);
  }
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', request.redirectUri);
  if (spec.scopes.length > 0) url.searchParams.set('scope', spec.scopes.join(' '));
  url.searchParams.set('state', request.state);
  if (spec.pkce) {
    if (!request.codeVerifier) throw new Error('oauth2: PKCE is required but no verifier was made');
    url.searchParams.set('code_challenge', codeChallengeS256(request.codeVerifier));
    url.searchParams.set('code_challenge_method', 'S256');
  }
  if (spec.resourceIndicator) url.searchParams.set('resource', spec.resourceIndicator);
  return url;
}

/**
 * A token endpoint answered with an error, or could not be reached.
 * `rejected` separates "the grant is dead" (reconnect needed) from a
 * transient failure (retry later, nothing to change).
 */
export class OAuth2TokenError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 when no response was received. */
    readonly status: number,
    readonly oauthError: string | null,
    readonly rejected: boolean,
  ) {
    super(message);
    this.name = 'OAuth2TokenError';
  }
}

export interface CodeExchange {
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string | null;
}

export async function exchangeCode(
  spec: OAuth2CredentialSpec,
  client: OAuth2Client,
  exchange: CodeExchange,
  io: OAuth2Io,
): Promise<OAuth2Secret> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: exchange.code,
    redirect_uri: exchange.redirectUri,
  });
  if (spec.pkce) {
    // The same rule as the authorization request: never rely on the provider to notice.
    if (!exchange.codeVerifier) {
      throw new Error('oauth2: PKCE is required but the flow has no verifier');
    }
    body.set('code_verifier', exchange.codeVerifier);
  }
  const token = await tokenRequest(spec, client, body, io);
  return {
    kind: 'oauth2',
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresAt,
    scopes: token.scopes ?? [...spec.scopes],
    metadata: {},
  };
}

/**
 * Exchanges an authorization code the host did not ask for itself: the
 * provider started the authorization from its own installation page, so no
 * `redirect_uri` and no PKCE verifier were sent and none is replayed
 * (RFC 6749 §4.1.3: `redirect_uri` is required only when the authorization
 * request carried one). Returns the access token and nothing else — the
 * caller uses it once and drops it.
 */
export async function exchangeUnsolicitedCode(
  endpoint: TokenEndpoint,
  client: OAuth2Client,
  code: string,
  io: OAuth2Io,
): Promise<string> {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code });
  return (await tokenRequest(endpoint, client, body, io)).accessToken;
}

/**
 * The standard `refresh_token` grant. The provider may rotate the refresh
 * token (Supabase, Railway): the new one replaces the old; when the response
 * carries none, the current one stays valid (RFC 6749 §6).
 */
export async function refreshGrant(
  spec: OAuth2CredentialSpec,
  client: OAuth2Client,
  current: OAuth2Secret,
  io: OAuth2Io,
): Promise<OAuth2Secret> {
  if (!current.refreshToken) {
    throw new OAuth2TokenError('no refresh token is stored for this connection', 0, null, true);
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: current.refreshToken,
  });
  const token = await tokenRequest(spec, client, body, io);
  return {
    kind: 'oauth2',
    accessToken: token.accessToken,
    refreshToken: token.refreshToken ?? current.refreshToken,
    expiresAt: token.expiresAt,
    scopes: token.scopes ?? current.scopes,
    metadata: current.metadata,
  };
}

interface TokenResponse {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: string | null;
  readonly scopes: string[] | null;
}

async function tokenRequest(
  spec: TokenEndpoint,
  client: OAuth2Client,
  body: URLSearchParams,
  io: OAuth2Io,
): Promise<TokenResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  if (spec.resourceIndicator) body.set('resource', spec.resourceIndicator);
  switch (spec.clientAuthMethod) {
    case 'client_secret_basic':
      headers.Authorization = basicAuth(client.clientId, requireSecret(client));
      break;
    case 'client_secret_post':
      body.set('client_id', client.clientId);
      body.set('client_secret', requireSecret(client));
      break;
    case 'none':
      body.set('client_id', client.clientId);
      break;
  }

  let response: Response;
  try {
    response = await io.fetch(spec.tokenUrl, {
      method: 'POST',
      headers,
      body: body.toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new OAuth2TokenError(`token endpoint unreachable: ${oneLine(reason)}`, 0, null, false);
  }

  const payload = await readJsonObject(response);
  const oauthError = typeof payload?.error === 'string' ? payload.error : null;
  if (!response.ok || oauthError) {
    const description =
      typeof payload?.error_description === 'string' ? payload.error_description : null;
    const what = [oauthError, description].filter(Boolean).join(': ');
    const rejected =
      (oauthError !== null && REJECTED_GRANT_ERRORS.has(oauthError)) ||
      response.status === 400 ||
      response.status === 401 ||
      response.status === 403;
    throw new OAuth2TokenError(
      oneLine(`token endpoint answered ${response.status}${what ? ` (${what})` : ''}`),
      response.status,
      oauthError,
      rejected,
    );
  }
  if (!payload || typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
    throw new OAuth2TokenError(
      `token endpoint answered ${response.status} without an access token`,
      response.status,
      null,
      false,
    );
  }
  return {
    accessToken: payload.access_token,
    refreshToken:
      typeof payload.refresh_token === 'string' && payload.refresh_token.length > 0
        ? payload.refresh_token
        : null,
    expiresAt: expiryFrom(payload.expires_in, io.now()),
    scopes: scopesFrom(payload.scope),
  };
}

function requireSecret(client: OAuth2Client): string {
  if (!client.clientSecret) throw new Error('oauth2: this client authenticates with a secret');
  return client.clientSecret;
}

/** RFC 6749 §2.3.1: id and secret are form-encoded before the Basic encoding. */
function basicAuth(clientId: string, clientSecret: string): string {
  const pair = `${formEncode(clientId)}:${formEncode(clientSecret)}`;
  return `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`;
}

function formEncode(value: string): string {
  return new URLSearchParams({ v: value }).toString().slice(2);
}

async function readJsonObject(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await response.text());
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function expiryFrom(expiresIn: unknown, now: Date): string | null {
  const seconds = typeof expiresIn === 'string' ? Number(expiresIn) : expiresIn;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(now.getTime() + seconds * MS_PER_SECOND).toISOString();
}

/** `scope` is space-delimited by the RFC; some providers answer comma-delimited. */
function scopesFrom(scope: unknown): string[] | null {
  if (typeof scope !== 'string') return null;
  const scopes = scope.split(/[\s,]+/).filter((s) => s.length > 0);
  return scopes.length > 0 ? scopes : null;
}
