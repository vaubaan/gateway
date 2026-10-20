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
 *   POST /admin/users/<id>/make-administrator     the user administers from now on
 *   POST /admin/users/<id>/unmake-administrator   no longer (refused for the last way in)
 *   POST /admin/users/administrators/group        name a group of a provider (fields `provider`, `group`)
 *   POST /admin/users/administrators/remove       remove a designation (field `designation`)
 *   POST /admin/users/administrators/apply-configuration  apply the configuration's admin rule
 *   POST /api/admin/setup/finish          end the setup: the install token is revoked
 *
 * Operator only, origin-checked (spec §6): the Administration layout does not
 * cover route handlers, so each handler authorizes by itself.
 */
import {
  ADMINISTRATORS_ERROR_MESSAGES,
  AdministratorsError,
  auditActorId,
  guardMutation,
  type AdministratorsService,
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
import type { LinkMailer } from '../auth/local-handlers';
import type { SignInProvidersService } from '../auth/sign-in-providers';
import { LocalAccountError } from '../auth/errors';
import type { LocalLinkKind } from '../store';
import type { AuditWriter } from '@vaubaan/gateway-core';
import type { BootstrapService } from '../auth/bootstrap';
import type { SecondFactorService } from '../auth/second-factor';
import { toIso, type Clock } from '../store/clock';
import type { InvitationService } from './invitations';
import type { UserAdminActor, UserAdminService } from './service';

export const USERS_PAGE = '/admin/users';
/** The setup checklist, where the first administrator's creation lands. */
export const ADMIN_SETUP_PAGE = '/admin';
/** The page that creates the first administrator's local account. */
export const FIRST_ADMINISTRATOR_PAGE = '/admin/first-administrator';
/** "Finish setup": the form action that ends the setup. */
export const FINISH_SETUP_ACTION = '/api/admin/setup/finish';

export interface UserAdminHandlerDeps {
  readonly publicUrl: URL;
  readonly authenticator: Authenticator;
  /** Clears the cookie of the browser that signs out everywhere. */
  readonly sessions: Pick<SessionService, 'destroy'>;
  readonly users: UserAdminService;
  readonly invitations: InvitationService;
  readonly accounts: LocalAccountsService;
  readonly providers: Pick<SignInProvidersService, 'views'>;
  /** The designations of the administrators (ADR administrators-live-in-the-instance). */
  readonly administrators: AdministratorsService;
  readonly bootstrap: Pick<BootstrapService, 'state' | 'revoke'>;
  readonly secondFactors: Pick<SecondFactorService, 'reset'>;
  readonly masterKey: { state(): Promise<{ readonly handoverPending: boolean }> };
  readonly audit: AuditWriter;
  readonly clock: Clock;
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
   * The setup creates the first administrator's local account (fields `email`, any
   * address; `password`, `password_again`) and names them administrator; their first
   * sign-in enrols the second factor (ADR administrators-live-in-the-instance, §4).
   */
  createFirstAdministrator(request: Request): Promise<Response>;
  makeAdministrator(request: Request, userId: string): Promise<Response>;
  unmakeAdministrator(request: Request, userId: string): Promise<Response>;
  addAdministratorGroup(request: Request): Promise<Response>;
  removeAdministratorDesignation(request: Request): Promise<Response>;
  applyConfigurationRule(request: Request): Promise<Response>;
  /**
   * "Finish setup": revokes the install token, once the key is handed over and an
   * administrator has a way in (ADR administrators-live-in-the-instance, §8).
   */
  finishSetup(request: Request): Promise<Response>;
}

