/**
 * Admission to the management door (spec §4.1 bis, §6 "separation of the three
 * credentials") — the resource-server half of the authorization server. The
 * door itself (its MCP tools) is `server/management`, which calls `admit()`
 * before anything else.
 *
 * Order of a request, the mirror image of the execution door's:
 *
 *   origin   a browser origin other than the instance's is refused
 *   bearer   `Authorization: Bearer <delegated access token>`
 *              - none, unknown, expired or revoked → 401 with the RFC 9728
 *                challenge (`WWW-Authenticate: Bearer resource_metadata=…`),
 *                which is what makes an MCP client start the OAuth flow
 *              - a mission token or a human session → 403
 *                `wrong-credential-kind`, naming the door that would accept
 *                it: the bearer was identified, it is the wrong kind, and no
 *                OAuth flow would change that
 *
 * A mission token is *identified* before it is refused (the execution door's
 * `TokenVerifier`: cached proof, throttled per prefix and address), exactly as
 * the execution door identifies a delegated token: a string that merely looks
 * like a mission token is an unknown bearer.
 */
import {
  AUTH_REQUIRED_HTTP_STATUS,
  AUTH_REQUIRED_RPC_CODE,
  checkDoor,
  refusalToRpcError,
  rpcError,
  type BearerKind,
  type ClientOrigin,
  type DelegationContext,
} from '@vaubaan/gateway-core';

import { SESSION_COOKIE, type SessionService as WebSessionService } from '../auth';
import type { InstanceConfig } from '../config';
import type { TokenVerifier } from '../execution/token-verifier';
import { clientOriginOf, trustedProxyList } from '../execution/request-meta';
import { UNKNOWN_CLIENT } from '../http/client-ip';
import type { Logger } from '../logging';
import { prefixOfBearer } from '../missions/token';
import { carriesManagementScope, MANAGEMENT_SCOPE, type OAuthEndpoints } from './endpoints';
import type { DelegatedTokenVerifier } from './verifier';

const HTTP_FORBIDDEN = 403;
const HTTP_TOO_MANY_REQUESTS = 429;
const MS_PER_SECOND = 1000;
const REALM = 'vaubaan-gateway';
const SESSION_ID_SHAPE = /^[A-Za-z0-9_-]{16,}$/;
/** JSON-RPC code of a throttled verification (the execution door's surface code). */
const RATE_LIMITED_RPC_CODE = -32002;

/** A request the management door serves: who delegated, to which client. */
export interface AdmittedDelegation {
  readonly delegation: DelegationContext;
  readonly client: ClientOrigin;
}

export interface ManagementGateDeps {
  readonly config: Pick<InstanceConfig, 'publicUrl' | 'trustedProxies'>;
  readonly endpoints: OAuthEndpoints;
  readonly verifier: DelegatedTokenVerifier;
  /** Identifies mission tokens, so that one presented here is refused by kind. */
  readonly missionTokens: Pick<TokenVerifier, 'verify'>;
  readonly webSessions: Pick<WebSessionService, 'read'>;
  readonly logger: Logger;
}

function json(status: number, body: object, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

function quoted(value: string): string {
  return value.replace(/[\\"]/g, '\\$&');
}

export class ManagementGate {
  private readonly proxies: ReturnType<typeof trustedProxyList>;

  constructor(private readonly deps: ManagementGateDeps) {
    this.proxies = trustedProxyList(deps.config.trustedProxies);
  }

  /** The delegation behind the request, or the response that refuses it. */
  async admit(request: Request): Promise<AdmittedDelegation | Response> {
    const origin = request.headers.get('origin');
    if (origin !== null && origin !== this.deps.config.publicUrl.origin) {
      return json(
        HTTP_FORBIDDEN,
        rpcError(null, -32600, 'cross-origin requests are not accepted on this endpoint.'),
      );
    }
    const client = clientOriginOf(request.headers, {
      proxies: this.proxies,
      configured: this.deps.config.trustedProxies.length > 0,
    });

    const authorization = request.headers.get('authorization');
    if (!authorization) {
      if (await this.deps.webSessions.read(request.headers)) return this.wrongKind('human-session');
      return this.challenge(null);
    }
    if (!/^bearer\s+\S/i.test(authorization)) {
      return this.challenge('malformed Authorization header (expected `Bearer <token>`).');
    }
    const bearer = authorization.replace(/^bearer\s+/i, '').trim();

    const delegation = await this.deps.verifier.resolve(bearer);
    if (delegation) {
      if (!carriesManagementScope(delegation.scopes)) {
        return this.challenge('the token does not carry the management scope.');
      }
      return { delegation, client };
    }

    if (prefixOfBearer(bearer)) {
      const verified = await this.deps.missionTokens.verify(bearer, client.ip ?? UNKNOWN_CLIENT);
      if (verified.outcome === 'throttled') return tooManyRequests(verified.retryAfterMs);
      if (verified.outcome !== 'unknown') return this.wrongKind('mission-token');
    } else if (SESSION_ID_SHAPE.test(bearer)) {
      const asCookie = new Headers({ cookie: `${SESSION_COOKIE}=${bearer}` });
      if (await this.deps.webSessions.read(asCookie)) return this.wrongKind('human-session');
    }
    return this.challenge('unknown, expired or revoked token.');
  }

  /** 403: an identified credential of another kind. No challenge: OAuth would not help. */
  private wrongKind(presented: BearerKind): Response {
    const refusal = checkDoor(presented, 'management');
    if (!refusal) throw new Error('management gate: a delegated token is not a wrong kind');
    this.deps.logger.warn('bearer refused at the management door', { refusal_code: refusal.code });
    return json(HTTP_FORBIDDEN, refusalToRpcError(null, refusal));
  }

  /**
   * 401 with the RFC 9728 / RFC 6750 challenge. `problem` is `null` when no
   * credential was presented: the challenge then carries no error code
   * (RFC 6750 §3.1), only where to get a token.
   */
  private challenge(problem: string | null): Response {
    const parts = [
      `realm="${REALM}"`,
      `resource_metadata="${quoted(this.deps.endpoints.resourceMetadataUrl)}"`,
      `scope="${MANAGEMENT_SCOPE}"`,
    ];
    if (problem !== null) {
      parts.push('error="invalid_token"', `error_description="${quoted(problem)}"`);
    }
    return json(
      AUTH_REQUIRED_HTTP_STATUS,
      rpcError(
        null,
        AUTH_REQUIRED_RPC_CODE,
        problem ?? 'a delegated access token is required (OAuth; see WWW-Authenticate).',
      ),
      { 'WWW-Authenticate': `Bearer ${parts.join(', ')}` },
    );
  }
}

function tooManyRequests(retryAfterMs: number): Response {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / MS_PER_SECOND));
  return json(
    HTTP_TOO_MANY_REQUESTS,
    rpcError(null, RATE_LIMITED_RPC_CODE, `Too many attempts; retry in ${seconds} s.`, {
      retry_after_seconds: seconds,
    }),
    { 'Retry-After': String(seconds) },
  );
}
