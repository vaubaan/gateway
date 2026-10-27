/**
 * A fake OAuth broker: the contract test kit of ADR
 * google-calendar-through-an-oauth-broker ("A contract test kit (a fake broker)
 * ships with the gateway's tests"), on the stateless, attested contract of ADR
 * oauth-broker-stateless-in-an-attested-enclave. Not for production.
 *
 * An in-memory server on the loopback interface that implements the calls of
 * docs/handbook/oauth-broker-contract.md exactly as written there — the
 * request and answer bodies, the status codes, the error codes, the lifetime
 * of a grant — plus the provider's side of the flow, which a test drives
 * instead of a browser (`approve`, `deny`). An implementer of a real broker
 * can read this file as the reference behaviour.
 *
 *   const broker = await FakeOAuthBroker.start({ keys: { 'key-of-instance-a': 'instance-a' } });
 *   broker.recordReturnUrl('instance-a', 'https://gateway.example.com/connections/callback/google-calendar');
 *   const brokers = new OAuthBrokers([broker.configFor('key-of-instance-a')],
 *     { fetch, attestation: broker.attestationKit() });
 *   …
 *   await broker.stop();
 *
 * By default it plays an attested broker: HTTPS with a key of its own (a
 * throwaway self-signed certificate, `fake-tls-certificate.ts`) and
 * `POST /attest` answered on the **test-only** platform `fake-enclave`, whose
 * adapter and allowlist `attestationKit()` hands to the code under test — the
 * configuration can never name it. `{ attestation: 'none' }` plays a broker
 * outside an enclave: plain HTTP on the loopback, no `/attest`.
 *
 * Like a real broker it keeps no token: the refresh tokens it hands out are
 * the fake *provider's* (`providerRefreshTokens`), which the broker side only
 * reads when the gateway presents one. Knobs: `down()` / `up()` (503 to
 * everything), `clock` (the grant's lifetime), `refusingProvider()` (the
 * provider refuses every refresh token: `invalid_grant`), `attestWith()`
 * (evidence for another version, key or a debug image), `rotateTlsKey()`
 * (the enclave restarted), and the record of every call (`calls`).
 */
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTlsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';

import { jwtVerify, SignJWT } from 'jose';

import type { OAuthBrokerConfig } from '../config/types';
import {
  AttestationRefused,
  BROKER_ATTESTATION_AUDIENCE,
  spkiHashOf,
  type AttestationPlatform,
  type BrokerAttestationKit,
} from './broker-attestation';
import { fakeTlsCertificate } from './fake-tls-certificate';

/** How long a one-time grant may wait for its redeem (contract: "minutes-long"). */
export const FAKE_GRANT_TTL_MS = 5 * 60_000;
/** The lifetime of the access tokens the fake hands out. */
export const FAKE_ACCESS_TOKEN_TTL_MS = 60 * 60_000;
/** The lifetime of the fake's attestation evidence. */
export const FAKE_ATTESTATION_TTL_MS = 60 * 60_000;
/** The provider the fake serves, unless told otherwise. */
export const FAKE_BROKER_PROVIDER = 'google';
/** The provider's consent page the fake answers `POST /flows` with. */
export const FAKE_AUTHORIZE_URL = 'https://accounts.provider.example.com/o/oauth2/v2/auth';
/** The test-only enclave platform. No production kit knows it. */
export const FAKE_ENCLAVE_PLATFORM = 'fake-enclave';
/** The measurement the fake reports, admitted by `attestationKit()`. */
export const FAKE_BROKER_MEASUREMENT = `sha256:${'f'.repeat(64)}`;
const FAKE_ENCLAVE_ISSUER = 'https://fake-enclave.example.com';

export interface FakeOAuthBrokerOptions {
  /** Broker key → the instance it enrolls. */
  readonly keys: Readonly<Record<string, string>>;
  /** Providers served; default `['google']`. */
  readonly providers?: readonly string[];
  /** The account the provider says the person signed in as. */
  readonly account?: string;
  /** The scopes the provider granted; default: the scopes the flow asked for. */
  readonly grantedScopes?: readonly string[];
  readonly now?: () => number;
  /** `fake-enclave` (the default): HTTPS and `/attest`. `none`: plain HTTP, not attested. */
  readonly attestation?: 'fake-enclave' | 'none';
}

