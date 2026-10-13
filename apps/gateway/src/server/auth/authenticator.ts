/**
 * Who is behind a request: a signed-in user with their *current* authority,
 * the bootstrap operator, or nobody. Pages and mutation handlers call
 * `authenticate()` then `authorizeAdmin()`; nothing is read from the session
 * record but the user id.
 */
import { BOOTSTRAP_ACTOR_ID } from '@vaubaan/gateway-core';

import type { AdminRule } from '../config/types';
import type { Store } from '../store';
import type { GroupRecord, UserRecord } from '../store/types';
import type { BootstrapService } from './bootstrap';
import { currentAuthority } from './login';
import type { SessionService, UserSessionRecord } from './session-service';

export interface UserPrincipal {
  readonly kind: 'user';
  readonly sessionId: string;
  readonly user: UserRecord;
  readonly groups: readonly GroupRecord[];
  readonly isOperator: boolean;
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

export type AdminDecision =
  | { readonly ok: true; readonly principal: Principal }
  | { readonly ok: false; readonly status: 401 | 403; readonly reason: string };

export class Authenticator {
  constructor(
    private readonly sessions: SessionService,
    private readonly store: Store,
    private readonly adminRule: AdminRule,
    private readonly bootstrap: BootstrapService,
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
    if (!user || user.status !== 'active') {
      await this.sessions.destroyById(session.id);
      return null;
    }
    const authority = await currentAuthority(this.store, user, this.adminRule);
    return { kind: 'user', sessionId: session.id, user, ...authority, login: session.record.login };
  }

  /**
   * Admin surface: the bootstrap operator while the token is active, a user
   * matching the admin rule afterwards (and before, if one exists).
   * `authenticate()` already decided whether a bootstrap session is still
   * somebody (a revoked token makes it `null`), so a bootstrap principal is
   * an operator here.
   */
  async authorizeAdmin(principal: Principal | null): Promise<AdminDecision> {
    if (!principal) return { ok: false, status: 401, reason: 'no session' };
    if (principal.kind === 'bootstrap') return { ok: true, principal };
    if (!principal.isOperator) {
      return { ok: false, status: 403, reason: 'user does not match the admin rule' };
    }
    return { ok: true, principal };
  }
}
