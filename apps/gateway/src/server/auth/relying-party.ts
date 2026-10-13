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
  readonly claims: RawClaims;
  /** Non-fatal problems (userinfo unreachable…) for the server log. */
  readonly warnings: readonly string[];
}

export interface OidcRelyingParty {
  /** Issuer identifier and the discovered authorization endpoint (for the Admin page). */
  describe(): Promise<{ issuer: string; authorizationEndpoint: string | null }>;
  start(): Promise<StartedLogin>;
  /** `callbackUrl` must be rebuilt from `public_url` + the request's query string. */
  finish(callbackUrl: URL, checks: LoginChecks): Promise<FinishedLogin>;
}

export interface RelyingPartyFactory {
  for(settings: IdpConfig): OidcRelyingParty;
  /** The redirect URI registered at the IdP: `<public_url><CALLBACK_PATH>`. */
  readonly redirectUri: URL;
}

export function callbackUrl(publicUrl: URL): URL {
  return new URL(`${publicUrl.pathname.replace(/\/$/, '')}${CALLBACK_PATH}`, publicUrl.origin);
}

export function createRelyingPartyFactory(options: RelyingPartyOptions): RelyingPartyFactory {
  const redirectUri = callbackUrl(options.publicUrl);
  // single-process only — a discovery cache; every replica rediscovers for itself.
  const configurations = new Map<string, Promise<oidc.Configuration>>();

  function cacheKey(settings: IdpConfig): string {
    return `${settings.issuer.href}\u0000${settings.clientId}\u0000${settings.clientSecret}`;
  }

  function configurationFor(settings: IdpConfig): Promise<oidc.Configuration> {
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
    for(settings) {
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
            redirect_uri: redirectUri.href,
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
          if (config.serverMetadata().userinfo_endpoint && tokens.access_token) {
            try {
              userinfo = await oidc.fetchUserInfo(config, tokens.access_token, idToken.sub);
            } catch (err) {
              warnings.push(`userinfo request failed: ${errorMessage(err)}`);
            }
          }
          // ID token claims win: they are signed by the issuer and bound to the nonce.
          return { claims: { ...userinfo, ...idToken }, warnings };
        },
      };
    },
  };
}

async function discover(
  settings: IdpConfig,
  options: RelyingPartyOptions,
): Promise<oidc.Configuration> {
  const metadata: Partial<oidc.ClientMetadata> = {
    [oidc.clockTolerance]: options.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS,
  };
  const discoveryOptions: oidc.DiscoveryRequestOptions = {};
  if (options.fetch) discoveryOptions[oidc.customFetch] = options.fetch;
  if (options.allowInsecureRequests) discoveryOptions.execute = [oidc.allowInsecureRequests];
  try {
    return await oidc.discovery(
      settings.issuer,
      settings.clientId,
      metadata,
      oidc.ClientSecretPost(settings.clientSecret),
      discoveryOptions,
    );
  } catch (err) {
    throw new LoginError('discovery-failed', `${settings.issuer.href}: ${errorMessage(err)}`, {
      cause: err,
    });
  }
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
