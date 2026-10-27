/**
 * The broker's core: the five calls of the gateway API and the browser
 * callback (handbook oauth-broker-contract). It knows no platform (the
 * adapter is behind `attest`) and no listener (src/server.ts).
 */
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { type BrokerConfig, type Enrollment } from './config.ts';
import { isBase64Url32, s256, safeEqual, sha256 } from './crypto-util.ts';
import { type Flow, type FlowStore } from './flows.ts';
import {
  field,
  HttpError,
  readJsonObject,
  sendEmpty,
  sendJson,
  sendRedirect,
  sendText,
} from './http-util.ts';
import { type ClientCredentials, type OAuthClient } from './oauth-client.ts';
import { type PlatformAdapter } from './platform/types.ts';
import { type ProviderDefinition, type ProviderTable } from './providers.ts';
import { type AttestRateLimit } from './rate-limit.ts';

export interface BrokerDeps {
  readonly config: BrokerConfig;
  readonly providers: ProviderTable;
  /** Provider id → client secret, unsealed at start. */
  readonly secrets: ReadonlyMap<string, string>;
  readonly platform: PlatformAdapter;
  readonly publicKeySha256: string;
  readonly flows: FlowStore;
  readonly oauth: OAuthClient;
  readonly attestLimit: AttestRateLimit;
}