/** Why the setup cannot end yet, or `null`. */
export async function setupCannotFinish(deps: {
  readonly administrators: Pick<AdministratorsService, 'withAWayIn'>;
  readonly masterKey: { state(): Promise<{ readonly handoverPending: boolean }> };
}): Promise<string | null> {
  if ((await deps.masterKey.state()).handoverPending) {
    return 'Download the encryption key and confirm you kept it first.';
  }
  if ((await deps.administrators.withAWayIn()).length === 0) {
    return 'Name an administrator who can sign in first: create their local account, or make the identity of a passed provider test an administrator.';
  }
  return null;
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
    if (err instanceof AdministratorsError) {
      return { tone: 'danger', title, lines: [ADMINISTRATORS_ERROR_MESSAGES[err.code]] };
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
        const user = await deps.users.get(userId);
        if (!user) throw new AdministratorsError('not-a-user', userId);
        await deps.secondFactors.reset(user, actor.actorId);
        return {
          tone: 'success',
          title: `Second factor of ${user.email} reset`,
          lines: [
            'Their next sign-in asks them to set a new one up, unless their provider’s waiver applies (never to an administrator).',
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
        if (field('password') !== field('password_again')) {
          throw new LocalAccountError(
            'password-weak',
            'The two passwords differ. Type the same one twice.',
          );
        }
        const actor = auditActorId(principal);
        const account = await deps.accounts.createAccount({
          providerId: local.id,
          email,
          password: field('password'),
          actor,
        });
        // The person exists from now on, and administers: named by the holder of the
        // setup link, inside the instance (ADR administrators-live-in-the-instance, §4).
        const user = await deps.users.ensureIdentity({
          issuer: local.issuer.href,
          subject: account.id,
          email: account.email,
        });
        await deps.administrators.grantUser(user.id, actor, 'setup');
        notice = {
          tone: 'success',
          title: `Account of ${account.email} created`,
          lines: [
            'It administers this gateway. Sign in with it now: the first sign-in sets the second factor up and shows the recovery codes.',
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

    makeAdministrator(request, userId) {
      return act(request, 'Not made administrator', async (actor) => {
        const user = await deps.users.get(userId);
        if (!user) throw new AdministratorsError('not-a-user', userId);
        const row = await deps.administrators.grantUser(userId, actor.actorId);
        return {
          tone: 'success',
          title: row ? `${user.email} administers this gateway` : `${user.email} already did`,
          lines: row
            ? [
                'From their next page they see Administration. If they have no second factor yet, their next sign-in asks them to set one up.',
              ]
            : [],
        };
      });
    },

    unmakeAdministrator(request, userId) {
      return act(request, 'Still administrator', async (actor) => {
        const user = await deps.users.get(userId);
        if (!user) throw new AdministratorsError('not-a-user', userId);
        const designation = await deps.administrators.designationOfUser(userId);
        if (!designation) {
          return {
            tone: 'warning',
            title: `${user.email} is not administrator by name`,
            lines: [
              'They administer through a group of their sign-in provider: remove that group from the administrators below, or remove them from the group at the provider.',
            ],
          };
        }
        await deps.administrators.revoke(designation.id, actor.actorId);
        return {
          tone: 'success',
          title: `${user.email} no longer administers this gateway`,
          lines: ['Their next page no longer shows Administration. Nothing else changes.'],
        };
      });
    },

    async addAdministratorGroup(request) {
      const principal = await operatorOf(request);
      if (principal instanceof Response) return principal;
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      const provider = String(form.get('provider') ?? '').trim();
      const group = String(form.get('group') ?? '').trim();
      let notice: Notice;
      try {
        const row = await deps.administrators.grantGroup(provider, group, auditActorId(principal));
        notice = {
          tone: 'success',
          title: row
            ? `Members of “${group}” (${provider}) administer this gateway`
            : `“${group}” (${provider}) already did`,
          lines: row
            ? [
                'Each member is an administrator from their next sign-in through that provider, as long as the provider says they belong to the group.',
              ]
            : [],
        };
      } catch (err) {
        notice = failure(err, 'Group not named');
      }
      return redirectWithNotice(principal.sessionId, USERS_PAGE, notice);
    },

    async removeAdministratorDesignation(request) {
      const principal = await operatorOf(request);
      if (principal instanceof Response) return principal;
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      const id = String(form.get('designation') ?? '');
      let notice: Notice;
      try {
        const removed = await deps.administrators.revoke(id, auditActorId(principal));
        notice = {
          tone: 'success',
          title: 'Administrator removed',
          lines: [
            removed.kind === 'group'
              ? `Members of “${removed.groupName}” no longer administer through it.`
              : removed.kind === 'email'
                ? `${removed.email} will not be an administrator when it signs in.`
                : 'They no longer administer this gateway.',
          ],
        };
      } catch (err) {
        notice = failure(err, 'Not removed');
      }
      return redirectWithNotice(principal.sessionId, USERS_PAGE, notice);
    },

    async finishSetup(request) {
      const principal = await operatorOf(request);
      if (principal instanceof Response) return principal;
      let notice: Notice;
      try {
        if ((await deps.bootstrap.state()).status !== 'active') {
          notice = { tone: 'warning', title: 'The setup has already ended', lines: [] };
        } else {
          const problem = await setupCannotFinish(deps);
          if (problem) {
            notice = { tone: 'danger', title: 'The setup is not finished', lines: [problem] };
          } else {
            const revoked = await deps.bootstrap.revoke();
            await deps.audit.write({
              kind: 'admin',
              ts: revoked.status === 'revoked' ? revoked.revokedAt : toIso(deps.clock.now()),
              user_id: auditActorId(principal),
              act: 'setup-finished',
              object: { type: 'instance-config', id: 'bootstrap' },
              before: { status: 'active' },
              after: { status: revoked.status },
              delegated_client_id: null,
            });
            deps.logger.info('setup finished: the install token is revoked');
            notice = {
              tone: 'success',
              title: 'The setup is finished',
              lines: [
                'The install token and the setup link no longer open anything. From now on people sign in through the providers that are on.',
              ],
            };
          }
        }
      } catch (err) {
        notice = failure(err, 'The setup is not finished');
      }
      return redirectWithNotice(principal.sessionId, ADMIN_SETUP_PAGE, notice);
    },

    async applyConfigurationRule(request) {
      const principal = await operatorOf(request);
      if (principal instanceof Response) return principal;
      let notice: Notice;
      try {
        const written = await deps.administrators.applyConfiguration(auditActorId(principal));
        notice = {
          tone: 'success',
          title: 'The configuration’s rule is applied',
          lines: [
            written.length === 0
              ? 'It named nobody new.'
              : `${written.length} ${plural(written.length, 'administrator was', 'administrators were')} named, in your name.`,
          ],
        };
      } catch (err) {
        notice = failure(err, 'Not applied');
      }
      return redirectWithNotice(principal.sessionId, USERS_PAGE, notice);
    },

    deactivate(request, userId) {
      return act(request, 'Not deactivated', async (actor) => {
        // No self-lockout: the last administrator with a way in stays.
        await deps.administrators.assertNoLockout({ withoutUser: userId });
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
