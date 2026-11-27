/**
 * Vaubaan's installed-app clients as the source of a broker provider (ADR
 * local-instance-carries-installed-oauth-clients): in local mode, a plugin that declares
 * `broker: { provider, scopes }` (google-calendar, outlook) connects through the client
 * the instance carries, with no broker. This class answers the broker contract the
 * account service already speaks (`startFlow`, `redeem`, `token`, `revoke`; handbook
 * oauth-broker-contract), run here against the provider itself:
 *
 *   startFlow  the provider's consent page, from the shared provider table
 *              (`@vaubaan/oauth-providers`: endpoints, allowed scopes, consent
 *              parameters), the plugin's scopes only, PKCE S256, back on the loopback
 *              `http://127.0.0.1:<port>/oauth/loopback`. The flow is kept under its
 *              `state`, with the person who started it.
 *   callback   the loopback: the provider's code waits under a one-time grant, as a
 *              broker's would. The
 *              browser goes on to the public URL: the person's own browser to the
 *              service's callback, `?state&grant`; another browser (the desktop app's
 *              default one) is told to go back to Vaubaan, and the window that started
 *              the flow, polling with the person's session, is sent to that callback.
 *   redeem     the grant, once, for the verifier of the flow that made it: the code is
 *              exchanged then, with that verifier, at the provider's token endpoint
 *              (Google with the client's secret, Microsoft's public client without).
 *   token      a refresh at the provider's token endpoint; Microsoft rotates the
 *              refresh token, and the new one is handed back to be sealed.
 *   revoke     Google's revocation endpoint; Microsoft has none.
 *
 * Errors are `OAuthBrokerError`s under the name `INSTALLED_BROKER`, so a refused refresh
 * token ends the account (`grantGone`) and anything else leaves it as it is.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { PROVIDERS, type ProviderDefinition } from '@vaubaan/oauth-providers';

import type { SessionStore } from '../compose/ports';
import type { InstalledClient } from '../config/installed-clients';
import { isRecord } from '@vaubaan/shared';
import {
  challengeOf,
  OAuthBrokerError,
  type BrokerCall,
  type FlowRequest,
  type RedeemedGrant,
  type RotatedToken,
} from './oauth-broker';

/**
 * The name accounts made through an installed client record as their broker. Not a
 * broker name the configuration accepts (`@`), so it never meets a configured one.
 */
export const INSTALLED_BROKER = '@installed';

const MINUTE_MS = 60_000;
/** How long the person has to consent, and the browser to come back. */
export const INSTALLED_FLOW_TTL_MS = 10 * MINUTE_MS;
const REQUEST_TIMEOUT_MS = 15_000;
const STATE_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;
const GRANT_GONE_CODE = 'invalid_grant';

interface InstalledFlow {
  readonly kind: 'installed-connect';
  readonly provider: string;
  readonly scopes: readonly string[];
  /** `<public_url>/connections/callback/<plugin>`: where the grant is taken. */
  readonly returnUrl: string;
  readonly challenge: string;
  /** The person who started it: only their session follows it to the callback. */
  readonly userId: string;
  /** Set once the provider came back: the query the callback takes (`grant`, or `error`). */
  readonly outcome?: Readonly<Record<string, string>>;
}

/** The provider's code, waiting for the verifier the account service presents at redeem. */
interface WaitingGrant {
  readonly kind: 'installed-grant';
  readonly provider: string;
  readonly challenge: string;
  readonly code: string;
  readonly scopes: readonly string[];
}

function isFlow(value: unknown): value is InstalledFlow {
  return (
    isRecord(value) &&
    value.kind === 'installed-connect' &&
    typeof value.provider === 'string' &&
    Array.isArray(value.scopes) &&
    typeof value.returnUrl === 'string' &&
    typeof value.challenge === 'string' &&
    typeof value.userId === 'string'
  );
}

