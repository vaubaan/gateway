/**
 * Generic OpenID Connect relying party (ADR D2, plan §3.4) over
 * `openid-client` v6: discovery, authorization-code grant with PKCE (S256),
 * `state` and `nonce`, ID-token validation, optional userinfo merge.
 *
 * Two facts drive the shape (research note `v5-process-shape.md` §6):
 * - `authorizationCodeGrant` validates the callback against `currentUrl`.
 *   Behind the TLS terminator `request.url` shows the internal host, so the
 *   callback URL is always rebuilt from the configured `public_url` plus the
 *   incoming query string — never from `request.url` or forwarded headers.
 * - `discovery()` is a network call: the `Configuration` is cached per
 *   (issuer, client id, client secret) and dropped on the first failure so
 *   the next attempt rediscovers. `// single-process only` as a cache: a
 *   replica rediscovers on its own, nothing to share.
 */
import * as oidc from 'openid-client';

import { errorMessage } from '../config/errors';
import { issuerKey, LEGACY_PROVIDER_ID } from '../config/sign-in';
import type { IdpConfig } from '../config/types';
import type { RawClaims } from './claims';
import { LoginError } from './errors';

export const CALLBACK_PATH = '/auth/callback';
const BASE_SCOPES = ['openid', 'profile', 'email'] as const;
/** Added only when the IdP advertises it (Okta, Keycloak); Google refuses unknown scopes. */
const GROUPS_SCOPE = 'groups';
/** Tolerated skew between the IdP's clock and ours when validating the ID token. */
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 60;

export type CustomFetch = oidc.CustomFetch;

export interface RelyingPartyOptions {
  readonly publicUrl: URL;
  /** Routes the RP's outbound HTTP (corporate proxy, in-process IdP fixture in tests). */
  readonly fetch?: CustomFetch;
  /** Tests only: lets an `http://` issuer through (`allowInsecureRequests`). */
  readonly allowInsecureRequests?: boolean;
  readonly clockToleranceSeconds?: number;
}

export interface StartedLogin {
  readonly redirectTo: URL;
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
}

export interface LoginChecks {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
}

export interface FinishedLogin {
  /** The ID token's claims over the userinfo answer: `iss`, `sub` and every signed claim win. */
  readonly claims: RawClaims;
  /**
   * The IdP advertises a userinfo endpoint and the request to it failed: `claims`
   * is the ID token alone. Not fatal by itself — the claim mapping decides whether
   * what is missing was needed (`mapClaims`: groups that are in neither).
   */
  readonly userinfoFailed: boolean;
  /** Problems for the server log (the userinfo failure and its cause). */
  readonly warnings: readonly string[];
}

export interface OidcRelyingParty {
  /** Issuer identifier and the discovered authorization endpoint (for the Admin page). */
  describe(): Promise<{ issuer: string; authorizationEndpoint: string | null }>;
  start(): Promise<StartedLogin>;
  /** `callbackUrl` must be rebuilt from `public_url` + the request's query string. */
  finish(callbackUrl: URL, checks: LoginChecks): Promise<FinishedLogin>;
}

/** What discovery and the code grant need of a provider. */
export type RelyingPartySettings = Pick<IdpConfig, 'issuer' | 'clientId' | 'clientSecret'>;

export interface RelyingPartyFactory {
  /** `redirectUri`: the provider's callback (default: the single provider's, `redirectUri`). */
  for(settings: RelyingPartySettings, redirectUri?: URL): OidcRelyingParty;
  /** The redirect URI of the single provider `idp`: `<public_url><CALLBACK_PATH>`. */
  readonly redirectUri: URL;
  /**
   * Fetches the issuer's discovery document the way a sign-in does, before an OpenID
   * Connect provider is saved: `null` when it is valid (its `issuer` is this issuer),
   * otherwise why not, in words for the form. Nothing is cached.
   */
  checkIssuer(issuer: URL): Promise<string | null>;
}

/** How long the form waits for an issuer's discovery document. */
const ISSUER_CHECK_TIMEOUT_SECONDS = 10;

/**
 * The callback of a sign-in provider: `<public_url>/auth/callback/<id>`, and for the
 * provider `idp` the address an identity provider already has registered,
 * `<public_url>/auth/callback`. Without an id: that legacy address.
 */
