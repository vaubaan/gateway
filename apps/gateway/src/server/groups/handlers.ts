/**
 * Host-agnostic HTTP handlers of Administration → Groups (`Request →
 * Response`, never `next`). The Next route handlers under
 * `src/app/admin/(guarded)/groups/**` are one-line adapters over these.
 *
 *   POST /admin/groups/create                           create a local group
 *   POST /admin/groups/<id>/members                     add a member (by email)
 *   POST /admin/groups/<id>/members/<userId>/remove     remove a member
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
import { notAFormResponse, readForm } from '../http/form';
import { createNoticeRedirect, type Notice, type NoticeStore } from '../connections';
import type { Logger } from '../logging';
import { GROUP_ERROR_MESSAGES, GroupError } from './errors';
import type { GroupService } from './service';

export const GROUPS_PAGE = '/admin/groups';

export interface GroupHandlerDeps {
  readonly publicUrl: URL;
  readonly authenticator: Authenticator;
  readonly groups: GroupService;
  readonly notices: NoticeStore;
  readonly logger: Logger;
}

export interface GroupHandlers {
  create(request: Request): Promise<Response>;
  addMember(request: Request, groupId: string): Promise<Response>;
  removeMember(request: Request, groupId: string, userId: string): Promise<Response>;
}

export function createGroupHandlers(deps: GroupHandlerDeps): GroupHandlers {
  const redirectWithNotice = createNoticeRedirect(deps, GROUPS_PAGE);

  function failure(err: unknown, title: string): Notice {
    if (err instanceof GroupError) {
      return { tone: 'danger', title, lines: [GROUP_ERROR_MESSAGES[err.code]] };
    }
    deps.logger.error('groups: unexpected failure', {
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

  /** Runs one act and lands on the Groups page with what happened. */
  async function act(
    principal: Principal,
    title: string,
    run: (actorId: string) => Promise<Notice>,
  ): Promise<Response> {
    let notice: Notice;
    try {
      notice = await run(auditActorId(principal));
    } catch (err) {
      notice = failure(err, title);
    }
    return redirectWithNotice(principal.sessionId, GROUPS_PAGE, notice);
  }

  return {
    async create(request) {
      const principal = await operatorOf(request);
      if (principal instanceof Response) return principal;
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      return act(principal, 'Team not created', async (actorId) => {
        const group = await deps.groups.create(actorId, field(form, 'name'));
        return {
          tone: 'success',
          title: `Team “${group.name}” created`,
          lines: ['Add its members below. A sign-in never changes a local team.'],
        };
      });
    },

    async addMember(request, groupId) {
      const principal = await operatorOf(request);
      if (principal instanceof Response) return principal;
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      return act(principal, 'Member not added', async (actorId) => {
        const { group, user, restored } = await deps.groups.addMember(
          actorId,
          groupId,
          field(form, 'email'),
        );
        const lines = [
          'They now own the accounts this team owns and hold the accesses given to it.',
        ];
        if (restored > 0) {
          lines.push(
            `${restored} of their stopped missions ${restored === 1 ? 'is' : 'are'} covered again and ${restored === 1 ? 'serves' : 'serve'} calls from now on.`,
          );
        }
        return { tone: 'success', title: `${user.email} added to “${group.name}”`, lines };
      });
    },

    async removeMember(request, groupId, userId) {
      const principal = await operatorOf(request);
      if (principal instanceof Response) return principal;
      return act(principal, 'Member not removed', async (actorId) => {
        const removal = await deps.groups.removeMember(actorId, groupId, userId);
        const lines = ['What the team gave them is withdrawn at once.'];
        if (removal.orphaned > 0) {
          lines.push(
            `${removal.orphaned} of their missions ${removal.orphaned === 1 ? 'is' : 'are'} stopped and ${removal.orphaned === 1 ? 'refuses' : 'refuse'} every call, until they hold the permissions again.`,
          );
        }
        if (removal.unowned > 0) {
          lines.push(
            `${removal.unowned} ${removal.unowned === 1 ? 'account has' : 'accounts have'} no owner left: name one under Settings → Accounts without owner.`,
          );
        }
        return {
          tone: removal.unowned > 0 ? 'warning' : 'success',
          title: `${removal.user.email} removed from “${removal.group.name}”`,
          lines,
        };
      });
    },
  };
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}