/** One call the fake received: what the gateway sent, the key's instance, the answer's status. */
export interface FakeBrokerCall {
  readonly method: string;
  readonly path: string;
  readonly instance: string | null;
  readonly body: Record<string, unknown> | null;
  readonly status: number;
}

/** What the next attestations say, instead of the truth. */
export interface FakeAttestationOverride {
  readonly measurement?: string;
  /** The SPKI hash the evidence carries (default: the key the server presents). */
  readonly spkiHash?: string;
  readonly debug?: boolean;
}

interface Flow {
  readonly instance: string;
  readonly provider: string;
  readonly scopes: readonly string[];
  readonly returnUrl: string;
  readonly state: string;
  readonly challenge: string;
}

interface PendingGrant {
  readonly flow: Flow;
  readonly issuedAt: number;
  used: boolean;
}

/** A refresh token as the fake provider knows it; the broker side keeps nothing. */
interface ProviderGrant {
  readonly provider: string;
  readonly scopes: readonly string[];
  revoked: boolean;
}

const MAX_BODY_BYTES = 64 * 1024;

export class FakeOAuthBroker {
  private readonly flows = new Map<string, Flow>();
  private readonly pendingGrants = new Map<string, PendingGrant>();
  private readonly returnUrls = new Map<string, Set<string>>();
  private isDown = false;
  private providerRefuses = false;
  private override: FakeAttestationOverride = {};
  /** The provider's side: every refresh token it issued, by value. Not the broker's state. */
  readonly providerRefreshTokens = new Map<string, ProviderGrant>();
  readonly calls: FakeBrokerCall[] = [];
  /** Refresh tokens revoked at the provider through `POST /revoke`. */
  readonly revokedAtProvider: string[] = [];

  private constructor(
    private readonly server: Server | HttpsServer,
    readonly url: URL,
    private readonly options: FakeOAuthBrokerOptions,
    private readonly enclave: {
      readonly signingKey: KeyObject;
      readonly verifyKey: KeyObject;
      spkiHash: string;
    } | null,
  ) {}

