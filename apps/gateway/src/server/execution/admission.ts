/**
 * Admission of a mission key — the part of a request both doors of the
 * execution surface share (spec §4.1, §4.1 ter, §6): the MCP door (`/mcp`,
 * `/mcp/catalog`) and the git remote (`/git/**`). One instance, built by the
 * MCP door and handed to the git door, so the two cannot drift: the same
 * verifier, the same 401 reasons, the same `wrong-credential-kind`, the same
 * per-mission surface rate limit.
 *
 *   origin        a browser origin other than the instance's is refused
 *   bearer        the mission key; missing or unknown → unauthenticated; a key
 *                 that authenticated once and no longer does → unauthenticated
 *                 with its reason (`AUTH_FAILURE_REASONS`); a web session or a
 *                 delegated token → `wrong-credential-kind`
 *   grounds       the creator's authority, re-read on every request; a mission
 *                 whose grounds are gone reads `orphaned` for this request, and
 *                 a connection whose part is lost is marked `lost` in it
 *   surface rate  requests per minute per mission, one window for both doors
 *
 * Each door renders a denial in its own protocol: JSON-RPC for MCP, HTTP and
 * pkt-lines for git. The key itself is never logged: the token's prefix is.
 */
import {
  AuthError,
  BOOTSTRAP_ACTOR_ID,
  DoorAuthenticator,
  isRefusal,
  refuse,
  type AuthFailureReason,
  type ClientOrigin,
  type CredentialResolver,
  type DelegationContext,
  type MissionContext,
  type Refusal,
  type ResolvedCredential,
} from '@vaubaan/gateway-core';

import { SESSION_COOKIE, type SessionService as WebSessionService } from '../auth';
import type { MissionGrounds } from '../authority';
import type { RateLimiter } from '../compose/ports';
import type { InstanceConfig } from '../config';
import { UNKNOWN_CLIENT } from '../http/client-ip';
import type { Logger } from '../logging';
import { prefixOfBearer, type TokenRetirement } from '../missions';
import type { MissionTokenKey, Store } from '../store';
import type { MissionRecord } from '../store/types';
import { loadMissionContext } from './mission-context';
import { clientOriginOf, trustedProxyList } from './request-meta';
import type { TokenVerifier } from './token-verifier';

export const SURFACE_RATE_WINDOW_MS = 60_000;
/** `mission_tokens.last_used_at` is written at most once per token in this many seconds. */
export const TOKEN_LAST_USED_GRANULARITY_SECONDS = 60;

const SESSION_ID_SHAPE = /^[A-Za-z0-9_-]{16,}$/;

/** Identifies a delegated token (management door). Absent until then. */
export interface DelegatedTokenResolver {
  resolve(bearer: string): Promise<DelegationContext | null>;
}

/** `MissionsRepo.markTokenUsed`: the doors' only write outside the pipeline. */
export interface TokenUseRecorder {
  markTokenUsed(key: MissionTokenKey, granularitySeconds: number): Promise<boolean>;
}

export interface MissionAdmissionDeps {
  readonly config: Pick<
    InstanceConfig,
    'publicUrl' | 'trustedProxies' | 'clientIpHeader' | 'mcp' | 'selfResources'
  >;
  readonly store: Pick<Store, 'connections' | 'users' | 'groups' | 'sessions'>;
  readonly tokens: TokenVerifier;
  readonly tokenUse: TokenUseRecorder;
  readonly grounds: Pick<MissionGrounds, 'inspect'>;
  readonly webSessions: Pick<WebSessionService, 'read'>;
  readonly rateLimiter: RateLimiter;
  readonly logger: Logger;
  readonly delegations?: DelegatedTokenResolver;
}

/**
 * What the door answers for a token whose secret matched and that no longer
 * authenticates. A token revoked together with its mission is not here: that
 * one still identifies the mission and is answered `mission-inactive`.
 */
