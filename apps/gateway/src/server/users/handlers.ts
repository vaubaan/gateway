/**
 * Host-agnostic HTTP handlers of Administration → Users (`Request →
 * Response`, never `next`). The Next route handlers under
 * `src/app/admin/(guarded)/users/**` are one-line adapters over these.
 *
 *   POST /admin/users/<id>/deactivate    the user holds nothing from now on
 *   POST /admin/users/<id>/reactivate    the user may sign in again
 *   POST /admin/users/<id>/end-sessions  every web session of the user ends
 *   POST /logout/everywhere              the signed-in user ends all their own sessions
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
  LOGIN_PAGE,
  type Authenticator,
  type Principal,
  type SessionService,
} from '../auth';
import { notAFormResponse, readForm } from '../auth/handlers';
import { createNoticeRedirect, type Notice, type NoticeStore } from '../connections';
import type { Logger } from '../logging';
import { USER_ADMIN_ERROR_MESSAGES, UserAdminError } from './errors';
import type { LocalAccountsService } from '../auth/local-accounts';
import { localAccountIdOf, type LinkMailer } from '../auth/local-handlers';
import type { SignInProvidersService } from '../auth/sign-in-providers';
import { LocalAccountError } from '../auth/errors';
import type { LocalLinkKind } from '../store';
import type { InvitationService } from './invitations';
import type { UserAdminActor, UserAdminService } from './service';

export const USERS_PAGE = '/admin/users';
/** The setup checklist, where the first administrator's creation lands. */
export const ADMIN_SETUP_PAGE = '/admin';
/** The page that creates the first administrator's local account. */
export const FIRST_ADMINISTRATOR_PAGE = '/admin/first-administrator';

export interface UserAdminHandlerDeps {
  readonly publicUrl: URL;
  readonly authenticator: Authenticator;
  /** Clears the cookie of the browser that signs out everywhere. */
  readonly sessions: Pick<SessionService, 'destroy'>;
  readonly users: UserAdminService;
  readonly invitations: InvitationService;
  readonly accounts: LocalAccountsService;
  readonly providers: Pick<SignInProvidersService, 'views'>;
  /** The admin rule's emails, lower-cased: who the setup may create the first account for. */
  readonly adminEmails: readonly string[];
  readonly mailer?: LinkMailer;
  readonly notices: NoticeStore;
  readonly logger: Logger;
}

export interface UserAdminHandlers {
  deactivate(request: Request, userId: string): Promise<Response>;
  reactivate(request: Request, userId: string): Promise<Response>;
  endSessions(request: Request, userId: string): Promise<Response>;
  /** The signed-in user ends every one of their sessions, this one included. */
  signOutEverywhere(request: Request): Promise<Response>;
  invite(request: Request): Promise<Response>;
  removeInvitation(request: Request): Promise<Response>;
  /**
   * A single-use link for a local account (field `kind`: `invite` to create it, `reset`
   * for its password; field `email`): mailed when the instance sends mail, shown to the
   * administrator to hand over otherwise.
   */
  accountLink(request: Request): Promise<Response>;
  /** An administrator resets a person's second factor: their next sign-in takes the password alone (or enrols one, for an administrator). */
  resetSecondFactor(request: Request, userId: string): Promise<Response>;
  /**
   * The setup creates the first administrator's local account (fields `email`, one of
   * `admin.emails`; `password`, `password_again`); their first sign-in enrols the second
   * factor and revokes the bootstrap token (ADR local-accounts-sign-in-provider, D7).
   */
  createFirstAdministrator(request: Request): Promise<Response>;
}

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