  static async start(options: FakeOAuthBrokerOptions): Promise<FakeOAuthBroker> {
    let broker: FakeOAuthBroker | null = null;
    const handler = (req: IncomingMessage, res: ServerResponse): void => {
      void broker?.handle(req, res);
    };
    const attested = (options.attestation ?? FAKE_ENCLAVE_PLATFORM) === FAKE_ENCLAVE_PLATFORM;
    const certificate = attested ? fakeTlsCertificate() : null;
    const server = certificate
      ? createTlsServer({ key: certificate.keyPem, cert: certificate.certPem }, handler)
      : createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const scheme = certificate ? 'https' : 'http';
    const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    broker = new FakeOAuthBroker(
      server,
      new URL(`${scheme}://127.0.0.1:${port}/v1`),
      options,
      certificate
        ? {
            signingKey: keys.privateKey,
            verifyKey: keys.publicKey,
            spkiHash: spkiHashOf(new X509Certificate(certificate.certPem)),
          }
        : null,
    );
    return broker;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** The configuration block of an instance enrolled with this broker under `key`. */
  configFor(key: string, name = 'main', providers: readonly string[] = []): OAuthBrokerConfig {
    return {
      name,
      url: this.url,
      key,
      providers,
      attestation: this.enclave ? 'required' : 'none',
    };
  }

  /**
   * The test-only platform adapter that verifies this fake's evidence, and an
   * allowlist admitting its measurement: what the code under test is built
   * with instead of `productionAttestationKit`.
   */
  attestationKit(allowlist = [FAKE_BROKER_MEASUREMENT]): BrokerAttestationKit {
    const verifyKey = this.enclave?.verifyKey;
    if (!verifyKey) throw new Error('fake broker: started with attestation none');
    return {
      platforms: [fakeEnclavePlatform(verifyKey)],
      allowlist: allowlist.map((measurement) => ({
        platform: FAKE_ENCLAVE_PLATFORM,
        measurement,
        broker_version: 'fake',
      })),
    };
  }

  /** The SPKI hash of the TLS key the server presents now. */
  get spkiHash(): string | null {
    return this.enclave?.spkiHash ?? null;
  }

  /** What the next attestations claim, instead of the truth (`{}` restores it). */
  attestWith(override: FakeAttestationOverride): void {
    this.override = override;
  }

  /** The enclave restarted: a new TLS key, which no earlier attestation carries. */
  rotateTlsKey(): void {
    if (!this.enclave) throw new Error('fake broker: started with attestation none');
    const certificate = fakeTlsCertificate();
    (this.server as HttpsServer).setSecureContext({
      key: certificate.keyPem,
      cert: certificate.certPem,
    });
    this.enclave.spkiHash = spkiHashOf(new X509Certificate(certificate.certPem));
  }

  /** Enrollment: a return URL the broker has on record for an instance. */
  recordReturnUrl(instance: string, returnUrl: string): void {
    const urls = this.returnUrls.get(instance) ?? new Set<string>();
    urls.add(returnUrl);
    this.returnUrls.set(instance, urls);
  }

  /** The broker answers 503 to everything until `up()`. */
  down(): void {
    this.isDown = true;
  }

  up(): void {
    this.isDown = false;
  }

  /** The provider no longer accepts the refresh tokens (the person removed the access there). */
  refusingProvider(): void {
    this.providerRefuses = true;
  }

  /**
   * The person allowed the access at the provider, and the provider came back to
   * the broker: the browser is sent to `return_url?grant=…&state=…`. `authorizeUrl`
   * is what `POST /flows` answered.
   */
  approve(authorizeUrl: string): URL {
    const flow = this.flowOf(authorizeUrl);
    const grant = token('gr');
    this.pendingGrants.set(grant, { flow, issuedAt: this.now(), used: false });
    const back = new URL(flow.returnUrl);
    back.searchParams.set('grant', grant);
    back.searchParams.set('state', flow.state);
    return back;
  }

  /** The person refused at the provider: `return_url?error=access_denied&state=…`. */
  deny(authorizeUrl: string): URL {
    const flow = this.flowOf(authorizeUrl);
    const back = new URL(flow.returnUrl);
    back.searchParams.set('error', 'access_denied');
    back.searchParams.set('state', flow.state);
    return back;
  }

  private flowOf(authorizeUrl: string): Flow {
    const id = new URL(authorizeUrl).searchParams.get('state');
    const flow = id ? this.flows.get(id) : undefined;
    if (!flow) throw new Error('fake broker: no such flow');
    this.flows.delete(id ?? '');
    return flow;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const method = req.method ?? 'GET';
    const body = await readBody(req);
    const answer = (
      status: number,
      payload: Record<string, unknown> | null,
      instance: string | null,
    ) => {
      this.calls.push({ method, path, instance, body, status });
      res.statusCode = status;
      if (payload === null) {
        res.end();
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(payload));
    };
    if (this.isDown) {
      answer(503, { error: 'temporarily_unavailable', message: 'down' }, null);
      return;
    }
    const instance = this.instanceOf(req.headers.authorization);
    if (instance === null) {
      answer(401, { error: 'invalid_key', message: 'unknown broker key' }, null);
      return;
    }
    const prefix = this.url.pathname;
    if (!path.startsWith(`${prefix}/`)) {
      answer(404, { error: 'not_found', message: 'no such path' }, instance);
      return;
    }
    const route = path.slice(prefix.length);
    const [status, payload] =
      method === 'POST'
        ? await this.route(route, body, instance)
        : [404, { error: 'not_found', message: 'no such path' }];
    answer(status, payload, instance);
  }

  private instanceOf(header: string | undefined): string | null {
    if (!header?.startsWith('Bearer ')) return null;
    return this.options.keys[header.slice('Bearer '.length)] ?? null;
  }

  private async route(
    route: string,
    body: Record<string, unknown> | null,
    instance: string,
  ): Promise<[number, Record<string, unknown> | null]> {
    switch (route) {
      case '/flows':
        return this.startFlow(body, instance);
      case '/grants/redeem':
        return this.redeem(body, instance);
      case '/token':
        return this.refresh(body);
      case '/revoke':
        return this.revoke(body);
      case '/attest':
        return this.attest(body);
      default:
        return [404, refusal('not_found')];
    }
  }

  private startFlow(
    body: Record<string, unknown> | null,
    instance: string,
  ): [number, Record<string, unknown>] {
    const provider = body?.provider;
    const scopes = body?.scopes;
    const returnUrl = body?.return_url;
    const state = body?.state;
    const challenge = body?.challenge;
    if (
      typeof provider !== 'string' ||
      !Array.isArray(scopes) ||
      !scopes.every((s) => typeof s === 'string') ||
      typeof returnUrl !== 'string' ||
      typeof state !== 'string' ||
      typeof challenge !== 'string' ||
      body?.challenge_method !== 'S256'
    ) {
      return [400, refusal('invalid_request')];
    }
    if (!this.serves(provider)) return [400, refusal('unsupported_provider')];
    if (!this.returnUrls.get(instance)?.has(returnUrl)) {
      return [403, refusal('return_url_not_registered')];
    }
    const flowId = token('fl');
    this.flows.set(flowId, { instance, provider, scopes, returnUrl, state, challenge });
    const authorize = new URL(FAKE_AUTHORIZE_URL);
    // The broker's own state towards the provider, and its own redirect URI: never the gateway's.
    authorize.searchParams.set('state', flowId);
    authorize.searchParams.set('redirect_uri', 'https://broker.example.com/oauth/callback/google');
    authorize.searchParams.set('scope', scopes.join(' '));
    return [201, { authorize_url: authorize.href }];
  }

  private redeem(
    body: Record<string, unknown> | null,
    instance: string,
  ): [number, Record<string, unknown>] {
    const grantText = body?.grant;
    const verifier = body?.verifier;
    if (typeof grantText !== 'string' || typeof verifier !== 'string') {
      return [400, refusal('invalid_request')];
    }
    const pending = this.pendingGrants.get(grantText);
    // Unknown, used, late, another instance's, the wrong verifier: one answer for all.
    const refused: [number, Record<string, unknown>] = [400, refusal('invalid_grant')];
    if (!pending || pending.used) return refused;
    pending.used = true;
    // The flow is over whatever happens: the broker keeps nothing of it.
    this.pendingGrants.delete(grantText);
    if (this.now() - pending.issuedAt > FAKE_GRANT_TTL_MS) return refused;
    if (pending.flow.instance !== instance) return refused;
    if (s256(verifier) !== pending.flow.challenge) return refused;
    // Only now is the provider's code exchanged: the provider issues the tokens.
    const scopes = this.options.grantedScopes ?? pending.flow.scopes;
    const refreshToken = token('rt');
    this.providerRefreshTokens.set(refreshToken, {
      provider: pending.flow.provider,
      scopes,
      revoked: false,
    });
    return [
      200,
      {
        refresh_token: refreshToken,
        access_token: token('at'),
        expires_at: this.expiry(),
        account: this.options.account ?? 'person@example.com',
        scopes,
      },
    ];
  }

  /** The broker adds its client secret and asks the provider; it writes nothing. */
  private refresh(body: Record<string, unknown> | null): [number, Record<string, unknown>] {
    const provider = body?.provider;
    const refreshToken = body?.refresh_token;
    if (typeof provider !== 'string' || typeof refreshToken !== 'string') {
      return [400, refusal('invalid_request')];
    }
    if (!this.serves(provider)) return [400, refusal('unsupported_provider')];
    const known = this.providerRefreshTokens.get(refreshToken);
    if (!known || known.revoked || known.provider !== provider || this.providerRefuses) {
      return [400, refusal('invalid_grant')];
    }
    return [200, { access_token: token('at'), expires_at: this.expiry(), scopes: known.scopes }];
  }

  /** Relayed to the provider's revocation endpoint; 204 also when already revoked. */
  private revoke(body: Record<string, unknown> | null): [number, Record<string, unknown> | null] {
    const provider = body?.provider;
    const refreshToken = body?.refresh_token;
    if (typeof provider !== 'string' || typeof refreshToken !== 'string') {
      return [400, refusal('invalid_request')];
    }
    if (!this.serves(provider)) return [400, refusal('unsupported_provider')];
    const known = this.providerRefreshTokens.get(refreshToken);
    if (known && !known.revoked) {
      known.revoked = true;
      this.revokedAtProvider.push(refreshToken);
    }
    return [204, null];
  }

  /** `POST /attest {nonce}` → `{platform, evidence}` on the test-only platform. */
  private async attest(
    body: Record<string, unknown> | null,
  ): Promise<[number, Record<string, unknown>]> {
    if (!this.enclave) return [404, refusal('not_found')];
    const nonce = body?.nonce;
    if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) {
      return [400, refusal('invalid_request')];
    }
    const now = this.now();
    const evidence = await new SignJWT({
      eat_nonce: [nonce, this.override.spkiHash ?? this.enclave.spkiHash],
      measurement: this.override.measurement ?? FAKE_BROKER_MEASUREMENT,
      debug: this.override.debug ?? false,
    })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer(FAKE_ENCLAVE_ISSUER)
      .setAudience(BROKER_ATTESTATION_AUDIENCE)
      .setIssuedAt(Math.floor(now / 1000))
      .setExpirationTime(Math.floor((now + FAKE_ATTESTATION_TTL_MS) / 1000))
      .sign(this.enclave.signingKey);
    return [200, { platform: FAKE_ENCLAVE_PLATFORM, evidence }];
  }

