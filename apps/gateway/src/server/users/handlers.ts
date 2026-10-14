/**
 * Host-agnostic HTTP handlers of Administration → Users (`Request →
 * Response`, never `next`). The Next route handlers under
 * `src/app/admin/(guarded)/users/**` are one-line adapters over these.
 *
 *   POST /admin/users/<id>/deactivate    the user holds nothing from now on
 *   POST /admin/users/<id>/reactivate    the user may sign in again
 *   POST /admin/users/invitations         invite an address (form field `email`)
 *   POST /admin/users/invitations/remove  remove an invitation (form field `email`)
 *
 * Operator only, origin-checked (spec §6): the Administration layout does not
 * cover route handlers, so each handler authorizes by itself.
 */
import {
  auditActorId,
  guardMutation,
  OPERATOR_REFUSALS,
  refusalResponse,
  type Authenticator,
  type Principal,
} from '../auth';
import { notAFormResponse, readForm } from '../auth/handlers';
import { createNoticeRedirect, type Notice, type NoticeStore } from '../connections';
import type { Logger } from '../logging';
import { USER_ADMIN_ERROR_MESSAGES, UserAdminError } from './errors';
import type { InvitationService } from './invitations';
import type { UserAdminActor, UserAdminService } from './service';

export const USERS_PAGE = '/admin/users';

export interface UserAdminHandlerDeps {
  readonly publicUrl: URL;
  readonly authenticator: Authenticator;
  readonly users: UserAdminService;
  readonly invitations: InvitationService;
  readonly notices: NoticeStore;
  readonly logger: Logger;
}

export interface UserAdminHandlers {
  deactivate(request: Request, userId: string): Promise<Response>;
  reactivate(request: Request, userId: string): Promise<Response>;
  invite(request: Request): Promise<Response>;
  removeInvitation(request: Request): Promise<Response>;
}

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

export function createUserAdminHandlers(deps: UserAdminHandlerDeps): UserAdminHandlers {
  const redirectWithNotice = createNoticeRedirect(deps, USERS_PAGE);

  function failure(err: unknown, title: string): Notice {
    if (err instanceof UserAdminError) {
      return { tone: 'danger', title, lines: [USER_ADMIN_ERROR_MESSAGES[err.code]] };
    }
    deps.logger.error('users: unexpected failure', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return {
      tone: 'danger',
      title,
      lines: ['An unexpected error occurred. The log of the gateway has the detail.'],
    };
  }

  /** The operator behind a mutation, or the response that refuses it. */
  async function operatorOf(request: Request): Promise<Principal | Response> {
    const guard = await guardMutation(request, deps, 'operator');
    return guard.ok ? guard.principal : refusalResponse(guard, OPERATOR_REFUSALS);
  }

  /** Runs one act and lands on the Users page with what happened. */
  async function act(
    request: Request,
    title: string,
    run: (actor: UserAdminActor) => Promise<Notice>,
  ): Promise<Response> {
    const principal = await operatorOf(request);
    if (principal instanceof Response) return principal;
    let notice: Notice;
    try {
      notice = await run({
        actorId: auditActorId(principal),
        userId: principal.kind === 'user' ? principal.user.id : null,
      });
    } catch (err) {
      notice = failure(err, title);
    }
    return redirectWithNotice(principal.sessionId, USERS_PAGE, notice);
  }

  /** The `email` field of a form mutation, or the response that refuses the body. */
  async function emailOf(request: Request): Promise<string | Response> {
    const form = await readForm(request);
    if (!form) return notAFormResponse();
    const value = form.get('email');
    return typeof value === 'string' ? value : '';
  }

  return {
    async invite(request) {
      const principal = await operatorOf(request);
      if (principal instanceof Response) return principal;
      const email = await emailOf(request);
      if (email instanceof Response) return email;
      let notice: Notice;
      try {
        const invited = await deps.invitations.invite(auditActorId(principal), email);
        notice = {
          tone: 'success',
          title: `${invited} invited`,
          lines: [
            'They can sign in through any provider of this gateway that verified this address. Nothing was sent: tell them where to sign in.',
          ],
        };
      } catch (err) {
        notice = failure(err, 'Not invited');
      }
      return redirectWithNotice(principal.sessionId, USERS_PAGE, notice);
    },

    async removeInvitation(request) {
      const principal = await operatorOf(request);
      if (principal instanceof Response) return principal;
      const email = await emailOf(request);
      if (email instanceof Response) return email;
      let notice: Notice;
      try {
        const removed = await deps.invitations.remove(auditActorId(principal), email);
        notice = {
          tone: 'success',
          title: `Invitation of ${removed} removed`,
          lines: [
            'Their next sign-in is refused unless an allowed domain admits them. A session already open runs to its end; deactivate the person to stop it now.',
          ],
        };
      } catch (err) {
        notice = failure(err, 'Not removed');
      }
      return redirectWithNotice(principal.sessionId, USERS_PAGE, notice);
    },

    deactivate(request, userId) {
      return act(request, 'Not deactivated', async (actor) => {
        const done = await deps.users.deactivate(actor, userId);
        const lines = [
          'They can no longer sign in, their open sessions are over, and they hold nothing on any account.',
        ];
        if (done.delegationsRevoked > 0) {
          lines.push(
            `${done.delegationsRevoked} ${plural(done.delegationsRevoked, 'connected app was', 'connected apps were')} disconnected: the apps acting for them lost their access.`,
          );
        }
        if (done.groupsLeft.length > 0) {
          lines.push(`Removed from ${done.groupsLeft.map((name) => `“${name}”`).join(', ')}.`);
        }
        if (done.orphaned > 0) {
          lines.push(
            `${done.orphaned} of their missions ${plural(done.orphaned, 'is', 'are')} stopped: every call is refused.`,
          );
        }
        if (done.unowned > 0) {
          lines.push(
            `${done.unowned} ${plural(done.unowned, 'account has', 'accounts have')} no owner left: name one under Settings → Accounts without owner.`,
          );
        }
        return {
          tone: done.unowned > 0 ? 'warning' : 'success',
          title: `${done.user.email} deactivated`,
          lines,
        };
      });
    },

    reactivate(request, userId) {
      return act(request, 'Not reactivated', async (actor) => {
        const done = await deps.users.reactivate(actor, userId);
        const lines = [
          'They can sign in again. Their teams from the identity provider return at that sign-in; local teams, connected apps and accounts given to someone else do not come back by themselves.',
        ];
        if (done.restored > 0) {
          lines.push(
            `${done.restored} of their missions ${plural(done.restored, 'is', 'are')} covered again and ${plural(done.restored, 'serves', 'serve')} calls from now on.`,
          );
        }
        return { tone: 'success', title: `${done.user.email} reactivated`, lines };
      });
    },
  };
}
