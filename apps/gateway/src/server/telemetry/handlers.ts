/**
 * Host-agnostic HTTP handler of Admin → Telemetry (`Request → Response`,
 * never `next`).
 *
 *   POST /api/admin/telemetry   `enabled=true|false` — the operator's toggle
 *
 * Operator only, origin-checked (spec §6). A change writes one
 * `config-changed` entry on `instance-config:telemetry` (spec §8); a toggle
 * that changes nothing writes none. While the mounted configuration sets
 * `telemetry.enabled`, the toggle is refused: the file wins.
 */
import type { AuditWriter } from '@vaubaan/gateway-core';

import { auditActorId, type Authenticator } from '../auth/authenticator';
import { guardMutation, OPERATOR_REFUSALS, refusalResponse } from '../auth/guard';
import { notAFormResponse, readForm } from '../http/form';
import type { Logger } from '../logging';
import { toIso, type Clock } from '../store/clock';
import {
  TELEMETRY_CONFIG_OBJECT_ID,
  TelemetryLockedError,
  type TelemetrySettingsService,
} from './settings';

export const TELEMETRY_PAGE = '/admin/telemetry';
export const TELEMETRY_ACTION = '/api/admin/telemetry';
/** Form field of the toggle; its value is `true` or `false`. */
export const ENABLED_FIELD = 'enabled';
/** Query parameter by which the page learns why a toggle was refused. */
export const PROBLEM_PARAM = 'problem';
export type TelemetryProblem = 'locked' | 'invalid';

const SEE_OTHER = 303;

export interface TelemetryHandlerDeps {
  readonly publicUrl: URL;
  readonly authenticator: Authenticator;
  readonly settings: TelemetrySettingsService;
  readonly audit: AuditWriter;
  readonly logger: Logger;
  readonly clock: Clock;
}

export interface TelemetryHandlers {
  setEnabled(request: Request): Promise<Response>;
}

function redirect(location: string): Response {
  return new Response(null, {
    status: SEE_OTHER,
    headers: { Location: location, 'Cache-Control': 'no-store' },
  });
}

function problem(code: TelemetryProblem): Response {
  return redirect(`${TELEMETRY_PAGE}?${PROBLEM_PARAM}=${code}`);
}

export function createTelemetryHandlers(deps: TelemetryHandlerDeps): TelemetryHandlers {
  return {
    async setEnabled(request) {
      const guard = await guardMutation(request, deps, 'operator');
      if (!guard.ok) return refusalResponse(guard, OPERATOR_REFUSALS);

      const form = await readForm(request);
      if (!form) return notAFormResponse();
      const raw = form.get(ENABLED_FIELD);
      if (raw !== 'true' && raw !== 'false') return problem('invalid');

      let change: Awaited<ReturnType<TelemetrySettingsService['setEnabled']>>;
      try {
        change = await deps.settings.setEnabled(raw === 'true');
      } catch (err) {
        if (err instanceof TelemetryLockedError) return problem('locked');
        throw err;
      }
      const { before, after } = change;
      if (before.enabled === after.enabled && before.source === after.source) {
        return redirect(TELEMETRY_PAGE);
      }

      const actor = auditActorId(guard.principal);
      try {
        await deps.audit.write({
          kind: 'admin',
          ts: toIso(deps.clock.now()),
          user_id: actor,
          act: 'config-changed',
          object: { type: 'instance-config', id: TELEMETRY_CONFIG_OBJECT_ID },
          before,
          after,
          delegated_client_id: null,
        });
      } catch (err) {
        // The toggle is committed; a missing entry must at least be loud.
        deps.logger.error('audit entry not written for a saved configuration change', {
          actor,
          object: TELEMETRY_CONFIG_OBJECT_ID,
          err,
        });
      }
      deps.logger.info('telemetry toggled by the operator', { enabled: after.enabled });
      return redirect(TELEMETRY_PAGE);
    },
  };
}