  private serves(provider: string): boolean {
    return (this.options.providers ?? [FAKE_BROKER_PROVIDER]).includes(provider);
  }

  private expiry(): string {
    return new Date(this.now() + FAKE_ACCESS_TOKEN_TTL_MS).toISOString();
  }
}

/**
 * The adapter of the test-only `fake-enclave` platform: the fake's evidence
 * is a JWT signed with its own key, carrying the nonce, the SPKI hash, the
 * measurement and a debug flag. Handed to the code under test by
 * `attestationKit()`; no production kit contains it.
 */
export function fakeEnclavePlatform(verifyKey: KeyObject): AttestationPlatform {
  return {
    platform: FAKE_ENCLAVE_PLATFORM,
    async verify(evidence, expected) {
      if (typeof evidence !== 'string') throw new AttestationRefused('no evidence');
      let payload: Record<string, unknown>;
      try {
        ({ payload } = await jwtVerify(evidence, verifyKey, {
          issuer: FAKE_ENCLAVE_ISSUER,
          audience: BROKER_ATTESTATION_AUDIENCE,
          algorithms: ['ES256'],
          currentDate: expected.now,
        }));
      } catch {
        throw new AttestationRefused('the attestation token is not valid');
      }
      if (payload.debug !== false) throw new AttestationRefused('the broker runs a debug image');
      const nonces = payload.eat_nonce;
      if (
        !Array.isArray(nonces) ||
        nonces.length !== 2 ||
        nonces[0] !== expected.nonce ||
        nonces[1] !== expected.spkiHash
      ) {
        throw new AttestationRefused(
          'the attestation is not bound to this request and this connection’s key',
        );
      }
      if (typeof payload.measurement !== 'string' || typeof payload.exp !== 'number') {
        throw new AttestationRefused('the attestation names no measurement');
      }
      return { measurement: payload.measurement, expiresAt: payload.exp * 1000 };
    },
  };
}

function refusal(error: string): Record<string, unknown> {
  return { error, message: error.replace(/_/g, ' ') };
}

function token(prefix: string): string {
  return `${prefix}_${randomBytes(18).toString('base64url')}`;
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
