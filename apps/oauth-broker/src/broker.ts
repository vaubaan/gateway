/**
 * The broker's core: the five calls of the gateway API and the browser
 * callback (handbook oauth-broker-contract). It knows no platform (the
 * attestation is served from src/attestation.ts) and no listener
 * (src/server.ts).
 */
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { type AttestationCache } from './attestation.ts';
import { type BrokerConfig, type Enrollment, isAllowedUrl } from './config.ts';
import { s256, safeEqual, sha256 } from './crypto-util.ts';
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
import { type ProviderDefinition, type ProviderTable } from './providers.ts';
import { type AttestRateLimit, type RefreshLimit } from './rate-limit.ts';
import { type TokenSealer } from './sealing.ts';

export interface BrokerDeps {
  readonly config: BrokerConfig;
  readonly providers: ProviderTable;
  /** Provider id → client secret, unsealed at start. */
  readonly secrets: ReadonlyMap<string, string>;
  /** `null` without an enclave (platform `unattested`): `/attest` then answers 404. */
  readonly attestation: AttestationCache | null;
  readonly flows: FlowStore;
  readonly oauth: OAuthClient;
  readonly attestLimit: AttestRateLimit;
  /** Refreshes per instance and per hour, so one instance cannot spend the shared client's quota. */
  readonly refreshLimit: RefreshLimit;
  /** Seals the refresh tokens of the redeem to their instance. */
  readonly sealer: TokenSealer;
}