export function callbackUrl(publicUrl: URL, providerId?: string): URL {
  const base = `${publicUrl.pathname.replace(/\/$/, '')}${CALLBACK_PATH}`;
  const path =
    providerId === undefined || providerId === LEGACY_PROVIDER_ID
      ? base
      : `${base}/${encodeURIComponent(providerId)}`;
  return new URL(path, publicUrl.origin);
}

export function createRelyingPartyFactory(options: RelyingPartyOptions): RelyingPartyFactory {
  const redirectUri = callbackUrl(options.publicUrl);
  // single-process only — a discovery cache; every replica rediscovers for itself.
  const configurations = new Map<string, Promise<oidc.Configuration>>();

  function cacheKey(settings: RelyingPartySettings): string {
    return `${settings.issuer.href}\u0000${settings.clientId}\u0000${settings.clientSecret}`;
  }

  function configurationFor(settings: RelyingPartySettings): Promise<oidc.Configuration> {
    const key = cacheKey(settings);
    let pending = configurations.get(key);
    if (!pending) {
      pending = discover(settings, options);
      configurations.set(key, pending);
      pending.catch(() => {
        if (configurations.get(key) === pending) configurations.delete(key);
      });
    }
    return pending;
  }

  return {
    redirectUri,
    async checkIssuer(issuer) {
      try {
        await discoveryOf(issuer, options, { timeoutSeconds: ISSUER_CHECK_TIMEOUT_SECONDS });
        return null;
      } catch (err) {
        return issuerCheckProblem(issuer, err);
      }
    },
    for(settings, providerRedirectUri = redirectUri) {
      return {
        async describe() {
          const config = await configurationFor(settings);
          const meta = config.serverMetadata();
          return {
            issuer: meta.issuer,
            authorizationEndpoint: meta.authorization_endpoint ?? null,
          };
        },

        async start() {
          const config = await configurationFor(settings);
          const codeVerifier = oidc.randomPKCECodeVerifier();
          const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
          const state = oidc.randomState();
          const nonce = oidc.randomNonce();
          const redirectTo = oidc.buildAuthorizationUrl(config, {
            redirect_uri: providerRedirectUri.href,
            scope: scopesFor(config),
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
            state,
            nonce,
          });
          return { redirectTo, state, nonce, codeVerifier };
        },

        async finish(url, checks) {
          const config = await configurationFor(settings);
          let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
          try {
            tokens = await oidc.authorizationCodeGrant(config, url, {
              expectedState: checks.state,
              expectedNonce: checks.nonce,
              pkceCodeVerifier: checks.codeVerifier,
              idTokenExpected: true,
            });
          } catch (err) {
            throw classifyGrantError(err);
          }
          const idToken = tokens.claims();
          if (!idToken) throw new LoginError('idp-error', 'no ID token in the token response');
          const warnings: string[] = [];
          let userinfo: RawClaims = {};
          let userinfoFailed = false;
          if (config.serverMetadata().userinfo_endpoint && tokens.access_token) {
            try {
              userinfo = await oidc.fetchUserInfo(config, tokens.access_token, idToken.sub);
            } catch (err) {
              userinfoFailed = true;
              warnings.push(`userinfo request failed: ${errorMessage(err)}`);
            }
          }
          // ID token claims win: they are signed by the issuer and bound to the nonce.
          return { claims: { ...userinfo, ...idToken }, userinfoFailed, warnings };
        },
      };
    },
  };
}

async function discover(
  settings: RelyingPartySettings,
  options: RelyingPartyOptions,
): Promise<oidc.Configuration> {
  try {
    return await discoveryOf(settings.issuer, options, {
      clientId: settings.clientId,
      clientAuth: oidc.ClientSecretPost(settings.clientSecret),
    });
  } catch (err) {
    throw new LoginError('discovery-failed', `${settings.issuer.href}: ${errorMessage(err)}`, {
      cause: err,
    });
  }
}

/**
 * `<issuer>/.well-known/openid-configuration`, fetched and validated by
 * `openid-client` (an answer whose `issuer` is not this issuer is refused). Without a
 * client, for the form's check: no request beyond the discovery document is made.
 */
