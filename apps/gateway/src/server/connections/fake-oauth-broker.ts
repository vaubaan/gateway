/**
 * A fake OAuth broker: the contract test kit of ADR
 * google-calendar-through-an-oauth-broker ("A contract test kit (a fake broker)
 * ships with the gateway's tests"). Not for production.
 *
 * An in-memory HTTP server on the loopback interface that implements the four
 * calls of docs/handbook/oauth-broker-contract.md exactly as written there —
 * the request and answer bodies, the status codes, the error codes, the
 * lifetime of a grant — plus the provider's side of the flow, which a test
 * drives instead of a browser (`approve`, `deny`). An implementer of a real
 * broker can read this file as the reference behaviour.
 *
 *   const broker = await FakeOAuthBroker.start({ keys: { 'key-of-instance-a': 'instance-a' } });
 *   broker.recordReturnUrl('instance-a', 'https://gateway.example.com/connections/callback/google-calendar');
 *   …
 *   await broker.stop();
 *
 * Knobs: `down()` / `up()` (the server answers 503 to everything), `clock`
 * (the grant's lifetime), `refusingProvider()` (the provider no longer accepts
 * the refresh token: `grant_revoked`), and the record of every call
 * (`calls`) so a test can say what the gateway sent.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { OAuthBrokerConfig } from '../config/types';

/** How long a one-time grant may wait for its redeem (contract: "minutes-long"). */
export const FAKE_GRANT_TTL_MS = 5 * 60_000;
/** The lifetime of the access tokens the fake hands out. */
export const FAKE_ACCESS_TOKEN_TTL_MS = 60 * 60_000;
/** The provider the fake serves, unless told otherwise. */
export const FAKE_BROKER_PROVIDER = 'google';
/** The provider's consent page the fake answers `POST /flows` with. */
export const FAKE_AUTHORIZE_URL = 'https://accounts.provider.example.com/o/oauth2/v2/auth';

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
}

/** One call the fake received: what the gateway sent, the key's instance, the answer's status. */
export interface FakeBrokerCall {
  readonly method: string;
  readonly path: string;
  readonly instance: string | null;
  readonly body: Record<string, unknown> | null;
  readonly status: number;
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

interface Grant {
  readonly instance: string;
  readonly provider: string;
  readonly scopes: readonly string[];
  readonly account: string;
  /** What the broker keeps and never hands out: the provider's refresh token. */
  readonly refreshToken: string;
  accessToken: string;
}

const MAX_BODY_BYTES = 64 * 1024;

export class FakeOAuthBroker {
  private readonly flows = new Map<string, Flow>();
  private readonly pendingGrants = new Map<string, PendingGrant>();
  private readonly grants = new Map<string, Grant>();
  private readonly returnUrls = new Map<string, Set<string>>();
  private isDown = false;
  private providerRefuses = false;
  readonly calls: FakeBrokerCall[] = [];
  /** Grants revoked at the provider through `DELETE /grants/<id>`. */
  readonly revokedAtProvider: string[] = [];

  private constructor(
    private readonly server: Server,
    readonly url: URL,
    private readonly options: FakeOAuthBrokerOptions,
  ) {}

