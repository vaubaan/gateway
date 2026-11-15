/**
 * Who is behind a request: a signed-in user with their *current* authority,
 * the bootstrap operator, or nobody. Pages and mutation handlers call
 * `authenticate()` then `authorizeAdmin()`; nothing is read from the session
 * record but the user id.
 */
import { BOOTSTRAP_ACTOR_ID } from '@vaubaan/gateway-core';

import { issuerKey } from '../config/sign-in';
import type { Store } from '../store';
import type { GroupRecord, UserRecord } from '../store/types';
import type { AdministratorsService } from './administrators';
import type { BootstrapService } from './bootstrap';
import { currentAuthority } from './login';
import type { SignInProvidersService } from './sign-in-providers';
import type { SessionService, UserSessionRecord } from './session-service';

export interface UserPrincipal {
  readonly kind: 'user';
  readonly sessionId: string;
  readonly user: UserRecord;
  readonly groups: readonly GroupRecord[];
  readonly isOperator: boolean;
  /** The sign-in provider the user's issuer belongs to; `null` when none is configured any more. */
  readonly signInProviderId: string | null;
  /** The claims seen at sign-in (display only). */
  readonly login: UserSessionRecord['login'];
}

export interface BootstrapPrincipal {
  readonly kind: 'bootstrap';
  readonly sessionId: string;
}

export type Principal = UserPrincipal | BootstrapPrincipal;

/** The `user_id` an administrative audit entry records for this principal. */
export function auditActorId(principal: Principal): string {
  return principal.kind === 'user' ? principal.user.id : BOOTSTRAP_ACTOR_ID;
}

/**
 * A session opened at or before the user's last deactivation is over, also once the
 * user is active again: reactivation lets them sign in, it does not reopen what the
 * deactivation closed. Both instants are ISO-8601 UTC of the same clock, so the
 * strings compare as the instants do.
 */
function endedByDeactivation(
  session: Pick<UserSessionRecord, 'createdAt'>,
  user: Pick<UserRecord, 'sessionsEndedAt'>,
): boolean {
  return user.sessionsEndedAt !== null && session.createdAt <= user.sessionsEndedAt;
}

export type AdminDecision =
  | { readonly ok: true; readonly principal: Principal }
  | { readonly ok: false; readonly status: 401 | 403; readonly reason: string };

export class Authenticator {
  constructor(
    private readonly sessions: SessionService,
    private readonly store: Store,
    private readonly administrators: Pick<AdministratorsService, 'current'>,
    private readonly bootstrap: BootstrapService,
    private readonly signInProviders: Pick<SignInProvidersService, 'views'>,
  ) {}

  async authenticate(headers: Headers): Promise<Principal | null> {
    const session = await this.sessions.read(headers);
    if (!session) return null;
    if (session.record.kind === 'bootstrap') {
      // Decided where the principal is made, not by each caller: once the
      // token is revoked its open sessions are nobody, on every surface.
      const state = await this.bootstrap.state();
      if (state.status === 'active') return { kind: 'bootstrap', sessionId: session.id };
      await this.sessions.destroyById(session.id);
      return null;
    }
    const user = await this.store.users.getById(session.record.userId);
    if (!user || user.status !== 'active' || endedByDeactivation(session.record, user)) {
      await this.sessions.destroyById(session.id);
      return null;
    }
    // A sign-in provider removed in Settings ended its users' sessions (`sessions_ended_at`,
    // above); the sign-in provider is looked up for display.
    const signInProviders = await this.signInProviders.views();
    const key = user.issuer === null ? null : issuerKey(user.issuer);
    const signInProvider = signInProviders.find((p) => issuerKey(p.issuer) === key) ?? null;
    const authority = await currentAuthority(
      this.store,
      user,
      await this.administrators.current(),
      signInProvider?.id ?? null,
    );
    return {
      kind: 'user',
      sessionId: session.id,
      user,
      ...authority,
      signInProviderId: signInProvider?.id ?? null,
      login: session.record.login,
    };
  }

  /**
   * Admin surface: the bootstrap operator while the token is active, and every
   * administrator the store names (ADR administrators-live-in-the-instance).
   * `authenticate()` already decided whether a bootstrap session is still
   * somebody (a revoked token makes it `null`), so a bootstrap principal is
   * an operator here.
   */
  async authorizeAdmin(principal: Principal | null): Promise<AdminDecision> {
    if (!principal) return { ok: false, status: 401, reason: 'no session' };
    if (principal.kind === 'bootstrap') return { ok: true, principal };
    if (!principal.isOperator) {
      return { ok: false, status: 403, reason: 'user is not an administrator of this instance' };
    }
    return { ok: true, principal };
  }
}
