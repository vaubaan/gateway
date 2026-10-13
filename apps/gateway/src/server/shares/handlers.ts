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
import type { ShareService, ShareTargetInput } from './service';

/** Form field names of the Share dialog. */
export const SHARE_FIELDS = {
  targetKind: 'target_kind',
  email: 'target_email',
  group: 'target_group',
  risk: 'risk',
} as const;

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
      try {
        const outcome = await deps.shares.share(actorOf(principal), connectionId, {
          target: targetOf(form),
          riskIds: form.getAll(SHARE_FIELDS.risk).filter((v): v is string => typeof v === 'string'),
        });
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
