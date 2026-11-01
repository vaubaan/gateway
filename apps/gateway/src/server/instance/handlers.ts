/**
 * Host-agnostic HTTP handler of the instance's name, on Administration →
 * Setup (`Request → Response`, never `next`).
 *
 *   POST /api/admin/instance-name   `name=<text>` — set it; blank clears it
 *
 * Operator only, origin-checked (spec §6). A change writes one
 * `config-changed` entry on `instance-config:instance-name` (spec §8); a save
 * that changes nothing writes none. While the mounted configuration sets
 * `instance_name`, the change is refused: the file wins.
 */
import type { AuditWriter } from '@vaubaan/gateway-core';

import { auditActorId, type Authenticator } from '../auth/authenticator';
import { guardMutation, OPERATOR_REFUSALS, refusalResponse } from '../auth/guard';
import { notAFormResponse, readForm } from '../http/form';
import type { Logger } from '../logging';
import { toIso, type Clock } from '../store/clock';
import {
  INSTANCE_NAME_OBJECT_ID,
  InstanceNameLockedError,
  InvalidInstanceNameError,
  type InstanceNameService,
} from './settings';

/** The page the field lives on, and the section the redirect lands on. */
export const INSTANCE_NAME_PAGE = '/admin';
export const INSTANCE_NAME_ANCHOR = 'instance-name';
export const INSTANCE_NAME_ACTION = '/api/admin/instance-name';
/** Form field of the name. */
export const NAME_FIELD = 'name';
/** Query parameter by which the page learns why a change was refused. */
export const NAME_PROBLEM_PARAM = 'name-problem';
export type InstanceNameProblem = 'locked' | 'invalid' | InvalidInstanceNameError['problem'];

const SEE_OTHER = 303;

export interface InstanceNameHandlerDeps {
  readonly publicUrl: URL;
  readonly authenticator: Authenticator;
  readonly settings: InstanceNameService;
  readonly audit: AuditWriter;
  readonly logger: Logger;
  readonly clock: Clock;
}

export interface InstanceNameHandlers {
  setName(request: Request): Promise<Response>;
}

function redirect(location: string): Response {
  return new Response(null, {
    status: SEE_OTHER,
    headers: { Location: location, 'Cache-Control': 'no-store' },
  });
}

function back(): Response {
  return redirect(`${INSTANCE_NAME_PAGE}#${INSTANCE_NAME_ANCHOR}`);
}

function problem(code: InstanceNameProblem): Response {
  return redirect(`${INSTANCE_NAME_PAGE}?${NAME_PROBLEM_PARAM}=${code}#${INSTANCE_NAME_ANCHOR}`);
}

export function createInstanceNameHandlers(deps: InstanceNameHandlerDeps): InstanceNameHandlers {
  return {
    async setName(request) {
      const guard = await guardMutation(request, deps, 'operator');
      if (!guard.ok) return refusalResponse(guard, OPERATOR_REFUSALS);

      const form = await readForm(request);
      if (!form) return notAFormResponse();
      const raw = form.get(NAME_FIELD);
      if (typeof raw !== 'string') return problem('invalid');

      let change: Awaited<ReturnType<InstanceNameService['setName']>>;
      try {
        change = await deps.settings.setName(raw);
      } catch (err) {
        if (err instanceof InstanceNameLockedError) return problem('locked');
        if (err instanceof InvalidInstanceNameError) return problem(err.problem);
        throw err;
      }
      const { before, after } = change;
      if (before.name === after.name && before.source === after.source) return back();

      const actor = auditActorId(guard.principal);
      try {
        await deps.audit.write({
          kind: 'admin',
          ts: toIso(deps.clock.now()),
          user_id: actor,
          act: 'config-changed',
          object: { type: 'instance-config', id: INSTANCE_NAME_OBJECT_ID },
          before,
          after,
          delegated_client_id: null,
        });
      } catch (err) {
        // The name is saved; a missing entry must at least be loud.
        deps.logger.error('audit entry not written for a saved configuration change', {
          actor,
          object: INSTANCE_NAME_OBJECT_ID,
          err,
        });
      }
      deps.logger.info('instance name changed by an administrator', { source: after.source });
      return back();
    },
  };
}
