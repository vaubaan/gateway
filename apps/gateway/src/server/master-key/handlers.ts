/**
 * Host-agnostic HTTP handlers of the master key (`Request → Response`, never
 * `next`), on Administration → Setup and Administration → Encryption:
 *
 *   POST /api/admin/master-key/download     `confirmed=on&from=setup|settings|welcome`
 *                                            — the key file, as an attachment
 *   POST /api/admin/master-key/handed-over  `confirmed=on[&from=welcome]` — "I kept it in a
 *                                            safe place"
 *
 * Operator only, origin-checked (spec §6). The download needs a **fresh
 * sign-in**: a session opened less than `FRESH_SIGN_IN_MS` ago (there was no
 * re-authentication rule before this one; the page says to sign in again
 * otherwise). Every download writes one `master-key-downloaded` entry — who, when,
 * from which page, the key version — **before** the key leaves: no entry, no key.
 * The entry, the log line and every refusal carry nothing of the key.
 */
import type { AuditWriter } from '@vaubaan/gateway-core';

import { auditActorId, type Authenticator } from '../auth/authenticator';
import { guardMutation, OPERATOR_REFUSALS, refusalResponse } from '../auth/guard';
import { notAFormResponse, readForm } from '../http/form';
import type { SessionService } from '../auth/session-service';
import { MASTER_KEY_FILE_NAME } from '../crypto/master-key-file';
import type { Logger } from '../logging';
import { toIso, type Clock } from '../store/clock';
import { MASTER_KEY_OBJECT_ID, type MasterKeyService } from './service';

/** The audit object as the log names it (`instance-config` / `master-key`). */
const AUDIT_OBJECT = MASTER_KEY_OBJECT_ID;

export const MASTER_KEY_DOWNLOAD_ACTION = '/api/admin/master-key/download';
export const MASTER_KEY_HANDOVER_ACTION = '/api/admin/master-key/handed-over';
/** Where each form lives, and where its refusal lands. */
export const SETUP_PAGE = '/admin';
export const ENCRYPTION_PAGE = '/admin/encryption';
/** The setup of an instance in local mode: the key, then the person's account. */
export const WELCOME_PAGE = '/welcome';
/** The section of Setup that holds the handover step. */
export const HANDOVER_ANCHOR = 'encryption-key';
/** Form fields. */
export const CONFIRMED_FIELD = 'confirmed';
export const FROM_FIELD = 'from';
/** Query parameter by which the page learns why a request was refused. */
export const KEY_PROBLEM_PARAM = 'key-problem';
export type MasterKeyProblem = 'sign-in-again' | 'not-confirmed';
/** Where a download was asked from; written in the audit entry. */
export type DownloadOrigin = 'setup' | 'settings' | 'welcome';
/** How recent the sign-in behind a download must be. */
export const FRESH_SIGN_IN_MS = 10 * 60_000;

const SEE_OTHER = 303;

export interface MasterKeyHandlerDeps {
  readonly publicUrl: URL;
  readonly authenticator: Authenticator;
  readonly sessions: Pick<SessionService, 'read'>;
  readonly service: MasterKeyService;
  readonly audit: AuditWriter;
  readonly logger: Logger;
  readonly clock: Clock;
}

export interface MasterKeyHandlers {
  download(request: Request): Promise<Response>;
  confirmHandover(request: Request): Promise<Response>;
}

function redirect(location: string): Response {
  return new Response(null, {
    status: SEE_OTHER,
    headers: { Location: location, 'Cache-Control': 'no-store' },
  });
}

function pageOf(from: DownloadOrigin): string {
  if (from === 'welcome') return WELCOME_PAGE;
  return from === 'setup' ? `${SETUP_PAGE}#${HANDOVER_ANCHOR}` : ENCRYPTION_PAGE;
}