const STATE = /^[A-Za-z0-9_-]{20,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/; // RFC 7636 §4.1
const GRANT = /^[A-Za-z0-9_-]{16,128}$/;
const TOKEN = /^[\x21-\x7e]{1,4096}$/;
const PROVIDER = /^[a-z0-9-]{1,40}$/;
const ERROR_CODE = /^[a-z_]{1,40}$/;
const BEARER = /^Bearer ([\x21-\x7e]{1,512})$/;
const MAX_SCOPES = 20;

const invalidGrant = (): HttpError =>
  new HttpError(400, 'invalid_grant', 'the grant cannot be redeemed');
const unavailable = (): HttpError =>
  new HttpError(502, 'temporarily_unavailable', 'the provider could not be reached');

interface Served {
  readonly definition: ProviderDefinition;
  readonly client: ClientCredentials;
}

export class Broker {
  readonly #deps: BrokerDeps;
  readonly #served = new Map<string, Served>();

  constructor(deps: BrokerDeps) {
    this.#deps = deps;
    for (const [id, client] of deps.config.clients) {
      const definition = deps.providers.get(id);
      const clientSecret = deps.secrets.get(id);
      if (definition !== undefined && clientSecret !== undefined) {
        this.#served.set(id, { definition, client: { clientId: client.clientId, clientSecret } });
      }
    }
  }

  /** The broker's redirect URI for a provider, registered with the OAuth client. */
  redirectUri(provider: string): string {
    return `${this.#deps.config.publicUrl}/oauth/callback/${provider}`;
  }

  // ---- gateway API ------------------------------------------------------

  /** The instance whose key the request carries; every digest is compared. */
  authenticate(req: IncomingMessage): Enrollment {
    const match = BEARER.exec(req.headers.authorization ?? '');
    if (match?.[1] === undefined)
      throw new HttpError(401, 'invalid_key', 'a broker key is required');
    const digest = sha256(match[1]);
    let found: Enrollment | undefined;
    for (const instance of this.#deps.config.instances) {
      if (safeEqual(digest, instance.keyDigest)) found = instance;
    }
    if (found === undefined)
      throw new HttpError(401, 'invalid_key', 'the broker key is not enrolled');
    return found;
  }

  async handleApi(req: IncomingMessage, res: ServerResponse, route: string): Promise<void> {
    // `/attest` carries no key: the gateway sends no secret before it has
    // verified the connection, and the evidence is public. It is rate-limited.
    if (route === '/attest') {
      if (!this.#deps.attestLimit.allow(req.socket.remoteAddress ?? '')) {
        res.setHeader('retry-after', '2');
        throw new HttpError(429, 'rate_limited', 'too many attestation requests');
      }
      return sendJson(res, 200, await this.#attest(await readJsonObject(req)));
    }
    const instance = this.authenticate(req);
    const body = await readJsonObject(req);
    switch (route) {
      case '/flows':
        return sendJson(res, 201, this.#startFlow(instance, body));
      case '/grants/redeem':
        return sendJson(res, 200, await this.#redeem(instance, body));
      case '/token':
        return sendJson(res, 200, await this.#refresh(body));
      case '/revoke':
        await this.#revoke(body);
        return sendEmpty(res, 204);
      default:
        throw new HttpError(404, 'not_found', 'no such call');
    }
  }

  #servedFor(body: Record<string, unknown>): Served {
    const id = field(body, 'provider', PROVIDER);
    const served = id === undefined ? undefined : this.#served.get(id);
    if (served === undefined)
      throw new HttpError(400, 'unsupported_provider', 'this broker does not serve it');
    return served;
  }

  #startFlow(instance: Enrollment, body: Record<string, unknown>): { authorize_url: string } {
    const { definition, client } = this.#servedFor(body);
    const scopes = body.scopes;
    if (
      !Array.isArray(scopes) ||
      scopes.length === 0 ||
      scopes.length > MAX_SCOPES ||
      new Set(scopes).size !== scopes.length ||
      !scopes.every((s): s is string => typeof s === 'string' && definition.allowedScopes.has(s))
    ) {
      throw new HttpError(
        400,
        'invalid_scope',
        'a scope is not one this provider may be asked for',
      );
    }
    const returnUrl = body.return_url;
    if (typeof returnUrl !== 'string' || !instance.returnUrls.has(returnUrl)) {
      throw new HttpError(
        403,
        'return_url_not_registered',
        'return_url is not on record for this instance',
      );
    }
    const state = field(body, 'state', STATE);
    const challenge = field(body, 'challenge', CHALLENGE);
    if (state === undefined || challenge === undefined || body.challenge_method !== 'S256') {
      throw new HttpError(
        400,
        'invalid_request',
        'state, challenge or challenge_method is malformed',
      );
    }
    const flow = this.#deps.flows.start({
      instanceId: instance.id,
      provider: definition.id,
      scopes,
      returnUrl,
      gatewayState: state,
      gatewayChallenge: challenge,
    });
    if (flow === undefined)
      throw new HttpError(503, 'temporarily_unavailable', 'too many flows in progress');

    const url = new URL(definition.authorizeEndpoint);
    const params: Record<string, string> = {
      client_id: client.clientId,
      redirect_uri: this.redirectUri(definition.id),
      response_type: 'code',
      scope: scopes.join(' '),
      state: flow.id,
      code_challenge: s256(flow.brokerVerifier),
      code_challenge_method: 'S256',
      ...definition.authorizeParams,
    };
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    return { authorize_url: url.toString() };
  }

  async #redeem(
    instance: Enrollment,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const grant = field(body, 'grant', GRANT);
    const verifier = field(body, 'verifier', VERIFIER);
    // Spent by this attempt, whatever follows.
    const flow = grant === undefined ? undefined : this.#deps.flows.takeByGrant(grant);
    if (
      flow?.code === undefined ||
      verifier === undefined ||
      flow.instanceId !== instance.id ||
      !safeEqual(s256(verifier), flow.gatewayChallenge)
    ) {
      throw invalidGrant();
    }
    const served = this.#served.get(flow.provider);
    if (served === undefined) throw invalidGrant();
    // Only now does the code leave the flow (ADR D1).
    const result = await this.#deps.oauth.exchangeCode(
      served.definition,
      served.client,
      flow.code,
      this.redirectUri(flow.provider),
      flow.brokerVerifier,
    );
    if (!result.ok || result.value.refreshToken === undefined) throw invalidGrant();
    const tokens = result.value;
    return {
      refresh_token: tokens.refreshToken,
      access_token: tokens.accessToken,
      expires_at: tokens.expiresAt,
      account: tokens.account,
      scopes: tokens.scopes ?? flow.scopes,
    };
  }

  #refreshToken(body: Record<string, unknown>): string {
    const token = field(body, 'refresh_token', TOKEN);
    if (token === undefined)
      throw new HttpError(400, 'invalid_request', 'refresh_token is malformed');
    return token;
  }

  async #refresh(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const served = this.#servedFor(body);
    const result = await this.#deps.oauth.refresh(
      served.definition,
      served.client,
      this.#refreshToken(body),
    );
    if (!result.ok) {
      throw result.reason === 'refused'
        ? new HttpError(400, 'invalid_grant', 'the provider refused the refresh token')
        : unavailable();
    }
    const { accessToken, expiresAt, scopes } = result.value;
    return scopes === undefined
      ? { access_token: accessToken, expires_at: expiresAt }
      : { access_token: accessToken, expires_at: expiresAt, scopes };
  }

  async #revoke(body: Record<string, unknown>): Promise<void> {
    const served = this.#servedFor(body);
    const result = await this.#deps.oauth.revoke(
      served.definition,
      served.client,
      this.#refreshToken(body),
    );
    if (!result.ok) throw unavailable();
  }

  async #attest(body: Record<string, unknown>): Promise<{ platform: string; evidence: string }> {
    const nonce = body.nonce;
    if (typeof nonce !== 'string' || !isBase64Url32(nonce)) {
      throw new HttpError(
        400,
        'invalid_request',
        'nonce must be 32 bytes in base64url without padding',
      );
    }
    try {
      const { platform, evidence } = await this.#deps.platform.attest([
        nonce,
        this.#deps.publicKeySha256,
      ]);
      return { platform, evidence };
    } catch {
      throw new HttpError(503, 'temporarily_unavailable', 'the platform gave no attestation');
    }
  }

  // ---- browser callback -------------------------------------------------

  /** `GET /oauth/callback/<provider>?code&state` or `?error&state`. */
  handleCallback(res: ServerResponse, provider: string, query: URLSearchParams): void {
    const flowId = query.get('state') ?? '';
    const flow: Flow | undefined = this.#deps.flows.awaitingCallback(flowId);
    if (flow === undefined || flow.provider !== provider) {
      return sendText(
        res,
        400,
        'This sign-in has expired or was already used. Start again from your gateway.\n',
      );
    }
    const back = new URL(flow.returnUrl);
    const error = query.get('error');
    const code = query.get('code');
    if (error !== null || code === null || code === '' || code.length > 4096) {
      this.#deps.flows.end(flow);
      const protocolCode = error !== null && ERROR_CODE.test(error) ? error : 'server_error';
      back.searchParams.set('error', protocolCode);
    } else {
      back.searchParams.set('grant', this.#deps.flows.issueGrant(flow, code));
    }
    back.searchParams.set('state', flow.gatewayState);
    sendRedirect(res, back.toString());
  }
}
