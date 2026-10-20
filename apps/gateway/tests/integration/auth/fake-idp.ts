/**
 * An in-process OpenID Connect provider for the integration tests (spec §10
 * "integration on an ephemeral instance with embedded store and simulated
 * IdP"). No listener: it is handed to the relying party as `customFetch` and
 * answers discovery, JWKS, token and userinfo from memory. The "browser" step
 * (`authorize()`) consents on the user's behalf and returns the callback URL
 * the IdP would redirect to.
 *
 * ID tokens are ES256 (P-256) signed with a key generated per instance, with
 * `node:crypto` only. Not for production.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

import type { CustomFetch } from '../../../src/server/auth/relying-party';

export interface FakeIdpOptions {
  readonly issuer?: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Claims returned by userinfo only (not in the ID token), to test the merge. */
  readonly userinfoOnly?: readonly string[];
}

interface IssuedCode {
  readonly nonce: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
  readonly claims: Record<string, unknown>;
  consumed: boolean;
}

export class FakeIdp {
  readonly issuer: URL;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Claims of the user who will consent next (`sub`, `email`, `groups`, `name`…). */
  nextClaims: Record<string, unknown> = {};
  /** Set to make the next authorization fail at the IdP (`error=` on the callback). */
  nextError: string | null = null;
  /** While true, the userinfo endpoint answers 503: tokens are issued, userinfo is down. */
  userinfoDown = false;
  readonly requests: string[] = [];

  private readonly privateKey: KeyObject;
  private readonly publicJwk: Record<string, unknown>;
  private readonly kid = 'fake-idp-key-1';
  private readonly codes = new Map<string, IssuedCode>();
  private readonly accessTokens = new Map<string, Record<string, unknown>>();
  private readonly userinfoOnly: ReadonlySet<string>;

  constructor(options: FakeIdpOptions) {
    this.issuer = new URL(options.issuer ?? 'http://idp.test');
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.userinfoOnly = new Set(options.userinfoOnly ?? []);
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = pair.privateKey;
    this.publicJwk = {
      ...pair.publicKey.export({ format: 'jwk' }),
      kid: this.kid,
      alg: 'ES256',
      use: 'sig',
    };
  }

  private url(path: string): string {
    return new URL(path, this.issuer).href;
  }

  /**
   * The issuer identifier as the ID tokens carry it (`iss`): no trailing slash,
   * unlike `issuer.href`. A user of the instance is `(iss, sub)`.
   */
  get iss(): string {
    return this.issuer.href.replace(/\/$/, '');
  }

