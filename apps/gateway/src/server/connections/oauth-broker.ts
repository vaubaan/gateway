/**
 * The gateway as the client of an OAuth broker (ADR
 * google-calendar-through-an-oauth-broker D1, D2). The contract — requests,
 * answers, status codes, the lifetime of a grant — is
 * docs/handbook/oauth-broker-contract.md; this file is its client side.
 *
 * Four calls, HTTPS and JSON, the broker key as a Bearer on every one:
 *
 *   POST   /flows                 → { authorize_url }       starts a flow
 *   POST   /grants/redeem         → { grant_id, access_token, expires_at, account, scopes }
 *   POST   /grants/<id>/token     → { access_token, expires_at, scopes }
 *   DELETE /grants/<id>           → 204                      revokes and forgets
 *
 * What the gateway keeps is the grant id and the current access token; the
 * provider's refresh token and the client secret stay with the broker. Nothing
 * here names who operates a broker: a broker is a URL and a key.
 *
 * Failures are `OAuthBrokerError`. `grantGone` separates "this grant is over"
 * (the broker no longer has it, or the provider refused it: the connection
 * must be reconnected) from a broker failure — down, slow, refusing the key,
 * answering something else — which changes nothing and is reported as the
 * broker's, never as an expiry. The message never quotes the broker's text:
 * only the call, the status and the protocol error code.
 */
import { createHash } from 'node:crypto';

import type { OAuthBrokerConfig } from '../config/types';
import { brokerFor } from '../config/oauth-brokers';

/** A broker that does not answer within this delay is unreachable. */
export const BROKER_REQUEST_TIMEOUT_MS = 15_000;

/** The broker's `error` code is a protocol token, never free text. */
const ERROR_CODE = /^[a-z_]{1,40}$/;
/** A grant id reaches a URL path: one segment of a safe alphabet. */
const GRANT_ID = /^[A-Za-z0-9_-]{8,128}$/;

/** The four calls, as the error messages name them. */
export type BrokerCall = 'flows' | 'redeem' | 'token' | 'revoke';

/**
 * Error codes of the contract that say the grant is over (handbook
 * oauth-broker-contract, "Errors"): the broker never had it or forgot it, the
 * provider refused its refresh token, or it was used, late, or bound to
 * another verifier or instance (redeem).
 */
const GRANT_GONE_CODES = new Set(['grant_not_found', 'grant_revoked', 'invalid_grant']);

export class OAuthBrokerError extends Error {
  constructor(
    message: string,
    readonly broker: string,
    readonly call: BrokerCall,
    /** HTTP status, or 0 when no answer was received. */
    readonly status: number,
    /** The contract's `error` code, when the broker sent a well-formed one. */
    readonly code: string | null,
    /** True when the grant is over: the connection needs reconnecting. */
    readonly grantGone: boolean,
  ) {
    super(message);
    this.name = 'OAuthBrokerError';
  }
}

export interface FlowRequest {
  /** The broker provider (`google`). */
  readonly provider: string;
  readonly scopes: readonly string[];
  /** `<public_url>/connections/callback/<plugin>`: must be on record at the broker. */
  readonly returnUrl: string;
  /** The single-use `state` the browser brings back with the grant. */
  readonly state: string;
  /** The PKCE verifier the gateway keeps; only its S256 challenge is sent. */
  readonly verifier: string;
}

export interface RedeemedGrant {
  readonly grantId: string;
  readonly accessToken: string;
  /** ISO-8601, or `null` when the broker does not say. */
  readonly expiresAt: string | null;
  /** The provider account the person signed in with (an email at Google), or `null`. */
  readonly account: string | null;
  readonly scopes: readonly string[];
}

export interface FreshToken {
  readonly accessToken: string;
  readonly expiresAt: string | null;
  /** `null` when the broker does not repeat them: the current ones stay. */
  readonly scopes: readonly string[] | null;
}

export interface OAuthBrokerIo {
  readonly fetch: typeof fetch;
}