async function discoveryOf(
  issuer: URL,
  options: RelyingPartyOptions,
  client: {
    readonly clientId?: string;
    readonly clientAuth?: oidc.ClientAuth;
    readonly timeoutSeconds?: number;
  },
): Promise<oidc.Configuration> {
  const metadata: Partial<oidc.ClientMetadata> = {
    [oidc.clockTolerance]: options.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS,
  };
  const discoveryOptions: oidc.DiscoveryRequestOptions = {};
  if (options.fetch) discoveryOptions[oidc.customFetch] = options.fetch;
  if (options.allowInsecureRequests) discoveryOptions.execute = [oidc.allowInsecureRequests];
  if (client.timeoutSeconds !== undefined) discoveryOptions.timeout = client.timeoutSeconds;
  return oidc.discovery(
    issuer,
    client.clientId ?? DISCOVERY_CHECK_CLIENT_ID,
    metadata,
    client.clientAuth ?? oidc.None(),
    discoveryOptions,
  );
}

/** The client id of the form's check: discovery sends it nowhere. */
const DISCOVERY_CHECK_CLIENT_ID = 'vaubaan-discovery-check';

/** Why the discovery document of `issuer` was refused, for the form. */
function issuerCheckProblem(issuer: URL, err: unknown): string {
  const where = new URL('.well-known/openid-configuration', issuerKey(issuer) + '/').href;
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED') {
    const named = discoveredIssuer(err);
    return (
      `the discovery document at ${where} names another issuer` +
      (named ? ` (${named})` : '') +
      ': give the issuer exactly as the provider writes it there'
    );
  }
  if (code === 'OAUTH_RESPONSE_IS_NOT_CONFORM') {
    const response = (err as { cause?: unknown }).cause;
    const status = response instanceof Response ? ` (HTTP ${response.status})` : '';
    return `there is no OpenID Connect discovery document at ${where}${status}: check the issuer`;
  }
  if (typeof code === 'string' && NOT_A_DISCOVERY_DOCUMENT.has(code)) {
    return `${where} is not a valid OpenID Connect discovery document: check the issuer`;
  }
  return `the discovery document at ${where} could not be fetched (${errorMessage(err)}): check the issuer, and that the gateway can reach it`;
}

/** What `openid-client` says of a discovery answer it refused (oauth4webapi's codes). */
const NOT_A_DISCOVERY_DOCUMENT: ReadonlySet<string> = new Set([
  'OAUTH_RESPONSE_IS_NOT_JSON',
  'OAUTH_PARSE_ERROR',
  'OAUTH_INVALID_RESPONSE',
]);

/** The `issuer` an issuer-mismatch error carries (`cause.body.issuer`), when there is one. */
function discoveredIssuer(err: unknown): string | null {
  const cause = (err as { cause?: unknown }).cause;
  const body = (cause as { body?: unknown } | null | undefined)?.body;
  const named = (body as { issuer?: unknown } | null | undefined)?.issuer;
  return typeof named === 'string' ? named : null;
}

function scopesFor(config: oidc.Configuration): string {
  const supported = config.serverMetadata().scopes_supported ?? [];
  const scopes: string[] = [...BASE_SCOPES];
  if (supported.includes(GROUPS_SCOPE)) scopes.push(GROUPS_SCOPE);
  return scopes.join(' ');
}

const CSRF_CHECK_CODES = new Set(['OAUTH_INVALID_RESPONSE', 'OAUTH_JWT_CLAIM_COMPARISON_FAILED']);

/** `openid-client` wraps oauth4webapi's errors; the state / nonce checks surface
 *  as an error (or a `cause`) carrying one of `CSRF_CHECK_CODES` and naming the parameter. */
function classifyGrantError(err: unknown): LoginError {
  if (err instanceof LoginError) return err;
  if (err instanceof oidc.AuthorizationResponseError) {
    return new LoginError('idp-error', `${err.error}: ${err.error_description ?? ''}`.trim(), {
      cause: err,
    });
  }
  for (const e of causeChain(err)) {
    const code = (e as { code?: unknown }).code;
    if (
      typeof code === 'string' &&
      CSRF_CHECK_CODES.has(code) &&
      /"(state|nonce)"/.test(e.message)
    ) {
      return new LoginError('state-mismatch', e.message, { cause: err });
    }
  }
  return new LoginError('idp-error', errorMessage(err), { cause: err });
}

function* causeChain(err: unknown): Generator<Error> {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    yield current;
    current = current.cause;
  }
}