export function createUserAdminHandlers(deps: UserAdminHandlerDeps): UserAdminHandlers {
  const redirectWithNotice = createNoticeRedirect(deps, USERS_PAGE);

  /** The one local provider of the instance, or `null`. */
  async function localProvider(): Promise<{ id: string; issuer: URL } | null> {
    return (await deps.providers.views()).find((p) => p.kind === 'local') ?? null;
  }

  /**
   * Makes the link and says what became of it: mailed, or shown here to hand over.
   * The link appears in a notice read once by the session that asked, never in a URL.
   */
  async function linkLines(
    kind: LocalLinkKind,
    providerId: string,
    email: string,
    actor: string,
  ): Promise<string[]> {
    const issued = await deps.accounts.createLink({ kind, providerId, email, createdBy: actor });
    const what = kind === 'invite' ? 'create their account' : 'choose a new password';
    if (deps.mailer) {
      await deps.mailer.sendLink({
        kind,
        to: issued.link.email,
        url: issued.url,
        expiresAt: issued.link.expiresAt,
      });
      return [
        `A link to ${what} was sent to ${issued.link.email}. It works once, for fifteen minutes; send another from here if it expires.`,
      ];
    }
    return [
      `Hand them this link to ${what}; it works once, for fifteen minutes, and is shown only now:`,
      issued.url.href,
    ];
  }

  function failure(err: unknown, title: string): Notice {
    if (err instanceof UserAdminError) {
      return { tone: 'danger', title, lines: [USER_ADMIN_ERROR_MESSAGES[err.code]] };
    }
    if (err instanceof LocalAccountError) {
      return { tone: 'danger', title, lines: [err.sentence] };
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
        const local = await localProvider();
        notice = {
          tone: 'success',
          title: `${invited} invited`,
          lines: local
            ? await linkLines('invite', local.id, invited, auditActorId(principal))
            : [
                'They can sign in through any provider of this gateway that verified this address. Nothing was sent: tell them where to sign in.',
              ],
        };
      } catch (err) {
        notice = failure(err, 'Not invited');
      }
      return redirectWithNotice(principal.sessionId, USERS_PAGE, notice);
    },

    resetSecondFactor(request, userId) {
      return act(request, 'Second factor not reset', async (actor) => {
        const local = await localProvider();
        if (!local) throw new LocalAccountError('no-local-provider');
        const user = await deps.users.get(userId);
        const accountId = user ? localAccountIdOf({ user }, local) : null;
        if (!accountId) throw new LocalAccountError('account-not-found');
        const account = await deps.accounts.resetSecondFactor(accountId, actor.actorId);
        return {
          tone: 'success',
          title: `Second factor of ${account.email} reset`,
          lines: [
            'Their next sign-in takes the password alone; if they administer this gateway, it asks them to set a new second factor up at once.',
          ],
        };
      });
    },

    async createFirstAdministrator(request) {
      const principal = await operatorOf(request);
      if (principal instanceof Response) return principal;
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      const field = (name: string): string => {
        const value = form.get(name);
        return typeof value === 'string' ? value : '';
      };
      const email = field('email').trim().toLowerCase();
      let notice: Notice;
      try {
        const local = await localProvider();
        if (!local) throw new LocalAccountError('no-local-provider');
        if (!deps.adminEmails.includes(email)) throw new LocalAccountError('not-admitted');
        if (field('password') !== field('password_again')) {
          throw new LocalAccountError(
            'password-weak',
            'The two passwords differ. Type the same one twice.',
          );
        }
        const account = await deps.accounts.createAccount({
          providerId: local.id,
          email,
          password: field('password'),
          actor: auditActorId(principal),
        });
        notice = {
          tone: 'success',
          title: `Account of ${account.email} created`,
          lines: [
            'Sign in with it now: the first sign-in sets the second factor up, shows the recovery codes, and retires the bootstrap token.',
          ],
        };
      } catch (err) {
        notice = failure(err, 'Account not created');
      }
      return redirectWithNotice(principal.sessionId, ADMIN_SETUP_PAGE, notice);
    },

    async accountLink(request) {
      const principal = await operatorOf(request);
      if (principal instanceof Response) return principal;
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      const kindField = form.get('kind');
      const kind: LocalLinkKind = kindField === 'reset' ? 'reset' : 'invite';
      const emailField = form.get('email');
      const email = typeof emailField === 'string' ? emailField : '';
      let notice: Notice;
      try {
        const local = await localProvider();
        if (!local) throw new LocalAccountError('no-local-provider');
        if (kind === 'invite' && !(await deps.invitations.isInvited(email.trim().toLowerCase()))) {
          // The link admits nobody by itself: the address must be invited first.
          throw new LocalAccountError('not-admitted');
        }
        notice = {
          tone: 'success',
          title:
            kind === 'invite'
              ? `Account link for ${email.trim()}`
              : `Password reset for ${email.trim()}`,
          lines: await linkLines(kind, local.id, email, auditActorId(principal)),
        };
      } catch (err) {
        notice = failure(err, kind === 'invite' ? 'No link' : 'No reset');
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

    async signOutEverywhere(request) {
      const guard = await guardMutation(request, deps, 'user');
      if (!guard.ok) return refusalResponse(guard, OPERATOR_REFUSALS);
      const self = guard.principal.user.id;
      await deps.users.endSessions({ actorId: self, userId: self }, self);
      const cleared = await deps.sessions.destroy(request.headers);
      return new Response(null, {
        status: 303,
        headers: { Location: LOGIN_PAGE, 'Set-Cookie': cleared, 'Cache-Control': 'no-store' },
      });
    },

    endSessions(request, userId) {
      return act(request, 'Sessions not ended', async (actor) => {
        const user = await deps.users.endSessions(actor, userId);
        return {
          tone: 'success',
          title: `${user.email} signed out everywhere`,
          lines: [
            'Every browser they were signed in with must sign in again. Their keys, connected apps and missions are unchanged: to stop those, deactivate them.',
          ],
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