const STATE = /^[A-Za-z0-9_-]{20,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/; // RFC 7636 §4.1
const GRANT = /^[A-Za-z0-9_-]{16,128}$/;
const SEALED_TOKEN = /^[\x21-\x7e]{1,8192}$/;
const PROVIDER = /^[a-z0-9-]{1,40}$/;
const ERROR_CODE = /^[a-z_]{1,40}$/;
const BEARER = /^Bearer ([\x21-\x7e]{1,512})$/;
const MAX_SCOPES = 20;

/**
 * Why a redeem was refused, logged and never answered: the gateway gets one
 * `invalid_grant` whatever the cause (the grant is spent either way).
 */
type RedeemRefusal =
  | 'grant_unknown' // no flow: never issued, spent or past its lifetime
  | 'consent_incomplete' // the flow has no code: the callback never brought one
  | 'flow_mismatch' // another instance's key, or a verifier that does not match
  | 'provider_not_served'
  | 'provider_refused' // the provider answered invalid_grant to the code exchange
  | 'provider_unavailable' // the provider failed or did not answer
  | 'no_refresh_token';

const invalidGrant = (reason: RedeemRefusal): HttpError =>
  new HttpError(400, 'invalid_grant', 'the grant cannot be redeemed', reason);
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

  /**
   * Answers one call of the gateway API. Resolves to the broker's fixed
   * reason code of an answer that needs one in the access log (a success
   * that did less than its name says), or `undefined`.
   */
  async handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    route: string,
  ): Promise<string | undefined> {
    // `/attest` carries no key and no body: the gateway sends nothing before
    // it has verified the connection, and the answer is the public token in
    // memory. Rate-limited, generously.
    if (route === '/attest') {
      if (this.#deps.attestation === null) {
        throw new HttpError(404, 'not_attested', 'this broker runs without an enclave');
      }
      if (!this.#deps.attestLimit.allow(req.socket.remoteAddress ?? '')) {
        res.setHeader('retry-after', '1');
        throw new HttpError(429, 'rate_limited', 'too many attestation requests');
      }
      sendJson(res, 200, this.#attest());
      return undefined;
    }
    const instance = this.authenticate(req);
    const body = await readJsonObject(req);
    switch (route) {
      case '/flows':
        sendJson(res, 201, this.#startFlow(instance, body));
        return undefined;
      case '/grants/redeem':
        sendJson(res, 200, await this.#redeem(instance, body));
        return undefined;
      case '/token': {
        const wait = this.#deps.refreshLimit.take(instance.id);
        if (wait > 0) {
          res.setHeader('retry-after', String(wait));
          throw new HttpError(
            429,
            'rate_limited',
            'too many refreshes for this instance this hour',
            'refresh_limit',
          );
        }
        sendJson(res, 200, await this.#refresh(instance, body));
        return undefined;
      }
      case '/revoke': {
        const relayed = await this.#revoke(instance, body);
        sendEmpty(res, 204);
        // Microsoft has no revocation endpoint: nothing was sent, the gateway's erasure is all.
        return relayed ? undefined : 'no_revoke_endpoint';
      }
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
    // On record as a digest only; the browser goes back to the URL the gateway sent.
    const returnUrl = body.return_url;
    if (
      typeof returnUrl !== 'string' ||
      returnUrl.length > 2048 ||
      !isAllowedUrl(returnUrl) ||
      !instance.returnUrlDigests.has(sha256(returnUrl).toString('hex'))
    ) {
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
    const started = this.#deps.flows.start({
      instanceId: instance.id,
      provider: definition.id,
      scopes,
      returnUrl,
      gatewayState: state,
      gatewayChallenge: challenge,
    });
    if ('full' in started) {
      throw started.full === 'instance'
        ? new HttpError(429, 'rate_limited', 'too many flows in progress for this instance')
        : new HttpError(503, 'temporarily_unavailable', 'too many flows in progress');
    }
    const { flow } = started;

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
    if (flow === undefined) throw invalidGrant('grant_unknown');
    if (flow.code === undefined) throw invalidGrant('consent_incomplete');
    if (
      verifier === undefined ||
      flow.instanceId !== instance.id ||
      !safeEqual(s256(verifier), flow.gatewayChallenge)
    ) {
      throw invalidGrant('flow_mismatch');
    }
    const served = this.#served.get(flow.provider);
    if (served === undefined) throw invalidGrant('provider_not_served');
    // Only now does the code leave the flow (ADR D1).
    const result = await this.#deps.oauth.exchangeCode(
      served.definition,
      served.client,
      flow.code,
      this.redirectUri(flow.provider),
      flow.brokerVerifier,
    );
    if (!result.ok) {
      throw invalidGrant(result.reason === 'refused' ? 'provider_refused' : 'provider_unavailable');
    }
    const tokens = result.value;
    const refreshToken = tokens.refreshToken;
    if (refreshToken === undefined) throw invalidGrant('no_refresh_token');
    return {
      // Sealed to this instance: worthless to any other key (src/sealing.ts).
      refresh_token: this.#deps.sealer.seal(instance.id, flow.provider, refreshToken),
      access_token: tokens.accessToken,
      expires_at: tokens.expiresAt,
      account: tokens.account,
      scopes: tokens.scopes ?? flow.scopes,
    };
  }

  /** The provider's refresh token inside the blob, for the instance that sealed it only. */
  #refreshToken(instance: Enrollment, served: Served, body: Record<string, unknown>): string {
    const blob = field(body, 'refresh_token', SEALED_TOKEN);
    if (blob === undefined) {
      throw new HttpError(400, 'invalid_request', 'refresh_token is malformed');
    }
    const token = this.#deps.sealer.open(instance.id, served.definition.id, blob);
    if (token === undefined) {
      throw new HttpError(400, 'invalid_grant', 'the refresh token is not this instance’s');
    }
    return token;
  }

  async #refresh(
    instance: Enrollment,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const served = this.#servedFor(body);
    const result = await this.#deps.oauth.refresh(
      served.definition,
      served.client,
      this.#refreshToken(instance, served, body),
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

  /** Whether the revocation was relayed to the provider (it has an endpoint). */
  async #revoke(instance: Enrollment, body: Record<string, unknown>): Promise<boolean> {
    const served = this.#servedFor(body);
    const result = await this.#deps.oauth.revoke(
      served.definition,
      served.client,
      this.#refreshToken(instance, served, body),
    );
    if (!result.ok) throw unavailable();
    return result.value.relayed;
  }

  #attest(): { platform: string; evidence: string } {
    const current = this.#deps.attestation?.current();
    if (current === undefined) {
      throw new HttpError(503, 'temporarily_unavailable', 'no fresh attestation yet');
    }
    return { platform: current.platform, evidence: current.evidence };
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