function isGrant(value: unknown): value is WaitingGrant {
  return (
    isRecord(value) &&
    value.kind === 'installed-grant' &&
    typeof value.provider === 'string' &&
    typeof value.challenge === 'string' &&
    typeof value.code === 'string' &&
    Array.isArray(value.scopes)
  );
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The person's flow by user id: the window that polls finds it with its session. */
function userKey(userId: string): string {
  return `installed-connect-user:${createHash('sha256').update(userId).digest('base64url')}`;
}

export interface InstalledBrokerDeps {
  readonly clients: readonly InstalledClient[];
  /** Where the providers come back: `http://127.0.0.1:<port>/oauth/loopback`. */
  readonly redirectUri: URL;
  readonly store: SessionStore;
  readonly fetch: typeof fetch;
  readonly now: () => Date;
}

/** Where the loopback sends the browser once the provider came back. */
export type InstalledCallbackOutcome =
  | { readonly kind: 'not-mine' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'back'; readonly state: string };

export class InstalledClientBroker {
  readonly name = INSTALLED_BROKER;
  /** Nothing to attest: the client runs in this instance. */
  readonly attested = true;
  readonly admitted = null;
  private readonly byProvider: ReadonlyMap<string, InstalledClient>;

  constructor(private readonly deps: InstalledBrokerDeps) {
    this.byProvider = new Map(
      deps.clients
        .filter((client) => client.provider !== 'github' && PROVIDERS.has(client.provider))
        .map((client) => [client.provider, client] as const),
    );
  }

  /** Whether this instance carries a client for the broker provider. */
  serves(provider: string): boolean {
    return this.byProvider.has(provider);
  }

  private clientOf(
    provider: string,
    call: BrokerCall,
  ): {
    client: InstalledClient;
    definition: ProviderDefinition;
  } {
    const client = this.byProvider.get(provider);
    const definition = PROVIDERS.get(provider);
    if (!client || !definition) {
      throw this.error(call, `no installed client for '${provider}'`, 0, null);
    }
    return { client, definition };
  }

  private error(
    call: BrokerCall,
    detail: string,
    status: number,
    code: string | null,
  ): OAuthBrokerError {
    const grantGone =
      code === GRANT_GONE_CODE && status === 400 && (call === 'redeem' || call === 'token');
    return new OAuthBrokerError(
      `Vaubaan's client on this computer: ${detail}`,
      INSTALLED_BROKER,
      call,
      status,
      code,
      grantGone,
    );
  }

  /**
   * The provider's consent page for the plugin's scopes. `userId` is the person who
   * starts it: the window that polls takes the flow with their session only.
   */
  async startFlow(request: FlowRequest): Promise<URL> {
    const { client, definition } = this.clientOf(request.provider, 'flows');
    const userId = request.userId;
    if (!userId) throw this.error('flows', 'a flow is started by a person', 0, null);
    const refused = request.scopes.filter((scope) => !definition.allowedScopes.has(scope));
    if (refused.length > 0) {
      throw this.error(
        'flows',
        `scopes not allowed for '${definition.id}': ${refused.join(' ')}`,
        400,
        'invalid_scope',
      );
    }
    // Microsoft answers a refresh token only for `offline_access`; Google for `access_type`.
    const scopes =
      definition.allowedScopes.has('offline_access') && !request.scopes.includes('offline_access')
        ? ['offline_access', ...request.scopes]
        : [...request.scopes];
    const challenge = challengeOf(request.verifier);
    const flow: InstalledFlow = {
      kind: 'installed-connect',
      provider: definition.id,
      scopes,
      returnUrl: request.returnUrl,
      challenge,
      userId,
    };
    await this.deps.store.set(`installed-connect:${request.state}`, flow, INSTALLED_FLOW_TTL_MS);
    await this.deps.store.set(userKey(userId), request.state, INSTALLED_FLOW_TTL_MS);
    const url = new URL(definition.authorizeEndpoint);
    url.search = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: this.deps.redirectUri.href,
      response_type: 'code',
      scope: scopes.join(' '),
      state: request.state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...definition.authorizeParams,
      // Google: a grant added to what this client already holds, the consent asking the
      // new scopes only.
      ...(definition.id === 'google' ? { include_granted_scopes: 'true' } : {}),
    }).toString();
    return url;
  }

  /** Whether the loopback's `state` names a flow of a connect (rather than of a sign-in). */
  async owns(state: string | null): Promise<boolean> {
    if (!state || !STATE_PATTERN.test(state)) return false;
    return isFlow(await this.deps.store.get(`installed-connect:${state}`));
  }

  /**
   * The provider's redirect on the loopback: its code kept, once, under a one-time grant
   * for the callback. A provider's refusal is kept as its `error` code.
   */
  async callback(query: URLSearchParams): Promise<InstalledCallbackOutcome> {
    const state = query.get('state');
    if (!state || !STATE_PATTERN.test(state)) return { kind: 'not-mine' };
    const key = `installed-connect:${state}`;
    const flow = await this.deps.store.get(key);
    if (!isFlow(flow)) return { kind: 'not-mine' };
    if (flow.outcome) return { kind: 'expired' };
    let outcome: Record<string, string>;
    const denied = query.get('error');
    const code = query.get('code');
    if (denied || !code) {
      outcome = { error: denied && /^[a-z_]{1,40}$/.test(denied) ? denied : 'access_denied' };
    } else {
      const grant = randomBytes(32).toString('base64url');
      const waiting: WaitingGrant = {
        kind: 'installed-grant',
        provider: flow.provider,
        challenge: flow.challenge,
        code,
        scopes: flow.scopes,
      };
      await this.deps.store.set(`installed-grant:${grant}`, waiting, INSTALLED_FLOW_TTL_MS);
      outcome = { grant };
    }
    // The outcome is written once: a replayed redirect finds it there and changes nothing.
    await this.deps.store.set(key, { ...flow, outcome }, INSTALLED_FLOW_TTL_MS);
    return { kind: 'back', state };
  }

  /**
   * The service's callback for the flow `state` names, with its outcome: for the
   * person who started it only (`userId`), `null` otherwise or while it waits.
   */
  async callbackUrlOf(state: string, userId: string): Promise<string | null> {
    if (!STATE_PATTERN.test(state)) return null;
    const flow = await this.deps.store.get(`installed-connect:${state}`);
    if (!isFlow(flow) || !flow.outcome || flow.userId !== userId) return null;
    const url = new URL(flow.returnUrl);
    url.searchParams.set('state', state);
    for (const [name, value] of Object.entries(flow.outcome)) url.searchParams.set(name, value);
    return url.href;
  }

  /** The person's flow in progress: `pending`, `done` with the callback, or `none`. */
  async statusOf(
    userId: string,
  ): Promise<
    { readonly status: 'pending' | 'none' } | { readonly status: 'done'; readonly location: string }
  > {
    const state = await this.deps.store.get(userKey(userId));
    if (typeof state !== 'string') return { status: 'none' };
    const flow = await this.deps.store.get(`installed-connect:${state}`);
    if (!isFlow(flow) || flow.userId !== userId) return { status: 'none' };
    const location = await this.callbackUrlOf(state, userId);
    if (!location) return { status: 'pending' };
    // Handed once: the window that polls goes to the callback, which consumes the flow.
    await this.deps.store.delete(userKey(userId));
    return { status: 'done', location };
  }

  /** The grant the browser came back with, once, for the verifier of its flow. */
  async redeem(grant: string, verifier: string): Promise<RedeemedGrant> {
    const key = `installed-grant:${grant}`;
    const waiting = await this.deps.store.get(key);
    await this.deps.store.delete(key);
    if (!isGrant(waiting) || !sameText(waiting.challenge, challengeOf(verifier))) {
      throw this.error('redeem', 'the grant is unknown, used or late', 400, GRANT_GONE_CODE);
    }
    const { client, definition } = this.clientOf(waiting.provider, 'redeem');
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: waiting.code,
      redirect_uri: this.deps.redirectUri.href,
      client_id: client.clientId,
      code_verifier: verifier,
    });
    if (client.clientSecret) body.set('client_secret', client.clientSecret);
    const answer = await this.post('redeem', definition.tokenEndpoint, body);
    const accessToken = answer.access_token;
    const refreshToken = answer.refresh_token;
    if (typeof accessToken !== 'string' || accessToken === '') {
      throw this.error('redeem', 'answered no access_token', 200, null);
    }
    if (typeof refreshToken !== 'string' || refreshToken === '') {
      throw this.error('redeem', 'answered no refresh_token', 200, null);
    }
    return {
      refreshToken,
      accessToken,
      expiresAt: this.expiryOf(answer.expires_in),
      account: null,
      scopes:
        typeof answer.scope === 'string'
          ? answer.scope.split(' ').filter(Boolean)
          : [...waiting.scopes],
    };
  }

  /** A fresh access token; `refreshToken` when the provider rotated it (Microsoft). */
  async token(provider: string, refreshToken: string): Promise<RotatedToken> {
    const { client, definition } = this.clientOf(provider, 'token');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client.clientId,
    });
    if (client.clientSecret) body.set('client_secret', client.clientSecret);
    const answer = await this.post('token', definition.tokenEndpoint, body);
    const accessToken = answer.access_token;
    if (typeof accessToken !== 'string' || accessToken === '') {
      throw this.error('token', 'answered no access_token', 200, null);
    }
    const rotated = answer.refresh_token;
    return {
      accessToken,
      expiresAt: this.expiryOf(answer.expires_in),
      scopes: typeof answer.scope === 'string' ? answer.scope.split(' ').filter(Boolean) : null,
      ...(typeof rotated === 'string' && rotated !== '' ? { refreshToken: rotated } : {}),
    };
  }

  /** Google revokes the refresh token; Microsoft has no endpoint for one (the owner removes the app). */
  async revoke(provider: string, refreshToken: string): Promise<void> {
    const { definition } = this.clientOf(provider, 'revoke');
    if (!definition.revokeEndpoint) return;
    await this.post(
      'revoke',
      definition.revokeEndpoint,
      new URLSearchParams({ token: refreshToken }),
    );
  }

  private expiryOf(expiresIn: unknown): string | null {
    const seconds = typeof expiresIn === 'number' ? expiresIn : Number(expiresIn);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return new Date(this.deps.now().getTime() + seconds * 1000).toISOString();
  }

  private async post(
    call: BrokerCall,
    endpoint: string,
    body: URLSearchParams,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.deps.fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw this.error(call, `the provider could not be reached (${String(err)})`, 0, null);
    }
    const answer: unknown = await response.json().catch(() => null);
    if (response.ok) return isRecord(answer) ? answer : {};
    const raw = isRecord(answer) ? answer.error : undefined;
    const code = typeof raw === 'string' && /^[a-z_]{1,40}$/.test(raw) ? raw : null;
    throw this.error(
      call,
      `the provider answered ${response.status}${code ? ` (${code})` : ''}`,
      response.status,
      code,
    );
  }
}