  static async start(options: FakeOAuthBrokerOptions): Promise<FakeOAuthBroker> {
    let broker: FakeOAuthBroker | null = null;
    const server = createServer((req, res) => {
      void broker?.handle(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    broker = new FakeOAuthBroker(server, new URL(`http://127.0.0.1:${port}/v1`), options);
    return broker;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** The configuration block of an instance enrolled with this broker under `key`. */
  configFor(key: string, name = 'main', providers: readonly string[] = []): OAuthBrokerConfig {
    return { name, url: this.url, key, providers };
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

  /** The grants the broker holds, by id (what an operator would see). */
  grantIds(): string[] {
    return [...this.grants.keys()];
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
      answer(503, { error: 'temporarily_unavailable' }, null);
      return;
    }
    const instance = this.instanceOf(req.headers.authorization);
    if (instance === null) {
      answer(401, { error: 'invalid_key' }, null);
      return;
    }
    const prefix = this.url.pathname;
    if (!path.startsWith(`${prefix}/`)) {
      answer(404, { error: 'not_found' }, instance);
      return;
    }
    const route = path.slice(prefix.length);
    const [status, payload] = this.route(method, route, body, instance);
    answer(status, payload, instance);
  }

  private instanceOf(header: string | undefined): string | null {
    if (!header?.startsWith('Bearer ')) return null;
    return this.options.keys[header.slice('Bearer '.length)] ?? null;
  }

  private route(
    method: string,
    route: string,
    body: Record<string, unknown> | null,
    instance: string,
  ): [number, Record<string, unknown> | null] {
    if (method === 'POST' && route === '/flows') return this.startFlow(body, instance);
    if (method === 'POST' && route === '/grants/redeem') return this.redeem(body, instance);
    const segments = route.split('/');
    // ['', 'grants', '<id>'] or ['', 'grants', '<id>', 'token']
    if (segments[1] === 'grants' && segments[2]) {
      const id = segments[2];
      if (method === 'POST' && segments[3] === 'token' && segments.length === 4) {
        return this.refresh(id, instance);
      }
      if (method === 'DELETE' && segments.length === 3) return this.revoke(id, instance);
    }
    return [404, { error: 'not_found' }];
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
      return [400, { error: 'invalid_request' }];
    }
    if (!(this.options.providers ?? [FAKE_BROKER_PROVIDER]).includes(provider)) {
      return [400, { error: 'unsupported_provider' }];
    }
    if (!this.returnUrls.get(instance)?.has(returnUrl)) {
      return [403, { error: 'return_url_not_registered' }];
    }
    const flowId = token('fl');
    this.flows.set(flowId, { instance, provider, scopes, returnUrl, state, challenge });
    const authorize = new URL(FAKE_AUTHORIZE_URL);
    // The broker's own state towards the provider, and its own redirect URI: never the gateway's.
    authorize.searchParams.set('state', flowId);
    authorize.searchParams.set('redirect_uri', 'https://broker.example.com/callback');
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
      return [400, { error: 'invalid_request' }];
    }
    const pending = this.pendingGrants.get(grantText);
    // Unknown, used, late, another instance's, the wrong verifier: one answer for all.
    const refused: [number, Record<string, unknown>] = [400, { error: 'invalid_grant' }];
    if (!pending || pending.used) return refused;
    pending.used = true;
    if (this.now() - pending.issuedAt > FAKE_GRANT_TTL_MS) return refused;
    if (pending.flow.instance !== instance) return refused;
    if (s256(verifier) !== pending.flow.challenge) return refused;
    const grantId = token('g');
    const scopes = this.options.grantedScopes ?? pending.flow.scopes;
    const grant: Grant = {
      instance,
      provider: pending.flow.provider,
      scopes,
      account: this.options.account ?? 'person@example.com',
      refreshToken: token('rt'),
      accessToken: token('at'),
    };
    this.grants.set(grantId, grant);
    return [
      200,
      {
        grant_id: grantId,
        access_token: grant.accessToken,
        expires_at: this.expiry(),
        account: grant.account,
        scopes,
      },
    ];
  }

  private refresh(grantId: string, instance: string): [number, Record<string, unknown>] {
    const grant = this.grants.get(grantId);
    if (!grant || grant.instance !== instance) return [404, { error: 'grant_not_found' }];
    if (this.providerRefuses) {
      this.grants.delete(grantId);
      return [410, { error: 'grant_revoked' }];
    }
    grant.accessToken = token('at');
    return [
      200,
      { access_token: grant.accessToken, expires_at: this.expiry(), scopes: grant.scopes },
    ];
  }

  private revoke(grantId: string, instance: string): [number, null] {
    const grant = this.grants.get(grantId);
    if (grant && grant.instance === instance) {
      this.grants.delete(grantId);
      this.revokedAtProvider.push(grantId);
    }
    // Idempotent: a grant already gone is gone.
    return [204, null];
  }

  private expiry(): string {
    return new Date(this.now() + FAKE_ACCESS_TOKEN_TTL_MS).toISOString();
  }
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