const AUTH_FAILURE_OF: Readonly<Record<TokenRetirement, AuthFailureReason>> = {
  rotated: 'token-rotated',
  revoked: 'token-revoked',
  'holder-removed': 'holder-removed',
  'holder-deactivated': 'holder-deactivated',
};

/** An admitted request: the mission, the key's holder, where it came from. */
export interface Admitted {
  readonly ctx: MissionContext;
  readonly mission: MissionRecord;
  readonly client: ClientOrigin;
}

export type AdmissionDenial =
  | { readonly denial: 'cross-origin' }
  /** Too many failed verifications from this address on this token. */
  | { readonly denial: 'verification-throttled'; readonly retryAfterMs: number }
  /** No key, an unknown key, or a key that stopped working (`error.reason`). */
  | { readonly denial: 'unauthenticated'; readonly error: AuthError }
  /** A credential of another kind (`wrong-credential-kind`). */
  | { readonly denial: 'refused'; readonly refusal: Refusal }
  /** The mission's surface rate limit. */
  | { readonly denial: 'rate-limited'; readonly retryAfterMs: number };

export function isDenial(outcome: Admitted | AdmissionDenial): outcome is AdmissionDenial {
  return 'denial' in outcome;
}

class VerificationThrottled extends Error {
  constructor(readonly retryAfterMs: number) {
    super('too many token verifications');
  }
}

export class MissionAdmission {
  private readonly missionsByContext = new WeakMap<MissionContext, MissionRecord>();
  private readonly proxies: ReturnType<typeof trustedProxyList>;

  constructor(private readonly deps: MissionAdmissionDeps) {
    this.proxies = trustedProxyList(deps.config.trustedProxies);
  }

  /** The address a request comes from, as both the audit and the throttle name it. */
  clientOf(request: Request): ClientOrigin {
    return clientOriginOf(request.headers, {
      proxies: this.proxies,
      configured: this.deps.config.trustedProxies.length > 0,
      edgeHeader: this.deps.config.clientIpHeader,
    });
  }

  /**
   * Admit a request. `authorization` is the `Authorization` value in the
   * `Bearer <key>` form: the MCP door passes the header as it is, the git
   * door the password of its Basic credential.
   */
  async admit(request: Request, authorization: string | null): Promise<Admitted | AdmissionDenial> {
    const origin = request.headers.get('origin');
    if (origin !== null && origin !== this.deps.config.publicUrl.origin) {
      return { denial: 'cross-origin' };
    }
    // Resolved once per request: the audit entry and the verification throttle
    // must name the same address.
    const client = this.clientOf(request);
    let ctx: MissionContext | Refusal;
    try {
      ctx = await this.authenticate(request.headers, authorization, client.ip ?? UNKNOWN_CLIENT);
    } catch (err) {
      if (err instanceof VerificationThrottled) {
        return { denial: 'verification-throttled', retryAfterMs: err.retryAfterMs };
      }
      if (err instanceof AuthError) return { denial: 'unauthenticated', error: err };
      throw err;
    }
    if (isRefusal(ctx)) {
      this.deps.logger.warn('bearer refused at the execution surface', { refusal_code: ctx.code });
      return { denial: 'refused', refusal: ctx };
    }

    const surface = await this.deps.rateLimiter.take(
      `mcp:mission:${ctx.mission.id}`,
      this.deps.config.mcp.rateLimitPerMinute,
      SURFACE_RATE_WINDOW_MS,
    );
    if (!surface.allowed) return { denial: 'rate-limited', retryAfterMs: surface.retryAfterMs };

    const mission = this.missionsByContext.get(ctx);
    if (!mission) throw new Error('execution surface: mission context without its record');
    await this.noteTokenUse(ctx);
    return { ctx, mission, client };
  }

  /**
   * "Last used" of the token, for the creator's list of tokens. Informational:
   * a failure to record it is logged and never refuses the request.
   */
  private async noteTokenUse(ctx: MissionContext): Promise<void> {
    try {
      await this.deps.tokenUse.markTokenUsed(
        { missionId: ctx.mission.id, tokenId: ctx.token.id },
        TOKEN_LAST_USED_GRANULARITY_SECONDS,
      );
    } catch (err) {
      this.deps.logger.warn('token use not recorded', {
        mission_id: ctx.mission.id,
        token_prefix: ctx.token.prefix,
        error: err instanceof Error ? err.name : 'Error',
      });
    }
  }

