/**
 * The gateway as the client of an OAuth broker (ADRs
 * google-calendar-through-an-oauth-broker D1, D2 and
 * oauth-broker-stateless-in-an-attested-enclave D1, D4, D6). The contract —
 * requests, answers, status codes — is docs/handbook/oauth-broker-contract.md;
 * this file is its client side.
 *
 * Calls, HTTPS and JSON, the broker key as a Bearer on every one:
 *
 *   POST /flows          → { authorize_url }                  starts a flow
 *   POST /grants/redeem  → { refresh_token, access_token, expires_at, account, scopes }
 *   POST /token          → { access_token, expires_at, scopes? }   the refresh
 *   POST /revoke         → 204                                 relayed to the provider
 *   POST /attest         → { platform, evidence }              (`broker-channel.ts`)
 *
 * The broker keeps no token: the instance keeps the provider's refresh token,
 * sealed beside the access token, and presents it at every refresh; the
 * broker adds its client secret and writes nothing. Every call goes over a
 * connection whose TLS key an attestation of an admitted broker version
 * carries (`AttestedChannel`), unless the broker is declared
 * `attestation: none` (`FetchChannel`). Nothing here names who operates a
 * broker: a broker is a URL and a key.
 *
 * Failures are `OAuthBrokerError`. `grantGone` separates "the provider refused
 * this grant" (`invalid_grant`: the connection must be reconnected) from a
 * broker failure — down, slow, refusing the key, not attested, answering
 * something else — which changes nothing and is reported as the broker's,
 * never as an expiry. The message never quotes the broker's text: only the
 * call, the status and the protocol error code.
 */
import { createHash } from 'node:crypto';

import type { OAuthBrokerConfig } from '../config/types';
import { brokerFor } from '../config/oauth-brokers';
import {
  AttestationVerifier,
  type AdmittedBroker,
  type BrokerAttestationKit,
} from './broker-attestation';
import {
  AttestedChannel,
  BrokerChannelError,
  FetchChannel,
  type BrokerChannel,
} from './broker-channel';

/** A broker that does not answer within this delay is unreachable. */
export const BROKER_REQUEST_TIMEOUT_MS = 15_000;

/** The broker's `error` code is a protocol token, never free text. */
const ERROR_CODE = /^[a-z_]{1,40}$/;

/** The calls, as the error messages name them. */
export type BrokerCall = 'flows' | 'redeem' | 'token' | 'revoke';

/**
 * The one error code of the contract that says the grant is over (handbook
 * oauth-broker-contract, "Errors"): at redeem, the grant was used, late,
 * another instance's or bound to another verifier, or the provider refused the
 * code; at refresh, the provider refused the refresh token.
 */
const GRANT_GONE_CODE = 'invalid_grant';

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
  /** The provider's refresh token: the instance keeps it, sealed; the broker keeps none. */
  readonly refreshToken: string;
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
  /** Reaches a broker declared `attestation: none`. */
  readonly fetch: typeof fetch;
  /** The platform adapters and the allowlist of attested brokers (`productionAttestationKit`). */
  readonly attestation: BrokerAttestationKit;
  /** Epoch milliseconds, for the lifetime of a pinned key. */
  readonly now?: () => number;
}

