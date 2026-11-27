/**
 * Sign-in through Vaubaan's installed-app clients (ADR
 * local-instance-carries-installed-oauth-clients): the sign-in providers a local instance
 * carries, and the OpenID Connect flow of Google and Microsoft with them. GitHub keeps its
 * own flow (`github.ts`), with the loopback as its redirect.
 *
 * Google and Microsoft run the authorization-code flow with `state`, `nonce` and PKCE S256,
 * back on the loopback, and read the identity from the ID token of the token endpoint's
 * answer. That answer comes straight from the provider over TLS, so the token's signature
 * is not checked: TLS authenticates its issuer (OpenID Connect Core §3.1.3.7, item 6). Its
 * audience, issuer, expiry and nonce are. No discovery: the endpoints are the providers'
 * own and fixed, and Microsoft's multi-tenant `common` endpoint names, in every token, the
 * issuer of the person's tenant (`https://login.microsoftonline.com/<tid>/v2.0`), which a
 * library comparing it with the discovery document's templated issuer refuses.
 *
 * A person is (issuer, subject) as everywhere: the issuer recorded is the sign-in
 * provider's (`https://accounts.google.com`, `https://login.microsoftonline.com/common/v2.0`),
 * both open to anyone, so an email is admitted on "verified" only. Google says
 * `email_verified`. Microsoft never does: an address is taken as verified for a personal
 * account (the consumers tenant), or when the token carries the optional claim `xms_edov`
 * (registered on the Entra application, handbook authentication); a work address without
 * it is refused at admission, never trusted (a tenant's administrators set `email`).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { errorMessage } from '../config/errors';
import type { InstalledClient, InstalledProvider } from '../config/installed-clients';
import {
  DEFAULT_CLAIM_MAPPING,
  type GithubSignInProvider,
  type OidcSignInProvider,
  type SignInProvider,
} from '../config/sign-in';
import type { IdentityClaims } from './claims';
import { LoginError } from './errors';
import type { CustomFetch, LoginChecks, StartedLogin } from './relying-party';
import { isRecord } from '@vaubaan/shared';

/** The tenant of personal Microsoft accounts: their addresses are Microsoft's own to verify. */
export const MICROSOFT_CONSUMERS_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUEST_TIMEOUT_MS = 10_000;
const CLOCK_TOLERANCE_SECONDS = 60;

interface OidcEndpoints {
  readonly issuer: string;
  readonly authorize: string;
  readonly token: string;
  readonly scope: string;
  readonly name: string;
  /** Added to the consent URL. */
  readonly params: Readonly<Record<string, string>>;
}

export const INSTALLED_OIDC: Readonly<Record<'google' | 'microsoft', OidcEndpoints>> = {
  google: {
    issuer: 'https://accounts.google.com',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email',
    name: 'Google',
    params: { prompt: 'select_account' },
  },
  microsoft: {
    issuer: 'https://login.microsoftonline.com/common/v2.0',
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'openid email profile',
    name: 'Microsoft',
    params: { prompt: 'select_account', response_mode: 'query' },
  },
};

const GITHUB_NAME = 'GitHub';
/** Where Microsoft's issuers live: `<origin>/<tenant id>/v2.0`. */
const MICROSOFT_LOGIN = new URL(INSTALLED_OIDC.microsoft.authorize).origin;

/**
 * The sign-in providers of the installed clients, by the provider's own id (`google`,
 * `microsoft`, `github`). Invited addresses only (the administrators always pass): a
 * local instance has one person until they invite others.
 */
export function installedSignInProviders(clients: readonly InstalledClient[]): SignInProvider[] {
  return clients.map((client): SignInProvider => {
    const base = {
      id: client.provider,
      clientId: client.clientId,
      clientSecret: client.clientSecret ?? '',
      allowedEmailDomains: [],
      invitationOnly: true,
      installed: client.provider,
    } as const;
    if (client.provider === 'github') {
      const github: GithubSignInProvider = {
        ...base,
        kind: 'github',
        name: GITHUB_NAME,
        issuer: new URL('https://github.com'),
      };
      return github;
    }
    const endpoints = INSTALLED_OIDC[client.provider];
    const oidc: OidcSignInProvider = {
      ...base,
      kind: 'oidc',
      name: endpoints.name,
      issuer: new URL(endpoints.issuer),
      claims: DEFAULT_CLAIM_MAPPING,
      requireVerifiedEmail: true,
    };
    return oidc;
  });
}

export interface InstalledOidcOptions {
  readonly redirectUri: URL;
  readonly fetch?: CustomFetch;
  readonly now?: () => Date;
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The payload of a compact JWT, unverified (see the header: TLS vouches for it). */
function jwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) {
    throw new LoginError('idp-error', 'the ID token is not a compact JWT');
  }
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (isRecord(payload)) return payload;
  } catch {
    // reported below
  }
  throw new LoginError('idp-error', 'the ID token has no readable payload');
}

export class InstalledOidcSignIn {
  private readonly endpoints: OidcEndpoints;
  private readonly fetchImpl: CustomFetch;
  private readonly now: () => Date;

