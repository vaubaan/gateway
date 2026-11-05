/**
 * The three calls the broker makes to a provider: exchange a code (RFC 6749
 * §4.1.3 with PKCE, RFC 7636), refresh (RFC 6749 §6), revoke (RFC 7009). The
 * client secret is added here and goes nowhere but the provider's compiled-in
 * endpoints. Answers are reduced to what the gateway needs; a provider's error
 * text is never kept.
 */
import { type ProviderDefinition } from './providers.ts';

export type Fetch = typeof fetch;

export interface ClientCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken: string | undefined;
  /** ISO-8601, or null when the provider gave no lifetime. */
  readonly expiresAt: string | null;
  readonly scopes: readonly string[] | undefined;
  /** The `email` of an ID token in the answer, if any. */
  readonly account: string | null;
}

/** `refused`: the provider said the grant is no good. `unavailable`: anything else. */
export type ProviderResult<T> =
  { ok: true; value: T } | { ok: false; reason: 'refused' | 'unavailable' };

const TIMEOUT_MS = 10_000;
const MAX_ANSWER_BYTES = 64 * 1024;

interface Answer {
  readonly status: number;
  readonly json: Record<string, unknown> | undefined;
}

async function post(
  fetchImpl: Fetch,
  url: string,
  form: Record<string, string>,
): Promise<Answer | undefined> {
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await response.text();
    if (body.length > MAX_ANSWER_BYTES) return { status: response.status, json: undefined };
    let json: unknown;
    try {
      json = body === '' ? undefined : JSON.parse(body);
    } catch {
      json = undefined;
    }
    const object =
      typeof json === 'object' && json !== null && !Array.isArray(json)
        ? (json as Record<string, unknown>)
        : undefined;
    return { status: response.status, json: object };
  } catch {
    return undefined;
  }
}

const MAX_ADDRESS_LENGTH = 320;
/** One `local@domain` and nothing around it: no space, no second `@`, no angle bracket. */
const ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

function addressClaim(value: unknown): string | null {
  return typeof value === 'string' && value.length <= MAX_ADDRESS_LENGTH && ADDRESS.test(value)
    ? value
    : null;
}

/**
 * The account an ID token received straight from the token endpoint over TLS
 * names: its `email` claim, or else its `preferred_username` when that is one
 * address. Microsoft puts `email` in the token only when the `email` scope was
 * asked and the tenant holds an address for the person; `preferred_username`
 * is the sign-in name, an address for personal accounts and most work ones.
 */
export function emailOf(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null;
  const payload = idToken.split('.')[1];
  if (payload === undefined) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof claims !== 'object' || claims === null) return null;
    const record = claims as Record<string, unknown>;
    if (typeof record.email === 'string') {
      return record.email.length <= MAX_ADDRESS_LENGTH ? record.email : null;
    }
    return addressClaim(record.preferred_username);
  } catch {
    return null;
  }
}

function tokenSet(json: Record<string, unknown>, now: number): TokenSet | undefined {
  const accessToken = json.access_token;
  if (typeof accessToken !== 'string' || accessToken === '') return undefined;
  const expiresIn = json.expires_in;
  const scope = json.scope;
  return {
    accessToken,
    refreshToken:
      typeof json.refresh_token === 'string' && json.refresh_token !== ''
        ? json.refresh_token
        : undefined,
    expiresAt:
      typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
        ? new Date(now + expiresIn * 1000).toISOString()
        : null,
    scopes: typeof scope === 'string' ? scope.split(' ').filter((s) => s !== '') : undefined,
    account: emailOf(json.id_token),
  };
}

function tokenResult(answer: Answer | undefined, now: number): ProviderResult<TokenSet> {
  if (answer === undefined) return { ok: false, reason: 'unavailable' };
  if (answer.status === 200 && answer.json !== undefined) {
    const value = tokenSet(answer.json, now);
    return value === undefined ? { ok: false, reason: 'unavailable' } : { ok: true, value };
  }
  // RFC 6749 §5.2: a code or a refresh token the provider no longer accepts.
  if (answer.status === 400 && answer.json?.error === 'invalid_grant')
    return { ok: false, reason: 'refused' };
  return { ok: false, reason: 'unavailable' };
}

export class OAuthClient {
  readonly #fetch: Fetch;
  readonly #now: () => number;

  constructor(fetchImpl: Fetch = fetch, now: () => number = Date.now) {
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  async exchangeCode(
    provider: ProviderDefinition,
    client: ClientCredentials,
    code: string,
    redirectUri: string,
    verifier: string,
  ): Promise<ProviderResult<TokenSet>> {
    const answer = await post(this.#fetch, provider.tokenEndpoint, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code_verifier: verifier,
    });
    return tokenResult(answer, this.#now());
  }

  async refresh(
    provider: ProviderDefinition,
    client: ClientCredentials,
    refreshToken: string,
  ): Promise<ProviderResult<TokenSet>> {
    const answer = await post(this.#fetch, provider.tokenEndpoint, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    });
    return tokenResult(answer, this.#now());
  }

  /**
   * Done, also when the provider says the token was already revoked or
   * unknown. A provider without a revocation endpoint (Microsoft) is done at
   * once, with no request: `relayed: false` says so to the caller's log.
   */
  async revoke(
    provider: ProviderDefinition,
    client: ClientCredentials,
    refreshToken: string,
  ): Promise<ProviderResult<{ readonly relayed: boolean }>> {
    if (provider.revokeEndpoint === undefined) return { ok: true, value: { relayed: false } };
    const answer = await post(this.#fetch, provider.revokeEndpoint, {
      token: refreshToken,
      token_type_hint: 'refresh_token',
      client_id: client.clientId,
      client_secret: client.clientSecret,
    });
    if (answer === undefined) return { ok: false, reason: 'unavailable' };
    if (answer.status === 200) return { ok: true, value: { relayed: true } };
    // Google answers 400 invalid_token for a token already revoked or expired.
    const error = answer.json?.error;
    if (answer.status === 400 && (error === 'invalid_token' || error === 'invalid_grant')) {
      return { ok: true, value: { relayed: true } };
    }
    return { ok: false, reason: 'unavailable' };
  }
}