/** RFC 7636 S256: what `POST /flows` carries instead of the verifier. */
export function challengeOf(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** One configured broker. */
export class OAuthBrokerClient {
  private readonly channel: BrokerChannel;

  constructor(
    readonly config: OAuthBrokerConfig,
    io: OAuthBrokerIo,
    verifier: AttestationVerifier = new AttestationVerifier(io.attestation),
  ) {
    this.channel =
      config.attestation === 'none'
        ? new FetchChannel(config.url, config.key, io.fetch)
        : new AttestedChannel(config.url, config.key, {
            verifier,
            now: io.now ?? Date.now,
          });
  }

  get name(): string {
    return this.config.name;
  }

  /** False for a broker the configuration declares `attestation: none`. */
  get attested(): boolean {
    return this.config.attestation !== 'none';
  }

  /** The broker version the current attestation admitted, `null` before one (or when not attested). */
  get admitted(): AdmittedBroker | null {
    return this.channel.admitted;
  }

  /** `POST /flows`: the provider's page to send the browser to. */
  async startFlow(request: FlowRequest): Promise<URL> {
    const body = await this.call('flows', '/flows', {
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

  /** `POST /grants/redeem`: the one-time grant the browser came back with, for the provider's tokens. */
  async redeem(grant: string, verifier: string): Promise<RedeemedGrant> {
    const body = await this.call('redeem', '/grants/redeem', { grant, verifier });
    const refreshToken = body?.refresh_token;
    const accessToken = body?.access_token;
    if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
      throw this.malformed('redeem', 'no refresh_token');
    }
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw this.malformed('redeem', 'no access_token');
    }
    const account = body?.account;
    return {
      refreshToken,
      accessToken,
      expiresAt: expiryOf(body?.expires_at),
      account: typeof account === 'string' && account.length > 0 ? account.slice(0, 320) : null,
      scopes: scopesOf(body?.scopes) ?? [],
    };
  }

  /** `POST /token`: a fresh access token for the refresh token the instance keeps. */
  async token(provider: string, refreshToken: string): Promise<FreshToken> {
    const body = await this.call('token', '/token', { provider, refresh_token: refreshToken });
    const accessToken = body?.access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw this.malformed('token', 'no access_token');
    }
    return { accessToken, expiresAt: expiryOf(body?.expires_at), scopes: scopesOf(body?.scopes) };
  }

  /** `POST /revoke`: the broker relays the revocation to the provider; 204, also when already revoked. */
  async revoke(provider: string, refreshToken: string): Promise<void> {
    await this.call('revoke', '/revoke', { provider, refresh_token: refreshToken });
  }

  private async call(
    call: BrokerCall,
    path: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    let answer;
    try {
      answer = await this.channel.send(
        path,
        JSON.stringify(payload),
        AbortSignal.timeout(BROKER_REQUEST_TIMEOUT_MS),
      );
    } catch (err) {
      if (!(err instanceof BrokerChannelError)) throw err;
      const what = {
        unreachable: 'could not be reached',
        'attest-answered': 'could not be attested',
        'not-attested': 'is not attested',
      }[err.kind];
      throw new OAuthBrokerError(
        `OAuth broker '${this.name}' ${what} (${call}: ${err.message})`,
        this.name,
        call,
        err.status,
        null,
        false,
      );
    }
    const body = readJsonObject(answer.text);
    if (answer.status >= 200 && answer.status < 300) return body;
    const raw = body?.error;
    const code = typeof raw === 'string' && ERROR_CODE.test(raw) ? raw : null;
    // A grant is over only when the provider said so, in the contract's word,
    // on a call about that grant: a 400 without the code may be anything.
    const grantGone =
      code === GRANT_GONE_CODE && answer.status === 400 && (call === 'redeem' || call === 'token');
    throw new OAuthBrokerError(
      `OAuth broker '${this.name}' answered ${answer.status} to ${call}${code ? ` (${code})` : ''}`,
      this.name,
      call,
      answer.status,
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
    // One verifier for every broker: Google's keys are fetched once.
    const verifier = new AttestationVerifier(io.attestation);
    this.clients = new Map(
      configs.map((c) => [c.name, new OAuthBrokerClient(c, io, verifier)] as const),
    );
  }

  /** The broker that serves a broker provider, or `null` when none is configured for it. */
  forProvider(provider: string): OAuthBrokerClient | null {
    const config = brokerFor(this.configs, provider);
    return config ? (this.clients.get(config.name) ?? null) : null;
  }

  /** A broker by name: the one a stored refresh token was obtained through. */
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

function readJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
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
