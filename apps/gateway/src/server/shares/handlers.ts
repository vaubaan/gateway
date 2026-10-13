/**
 * Host-agnostic HTTP handlers of the share acts (`Request → Response`, never
 * `next`). The Next route handlers under `src/app/(app)/connections/[id]/shares/**`
 * are one-line adapters over these.
 *
 *   POST /connections/<id>/shares                    share, or replace the target's restriction
 *   POST /connections/<id>/shares/<shareId>/revoke   revoke (terminal)
 *
 * Every one requires a user session and passes the origin check (spec §6).
 * The form carries the restriction as one `risk` value per ticked risk: the
 * browser resolves "select all" to that list, the server never receives
 * "all".
 *
 * A share that would bring orphaned missions back is not made on the first
 * post (spec §2.3): the dialog comes back with their names, and the share is
 * made by the post that carries one `restore` value per mission it listed. A
 * mission that became restorable in between was not read: the dialog comes
 * back once more, with the list of that instant.
 */
import { guardMutation, refusalResponse, type Authenticator, type RefusalWording } from '../auth';
import { notAFormResponse, readForm } from '../auth/handlers';
import {
  actorOf,
  connectionPath,
  CONNECTIONS_PATH,
  createNoticeRedirect,
  type Notice,
  type NoticeStore,
} from '../connections';
import type { Logger } from '../logging';
import { SHARE_ERROR_MESSAGES, ShareError } from './errors';
import { SHARE_CONFIRM_PARAM, type PendingShareStore } from './pending';
import type { ShareInput, ShareService, ShareTargetInput } from './service';

/** Form field names of the Share dialog. */
export const SHARE_FIELDS = {
  targetKind: 'target_kind',
  email: 'target_email',
  group: 'target_group',
  risk: 'risk',
  /** One value per orphaned mission the owner was shown and agrees to bring back. */
  restore: 'restore',
} as const;

const SEE_OTHER = 303;

const USER_REFUSALS: RefusalWording = {
  field: 'reason',
  noSession: 'no session',
  forbidden: 'connections are shared by users; sign in through the IdP',
};

export interface ShareHandlerDeps {
  readonly publicUrl: URL;
  readonly authenticator: Authenticator;
  readonly shares: ShareService;
  readonly notices: NoticeStore;
  readonly pending: PendingShareStore;
  readonly logger: Logger;
}

export interface ShareHandlers {
  share(request: Request, connectionId: string): Promise<Response>;
  revoke(request: Request, connectionId: string, shareId: string): Promise<Response>;
}

/** The Share dialog of a connection. */
export function sharePath(connectionId: string): string {
  return `${connectionPath(connectionId)}/share`;
}

export function createShareHandlers(deps: ShareHandlerDeps): ShareHandlers {
  const redirectWithNotice = createNoticeRedirect(deps, CONNECTIONS_PATH);

  function failure(err: unknown, title: string): Notice {
    if (err instanceof ShareError) {
      const lines = [SHARE_ERROR_MESSAGES[err.code]];
      if (err.detail) lines.push(err.detail);
      return { tone: 'danger', title, lines };
    }
    deps.logger.error('shares: unexpected failure', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return {
      tone: 'danger',
      title,
      lines: ['An unexpected error occurred. The instance log has the detail.'],
    };
  }

  return {
    async share(request, connectionId) {
      const guard = await guardMutation(request, deps, 'user');
      if (!guard.ok) return refusalResponse(guard, USER_REFUSALS);
      const { principal } = guard;
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      const input: ShareInput = {
        target: targetOf(form),
        riskIds: values(form, SHARE_FIELDS.risk),
      };
      try {
        const actor = actorOf(principal);
        // The same refusals as the share itself, then what it would bring back.
        const forecast = await deps.shares.forecast(actor, connectionId, input);
        const read = new Set(values(form, SHARE_FIELDS.restore));
        if (forecast.restores.some((mission) => !read.has(mission.id))) {
          const id = await deps.pending.put(principal.sessionId, { connectionId, input });
          return confirmationRedirect(connectionId, id);
        }
        const outcome = await deps.shares.share(actor, connectionId, input);
        const count = outcome.share.restriction.length;
        const lines = [
          `${outcome.targetLabel} may now accept ${count} ${count === 1 ? 'risk' : 'risks'} of this connection in their missions, and nothing else.`,
        ];
        if (outcome.replaced) lines.push('This replaces the restriction they held before.');
        if (outcome.orphaned > 0) lines.push(orphanedLine(outcome.orphaned));
        if (outcome.restored > 0) lines.push(restoredLine(outcome.restored));
        return await redirectWithNotice(principal.sessionId, connectionPath(connectionId), {
          tone: 'success',
          title: outcome.replaced ? 'Share updated' : 'Shared',
          lines,
        });
      } catch (err) {
        const missing = err instanceof ShareError && err.code === 'not-found';
        return redirectWithNotice(
          principal.sessionId,
          missing ? CONNECTIONS_PATH : sharePath(connectionId),
          failure(err, 'Not shared'),
        );
      }
    },

    async revoke(request, connectionId, shareId) {
      const guard = await guardMutation(request, deps, 'user');
      if (!guard.ok) return refusalResponse(guard, USER_REFUSALS);
      const { principal } = guard;
      try {
        const outcome = await deps.shares.revoke(actorOf(principal), shareId, connectionId);
        const lines = [`${outcome.targetLabel} can no longer issue missions on this connection.`];
        lines.push(
          outcome.orphaned > 0
            ? orphanedLine(outcome.orphaned)
            : 'No active mission depended on this share.',
        );
        return await redirectWithNotice(
          principal.sessionId,
          connectionPath(outcome.share.connectionId),
          { tone: 'success', title: 'Share revoked', lines },
        );
      } catch (err) {
        const missing = err instanceof ShareError && err.code === 'not-found';
        return redirectWithNotice(
          principal.sessionId,
          missing ? CONNECTIONS_PATH : connectionPath(connectionId),
          failure(err, 'Not revoked'),
        );
      }
    },
  };
}

/** Back to the dialog, which lists what the share would bring back. Nothing was stored. */
function confirmationRedirect(connectionId: string, pendingId: string): Response {
  const query = new URLSearchParams({ [SHARE_CONFIRM_PARAM]: pendingId });
  return new Response(null, {
    status: SEE_OTHER,
    headers: {
      Location: `${sharePath(connectionId)}?${query.toString()}`,
      'Cache-Control': 'no-store',
    },
  });
}

function values(form: FormData, name: string): string[] {
  return form.getAll(name).filter((value): value is string => typeof value === 'string');
}

function orphanedLine(count: number): string {
  return `${count} ${count === 1 ? 'mission that depended on it is' : 'missions that depended on it are'} now orphaned and ${count === 1 ? 'refuses' : 'refuse'} every call, until a share covers ${count === 1 ? 'it' : 'them'} again.`;
}

function restoredLine(count: number): string {
  return `${count} orphaned ${count === 1 ? 'mission is' : 'missions are'} covered again and ${count === 1 ? 'serves' : 'serve'} calls from now on, with ${count === 1 ? 'its' : 'their'} session and counters as they were.`;
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function targetOf(form: FormData): ShareTargetInput {
  return field(form, SHARE_FIELDS.targetKind) === 'group'
    ? { kind: 'group', groupId: field(form, SHARE_FIELDS.group) }
    : { kind: 'user', email: field(form, SHARE_FIELDS.email) };
}