/** RFC 7636 S256: what `POST /flows` carries instead of the verifier. */
export function challengeOf(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** One configured broker. */
export class OAuthBrokerClient {
  constructor(
    readonly config: OAuthBrokerConfig,
    private readonly io: OAuthBrokerIo,
  ) {}

  get name(): string {
    return this.config.name;
  }

  /** `POST /flows`: the provider's page to send the browser to. */
  async startFlow(request: FlowRequest): Promise<URL> {
    const body = await this.call('flows', 'POST', '/flows', {
      provider: request.provider,
      scopes: request.scopes,
      return_url: request.returnUrl,
      state: request.state,
      challenge: challengeOf(request.verifier),
      challenge_method: 'S256',
    });
    const raw = body?.authorize_url;
    let url: URL | null;
    try {
      url = typeof raw === 'string' ? new URL(raw) : null;
    } catch {
      url = null;
    }
    if (!url || url.protocol !== 'https:') {
      throw this.malformed('flows', 'no https authorize_url');
    }
    return url;
  }

  /** `POST /grants/redeem`: the one-time grant the browser came back with, for the grant and a token. */
  async redeem(grant: string, verifier: string): Promise<RedeemedGrant> {
    const body = await this.call('redeem', 'POST', '/grants/redeem', { grant, verifier });
    const grantId = body?.grant_id;
    const accessToken = body?.access_token;
    if (typeof grantId !== 'string' || !GRANT_ID.test(grantId)) {
      throw this.malformed('redeem', 'no well-formed grant_id');
    }
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw this.malformed('redeem', 'no access_token');
    }
    const account = body?.account;
    return {
      grantId,
      accessToken,
      expiresAt: expiryOf(body?.expires_at),
      account: typeof account === 'string' && account.length > 0 ? account.slice(0, 320) : null,
      scopes: scopesOf(body?.scopes) ?? [],
    };
  }

  /** `POST /grants/<id>/token`: a fresh access token for the same grant (the refresh). */
  async token(grantId: string): Promise<FreshToken> {
    const body = await this.call(
      'token',
      'POST',
      `/grants/${this.grantSegment(grantId, 'token')}/token`,
      {},
    );
    const accessToken = body?.access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw this.malformed('token', 'no access_token');
    }
    return { accessToken, expiresAt: expiryOf(body?.expires_at), scopes: scopesOf(body?.scopes) };
  }

  /** `DELETE /grants/<id>`: revoke at the provider and forget. A grant already gone counts as revoked. */
  async revoke(grantId: string): Promise<void> {
    try {
      await this.call('revoke', 'DELETE', `/grants/${this.grantSegment(grantId, 'revoke')}`, null);
    } catch (err) {
      if (err instanceof OAuthBrokerError && err.status === 404 && err.grantGone) return;
      throw err;
    }
  }

  private grantSegment(grantId: string, call: BrokerCall): string {
    if (!GRANT_ID.test(grantId)) throw this.malformed(call, 'the stored grant id is malformed');
    return grantId;
  }

  private endpoint(path: string): string {
    return `${this.config.url.href.replace(/\/+$/, '')}${path}`;
  }

  private async call(
    call: BrokerCall,
    method: 'POST' | 'DELETE',
    path: string,
    payload: Record<string, unknown> | null,
  ): Promise<Record<string, unknown> | null> {
    let response: Response;
    try {
      response = await this.io.fetch(this.endpoint(path), {
        method,
        headers: {
          Authorization: `Bearer ${this.config.key}`,
          Accept: 'application/json',
          ...(payload === null ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(payload === null ? {} : { body: JSON.stringify(payload) }),
        redirect: 'error',
        signal: AbortSignal.timeout(BROKER_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : 'error';
      throw new OAuthBrokerError(
        `OAuth broker '${this.name}' could not be reached (${call}: ${reason})`,
        this.name,
        call,
        0,
        null,
        false,
      );
    }
    const body = await readJsonObject(response);
    if (response.ok) return body;
    const raw = body?.error;
    const code = typeof raw === 'string' && ERROR_CODE.test(raw) ? raw : null;
    // A grant is over only when the broker says so in the contract's words, on a
    // call about that grant: a 404 without the code may be a wrong URL.
    const grantGone =
      code !== null &&
      GRANT_GONE_CODES.has(code) &&
      (call === 'redeem' || call === 'token' || call === 'revoke');
    throw new OAuthBrokerError(
      `OAuth broker '${this.name}' answered ${response.status} to ${call}${code ? ` (${code})` : ''}`,
      this.name,
      call,
      response.status,
      code,
      grantGone,
    );
  }

  private malformed(call: BrokerCall, what: string): OAuthBrokerError {
    return new OAuthBrokerError(
      `OAuth broker '${this.name}' answered ${call} with ${what}`,
      this.name,
      call,
      200,
      null,
      false,
    );
  }
}

/**
 * The brokers of the configuration, and which one serves a broker provider
 * (`brokerFor`: the one listing it, else the default broker).
 */
export class OAuthBrokers {
  private readonly clients: ReadonlyMap<string, OAuthBrokerClient>;

  constructor(
    private readonly configs: readonly OAuthBrokerConfig[],
    io: OAuthBrokerIo,
  ) {
    this.clients = new Map(configs.map((c) => [c.name, new OAuthBrokerClient(c, io)] as const));
  }

  /** The broker that serves a broker provider, or `null` when none is configured for it. */
  forProvider(provider: string): OAuthBrokerClient | null {
    const config = brokerFor(this.configs, provider);
    return config ? (this.clients.get(config.name) ?? null) : null;
  }

  /** A broker by name: the one a stored grant was obtained from. */
  byName(name: string): OAuthBrokerClient | null {
    return this.clients.get(name) ?? null;
  }

  get size(): number {
    return this.clients.size;
  }
}

/** Why a plugin that needs a broker cannot be connected, in a person's words. */
export function brokerNotConfiguredReason(displayName: string, provider: string): string {
  return `${displayName} is connected through an OAuth broker this gateway is enrolled with, and none is configured for "${provider}". An administrator sets oauth_brokers in the configuration.`;
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

/** An ISO-8601 instant, normalised; anything else is "the broker does not say". */
function expiryOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

function scopesOf(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const scopes = raw.filter((s): s is string => typeof s === 'string' && s.length > 0);
  return scopes.length > 0 ? scopes : null;
}