function problem(from: DownloadOrigin, code: MasterKeyProblem): Response {
  if (from === 'welcome') return redirect(`${WELCOME_PAGE}?${KEY_PROBLEM_PARAM}=${code}`);
  const page = from === 'setup' ? SETUP_PAGE : ENCRYPTION_PAGE;
  const anchor = from === 'setup' ? `#${HANDOVER_ANCHOR}` : '';
  return redirect(`${page}?${KEY_PROBLEM_PARAM}=${code}${anchor}`);
}

function originOf(form: FormData): DownloadOrigin {
  const from = form.get(FROM_FIELD);
  return from === 'setup' || from === 'welcome' ? from : 'settings';
}

function confirmed(form: FormData): boolean {
  return form.get(CONFIRMED_FIELD) === 'on';
}

/** Whether the session behind the request was opened recently enough to hand the key over. */
export async function signedInFreshly(
  sessions: Pick<SessionService, 'read'>,
  headers: Headers,
  now: Date,
): Promise<boolean> {
  const session = await sessions.read(headers);
  if (!session) return false;
  const createdAt = Date.parse(session.record.createdAt);
  return Number.isFinite(createdAt) && now.getTime() - createdAt < FRESH_SIGN_IN_MS;
}

export function createMasterKeyHandlers(deps: MasterKeyHandlerDeps): MasterKeyHandlers {
  return {
    async download(request) {
      const guard = await guardMutation(request, deps, 'operator');
      if (!guard.ok) return refusalResponse(guard, OPERATOR_REFUSALS);
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      const from = originOf(form);
      // On Setup the handover step is the confirmation; Administration → Encryption asks for one.
      if (from === 'settings' && !confirmed(form)) return problem(from, 'not-confirmed');
      const now = deps.clock.now();
      if (!(await signedInFreshly(deps.sessions, request.headers, now))) {
        deps.logger.warn('master key download refused: the sign-in is not fresh', { from });
        return problem(from, 'sign-in-again');
      }
      const actor = auditActorId(guard.principal);
      const state = await deps.service.state();
      // No entry, no key: the download is refused when it cannot be recorded.
      await deps.audit.write({
        kind: 'admin',
        ts: toIso(now),
        user_id: actor,
        act: 'master-key-downloaded',
        object: { type: 'instance-config', id: MASTER_KEY_OBJECT_ID },
        before: null,
        after: { key_version: state.keyVersion, from },
      });
      deps.logger.info('master key downloaded by an administrator', {
        actor,
        from,
        key_version: state.keyVersion,
      });
      return new Response(deps.service.fileText(), {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="${MASTER_KEY_FILE_NAME}"`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    },

    async confirmHandover(request) {
      const guard = await guardMutation(request, deps, 'operator');
      if (!guard.ok) return refusalResponse(guard, OPERATOR_REFUSALS);
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      // Setup's handover step, or the first screen of a local instance's setup.
      const from: DownloadOrigin = form.get(FROM_FIELD) === 'welcome' ? 'welcome' : 'setup';
      if (!confirmed(form)) return problem(from, 'not-confirmed');
      const { handedOverAt, already } = await deps.service.confirmHandover();
      if (already) return redirect(pageOf(from));
      const actor = auditActorId(guard.principal);
      try {
        await deps.audit.write({
          kind: 'admin',
          ts: toIso(deps.clock.now()),
          user_id: actor,
          act: 'config-changed',
          object: { type: 'instance-config', id: MASTER_KEY_OBJECT_ID },
          before: { handed_over_at: null },
          after: { handed_over_at: handedOverAt },
        });
      } catch (err) {
        // The confirmation is saved; a missing entry must at least be loud.
        deps.logger.error('audit entry not written for a saved configuration change', {
          actor,
          object: AUDIT_OBJECT,
          err,
        });
      }
      deps.logger.info('master key handover confirmed by an administrator');
      return redirect(from === 'welcome' ? WELCOME_PAGE : SETUP_PAGE);
    },
  };
}