  constructor(
    private readonly signInProvider: OidcSignInProvider,
    private readonly provider: 'google' | 'microsoft',
    private readonly options: InstalledOidcOptions,
  ) {
    this.endpoints = INSTALLED_OIDC[provider];
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init as unknown as RequestInit));
    this.now = options.now ?? (() => new Date());
  }

  async start(): Promise<StartedLogin> {
    const codeVerifier = randomToken();
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const state = randomToken();
    const nonce = randomToken();
    const redirectTo = new URL(this.endpoints.authorize);
    redirectTo.search = new URLSearchParams({
      client_id: this.signInProvider.clientId,
      redirect_uri: this.options.redirectUri.href,
      response_type: 'code',
      scope: this.endpoints.scope,
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      ...this.endpoints.params,
    }).toString();
    return { redirectTo, state, nonce, codeVerifier };
  }

  async finish(
    callbackUrl: URL,
    checks: LoginChecks,
  ): Promise<{ identity: IdentityClaims; warnings: readonly string[] }> {
    const params = callbackUrl.searchParams;
    if (!sameText(params.get('state') ?? '', checks.state)) {
      throw new LoginError(
        'state-mismatch',
        `the "state" of the ${this.endpoints.name} callback is not the attempt's`,
      );
    }
    const error = params.get('error');
    if (error) {
      throw new LoginError(
        'idp-error',
        `${error}: ${params.get('error_description') ?? ''}`.trim(),
      );
    }
    const code = params.get('code');
    if (!code)
      throw new LoginError('idp-error', `the ${this.endpoints.name} callback carries no code`);
    const idToken = await this.exchange(code, checks.codeVerifier);
    return { identity: this.identityOf(jwtPayload(idToken), checks.nonce), warnings: [] };
  }

  private async exchange(code: string, codeVerifier: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.options.redirectUri.href,
      client_id: this.signInProvider.clientId,
      code_verifier: codeVerifier,
    });
    if (this.signInProvider.clientSecret !== '') {
      body.set('client_secret', this.signInProvider.clientSecret);
    }
    let answer: unknown;
    let status: number;
    try {
      const response = await this.fetchImpl(this.endpoints.token, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      } as never);
      status = response.status;
      answer = await response.json().catch(() => null);
    } catch (err) {
      throw new LoginError(
        'idp-error',
        `${this.endpoints.name}'s token endpoint did not answer: ${errorMessage(err)}`,
      );
    }
    if (status !== 200 || !isRecord(answer)) {
      const code =
        isRecord(answer) && typeof answer.error === 'string' ? answer.error : `HTTP ${status}`;
      throw new LoginError('idp-error', `${this.endpoints.name} refused the code: ${code}`);
    }
    if (typeof answer.id_token !== 'string') {
      throw new LoginError('idp-error', `${this.endpoints.name} answered no ID token`);
    }
    return answer.id_token;
  }

  private identityOf(claims: Record<string, unknown>, nonce: string): IdentityClaims {
    const name = this.endpoints.name;
    const audience = claims.aud;
    const audiences = Array.isArray(audience) ? audience : [audience];
    if (!audiences.includes(this.signInProvider.clientId)) {
      throw new LoginError('idp-error', `the ${name} ID token is for another client`);
    }
    if (typeof claims.nonce !== 'string' || !sameText(claims.nonce, nonce)) {
      throw new LoginError(
        'state-mismatch',
        `the nonce of the ${name} ID token is not the attempt's`,
      );
    }
    const nowSeconds = Math.floor(this.now().getTime() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_TOLERANCE_SECONDS < nowSeconds) {
      throw new LoginError('idp-error', `the ${name} ID token has expired`);
    }
    const iss = typeof claims.iss === 'string' ? claims.iss : '';
    const tid = typeof claims.tid === 'string' ? claims.tid.toLowerCase() : '';
    const issuerOk =
      this.provider === 'google'
        ? iss === 'https://accounts.google.com' || iss === 'accounts.google.com'
        : GUID.test(tid) && iss.toLowerCase() === `${MICROSOFT_LOGIN}/${tid}/v2.0`;
    if (!issuerOk) {
      throw new LoginError('idp-error', `the ID token was issued by '${iss}', not by ${name}`);
    }
    if (typeof claims.sub !== 'string' || claims.sub === '') {
      throw new LoginError('claims-missing', `the ${name} ID token names no subject`);
    }
    const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
    if (email === '') {
      throw new LoginError(
        'claims-missing',
        `the ${name} ID token of '${claims.sub}' carries no email`,
      );
    }
    const verified =
      this.provider === 'google'
        ? claims.email_verified === true || claims.email_verified === 'true'
        : tid === MICROSOFT_CONSUMERS_TENANT ||
          claims.xms_edov === true ||
          claims.xms_edov === '1' ||
          claims.xms_edov === 'true';
    if (this.provider === 'google' && claims.email_verified === false) {
      throw new LoginError(
        'email-not-verified',
        `Google has not verified the email of '${claims.sub}'`,
      );
    }
    const displayName =
      typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : null;
    return {
      issuer: this.endpoints.issuer,
      subject: claims.sub,
      email,
      emailVerified: verified ? true : null,
      displayName,
      groups: [],
    };
  }
}

/** Which installed provider a sign-in provider is, when it is one. */
export function installedProviderOf(signInProvider: SignInProvider): InstalledProvider | null {
  return signInProvider.kind === 'local' ? null : (signInProvider.installed ?? null);
}