  private async authenticate(
    headers: Headers,
    authorization: string | null,
    clientIp: string,
  ): Promise<MissionContext | Refusal> {
    if (!authorization && (await this.deps.webSessions.read(headers))) {
      // A browser session presented where a mission token is expected.
      return refuse.wrongCredentialKind({
        door: 'execution',
        presented: 'human-session',
        expected: 'mission-token',
      });
    }
    return new DoorAuthenticator(this.credentialResolver(clientIp)).authenticateMission(
      authorization,
    );
  }

  /** One resolver per request: the verification throttle is keyed on the caller's address. */
  private credentialResolver(clientIp: string): CredentialResolver {
    return {
      resolve: async (bearer): Promise<ResolvedCredential | null> => {
        const verified = await this.deps.tokens.verify(bearer, clientIp);
        if (verified.outcome === 'throttled')
          throw new VerificationThrottled(verified.retryAfterMs);
        if (verified.outcome !== 'unknown') {
          if (verified.outcome === 'retired') {
            // A token retired by the revocation of its MISSION still identifies that
            // mission, so the caller is told `mission-inactive`. Every other retired
            // token no longer authenticates, and the 401 says why: replaced by its
            // holder, revoked on its own, its member removed, its holder deactivated.
            // In those cases the mission may be serving its other holders, so
            // `mission-inactive` would be a lie about the mission.
            // The status read here is the STORED one, on purpose: the question is
            // whether the store still holds the mission active, asked before the
            // derivation (`grounds.inspect`) below.
            const withItsMission =
              verified.reason === 'revoked' && verified.mission.status !== 'active';
            if (!withItsMission) {
              const reason = AUTH_FAILURE_OF[verified.reason];
              this.deps.logger.warn('retired mission token presented at the execution surface', {
                mission_id: verified.mission.id,
                token_prefix: verified.token.prefix,
                token_kind: verified.token.holder.kind,
                reason,
              });
              throw AuthError.tokenStopped(reason);
            }
          }
          // Authority is never snapshotted in a mission, and `orphaned` is never
          // stored: the creator's authority is re-read here, and the mission is
          // orphaned for this request exactly when it does not ground it now.
          const { mission, orphan, lost } = await this.deps.grounds.inspect(verified.mission);
          if (orphan) {
            // No administrative entry: no human is behind this read. The refused
            // call itself is audited by the pipeline (`mission-inactive`).
            this.deps.logger.info('mission orphaned at the execution surface', {
              mission_id: mission.id,
              cause: orphan.cause,
              connection_id: orphan.connectionId,
              uncovered: orphan.uncovered,
            });
          }
          // A lost connection (revoked, or the creator's access withdrawn) is marked in
          // the context: its calls are refused `connection-revoked`, its tools unlisted,
          // and the mission serves through its other connections.
          const context = await loadMissionContext(
            this.deps.store,
            mission,
            verified.token,
            this.deps.config.selfResources,
            lost,
          );
          this.missionsByContext.set(context, mission);
          return { kind: 'mission-token', context };
        }

        // A bearer of mission-token shape is never used as a session-store key.
        if (!prefixOfBearer(bearer) && SESSION_ID_SHAPE.test(bearer)) {
          const asCookie = new Headers({ cookie: `${SESSION_COOKIE}=${bearer}` });
          const session = await this.deps.webSessions.read(asCookie);
          if (session) {
            const { record } = session;
            return {
              kind: 'human-session',
              user_id: record.kind === 'user' ? record.userId : BOOTSTRAP_ACTOR_ID,
            };
          }
        }
        const delegation = await this.deps.delegations?.resolve(bearer);
        return delegation ? { kind: 'delegated-token', delegation } : null;
      },
    };
  }
}