  metadata(): Record<string, unknown> {
    return {
      issuer: this.iss,
      authorization_endpoint: this.url('/authorize'),
      token_endpoint: this.url('/token'),
      jwks_uri: this.url('/jwks'),
      userinfo_endpoint: this.url('/userinfo'),
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['ES256'],
      scopes_supported: ['openid', 'profile', 'email', 'groups'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
      code_challenge_methods_supported: ['S256'],
    };
  }

  /** The user-agent step: consent at the authorization endpoint, come back with a code. */
  authorize(authorizationUrl: URL): URL {
    const p = authorizationUrl.searchParams;
    if (authorizationUrl.origin + authorizationUrl.pathname !== this.url('/authorize')) {
      throw new Error(`unexpected authorization endpoint ${authorizationUrl.href}`);
    }
    if (p.get('client_id') !== this.clientId) throw new Error('unknown client_id');
    if (p.get('response_type') !== 'code') throw new Error('response_type must be code');
    if (p.get('code_challenge_method') !== 'S256') throw new Error('PKCE S256 required');
    const redirectUri = p.get('redirect_uri');
    const state = p.get('state');
    const nonce = p.get('nonce');
    const codeChallenge = p.get('code_challenge');
    if (!redirectUri || !state || !nonce || !codeChallenge) {
      throw new Error('redirect_uri, state, nonce and code_challenge are required');
    }
    this.requests.push(`authorize scope=${p.get('scope') ?? ''}`);
    const callback = new URL(redirectUri);
    callback.searchParams.set('state', state);
    if (this.nextError) {
      callback.searchParams.set('error', this.nextError);
      this.nextError = null;
      return callback;
    }
    const code = randomBytes(16).toString('base64url');
    this.codes.set(code, {
      nonce,
      codeChallenge,
      redirectUri,
      claims: { ...this.nextClaims },
      consumed: false,
    });
    callback.searchParams.set('code', code);
    return callback;
  }

  /** `customFetch` for the relying party. */
  readonly fetch: CustomFetch = async (url, options) => {
    const request = new Request(url, {
      method: options.method,
      headers: options.headers,
      // oauth4webapi's FetchBody is wider than the DOM lib's BodyInit (typed arrays); same runtime values.
      body: options.body as BodyInit | null | undefined,
    });
    const target = new URL(url);
    this.requests.push(`${request.method} ${target.pathname}`);
    if (target.origin !== this.issuer.origin) return json({ error: 'wrong host' }, 404);
    switch (`${request.method} ${target.pathname}`) {
      case 'GET /.well-known/openid-configuration':
        return json(this.metadata());
      case 'GET /jwks':
        return json({ keys: [this.publicJwk] });
      case 'POST /token':
        return this.token(new URLSearchParams(await request.text()));
      case 'GET /userinfo':
        if (this.userinfoDown) return json({ error: 'temporarily_unavailable' }, 503);
        return this.userinfo(request.headers.get('authorization'));
      default:
        return json({ error: 'not_found' }, 404);
    }
  };

  private token(form: URLSearchParams): Response {
    if (form.get('grant_type') !== 'authorization_code')
      return oauthError('unsupported_grant_type');
    if (
      form.get('client_id') !== this.clientId ||
      form.get('client_secret') !== this.clientSecret
    ) {
      return oauthError('invalid_client', 401);
    }
    const code = form.get('code') ?? '';
    const issued = this.codes.get(code);
    if (!issued || issued.consumed) return oauthError('invalid_grant');
    issued.consumed = true;
    if (form.get('redirect_uri') !== issued.redirectUri) return oauthError('invalid_grant');
    const verifier = form.get('code_verifier') ?? '';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    if (challenge !== issued.codeChallenge) return oauthError('invalid_grant');

    const idTokenClaims: Record<string, unknown> = {};
    const userinfoClaims: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(issued.claims)) {
      (this.userinfoOnly.has(k) ? userinfoClaims : idTokenClaims)[k] = v;
    }
    const sub = typeof issued.claims.sub === 'string' ? issued.claims.sub : 'anonymous';
    const accessToken = randomBytes(16).toString('base64url');
    this.accessTokens.set(accessToken, { sub, ...userinfoClaims });
    const now = Math.floor(Date.now() / 1000);
    const idToken = this.signJwt({
      iss: this.metadata().issuer,
      aud: this.clientId,
      iat: now,
      exp: now + 300,
      nonce: issued.nonce,
      sub,
      ...idTokenClaims,
    });
    return json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 300,
      id_token: idToken,
    });
  }

  private userinfo(authorization: string | null): Response {
    const token = authorization?.replace(/^Bearer\s+/i, '') ?? '';
    const claims = this.accessTokens.get(token);
    if (!claims) return oauthError('invalid_token', 401);
    return json(claims);
  }

  private signJwt(payload: Record<string, unknown>): string {
    const header = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: this.kid }));
    const body = b64url(JSON.stringify(payload));
    const signature = sign('sha256', Buffer.from(`${header}.${body}`), {
      key: this.privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    return `${header}.${body}.${signature.toString('base64url')}`;
  }
}

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function oauthError(error: string, status = 400): Response {
  return json({ error }, status);
}

/**
 * Answers the discovery document of any issuer with a minimal valid one naming that
 * issuer: for a test that saves an OpenID Connect provider through the form (which
 * checks discovery before saving) and never signs in through it.
 */
export const answerAnyDiscovery: CustomFetch = (url) => {
  const marker = '/.well-known/openid-configuration';
  const at = url.indexOf(marker);
  if (at < 0) return Promise.resolve(oauthError('not_found', 404));
  const issuer = url.slice(0, at);
  return Promise.resolve(
    json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
    }),
  );
};
