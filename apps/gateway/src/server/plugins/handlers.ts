/**
 * Administration › Plugins, the acts (spec vaubaan-gateway §4.2; ADR
 * plugins-activated-by-an-administrator-on-trial): upload an archive, activate a version
 * at the next start, refuse one, let a plugin follow the image again, and restart. Each
 * is a form POST from the page, guarded for an administrator (origin, session, role),
 * answered by a 303 back to the page with what happened or the problem.
 */
import type { AuditWriter } from '@vaubaan/gateway-core';
import { ARCHIVE_LIMITS } from '@vaubaan/plugin-sdk/archive';

import { auditActorId, type Authenticator } from '../auth/authenticator';
import { guardMutation, OPERATOR_REFUSALS, refusalResponse } from '../auth/guard';
import { notAFormResponse, readForm } from '../http/form';
import type { Logger } from '../logging';
import { toIso, type Clock } from '../store/clock';
import type { PluginInstallService } from './install-service';

export const PLUGINS_PAGE = '/admin/plugins';
/** The forms of the page, one route each (`app/admin/(guarded)/plugins/<act>/route.ts`). */
export const PLUGIN_ACTIONS = {
  upload: `${PLUGINS_PAGE}/upload`,
  activate: `${PLUGINS_PAGE}/activate`,
  refuse: `${PLUGINS_PAGE}/refuse`,
  followImage: `${PLUGINS_PAGE}/follow-image`,
  restart: `${PLUGINS_PAGE}/restart`,
} as const;
export const ARCHIVE_FIELD = 'archive';
export const DIGEST_FIELD = 'digest';
export const PLUGIN_FIELD = 'plugin';
export const CONFIRM_FIELD = 'confirm';
/** Query parameters the page reads back. */
export const DONE_PARAM = 'done';
export const PROBLEM_PARAM = 'problem';
export const DETAIL_PARAM = 'detail';
export const VERSION_PARAM = 'version';

const SEE_OTHER = 303;

export interface PluginHandlerDeps {
  readonly publicUrl: URL;
  readonly authenticator: Authenticator;
  readonly install: PluginInstallService;
  readonly logger: Logger;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  /** Ends the process for its supervisor to start it again (exit code 75). */
  readonly requestRestart: () => void;
}

export interface PluginHandlers {
  upload(request: Request): Promise<Response>;
  activate(request: Request): Promise<Response>;
  refuse(request: Request): Promise<Response>;
  followImage(request: Request): Promise<Response>;
  restart(request: Request): Promise<Response>;
}

function back(params: Record<string, string>): Response {
  const query = new URLSearchParams(params).toString();
  return new Response(null, {
    status: SEE_OTHER,
    headers: {
      Location: query === '' ? PLUGINS_PAGE : `${PLUGINS_PAGE}?${query}`,
      'Cache-Control': 'no-store',
    },
  });
}

function problem(code: string, detail?: string): Response {
  return back(
    detail === undefined
      ? { [PROBLEM_PARAM]: code }
      : { [PROBLEM_PARAM]: code, [DETAIL_PARAM]: detail.slice(0, 400) },
  );
}

function field(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export function createPluginHandlers(deps: PluginHandlerDeps): PluginHandlers {
  async function guarded(
    request: Request,
    act: (form: FormData, actor: { userId: string }) => Promise<Response>,
  ): Promise<Response> {
    const guard = await guardMutation(request, deps, 'operator');
    if (!guard.ok) return refusalResponse(guard, OPERATOR_REFUSALS);
    const form = await readForm(request);
    if (!form) return notAFormResponse();
    return act(form, { userId: auditActorId(guard.principal) });
  }

  return {
    upload: (request) =>
      guarded(request, async (form, actor) => {
        const file = form.get(ARCHIVE_FIELD);
        if (file === null || typeof file === 'string' || file.size === 0)
          return problem('no-archive');
        if (file.size > ARCHIVE_LIMITS.compressedBytes) return problem('archive-too-large');
        const result = await deps.install.upload(new Uint8Array(await file.arrayBuffer()), actor);
        if (!result.ok) return problem(result.code, result.message);
        deps.logger.info('plugin archive uploaded', {
          plugin: result.version.pluginId,
          version: result.version.version,
          digest: result.version.digest,
        });
        return back({ [DONE_PARAM]: 'uploaded', [VERSION_PARAM]: result.version.digest });
      }),

    activate: (request) =>
      guarded(request, async (form, actor) => {
        const digest = field(form, DIGEST_FIELD);
        if (digest === null) return problem('not-found');
        const result = await deps.install.activate(digest, field(form, CONFIRM_FIELD) ?? '', actor);
        if (!result.ok) return problem(result.code, result.message);
        return back({ [DONE_PARAM]: 'activated', [VERSION_PARAM]: digest });
      }),

    refuse: (request) =>
      guarded(request, async (form, actor) => {
        const digest = field(form, DIGEST_FIELD);
        if (digest === null) return problem('not-found');
        const result = await deps.install.refuse(digest, actor);
        if (!result.ok) return problem(result.code, result.message);
        return back({ [DONE_PARAM]: 'refused' });
      }),

    followImage: (request) =>
      guarded(request, async (form, actor) => {
        const plugin = field(form, PLUGIN_FIELD);
        if (plugin === null) return problem('not-found');
        const result = await deps.install.followImage(plugin, actor);
        if (!result.ok) return problem(result.code, result.message);
        return back({ [DONE_PARAM]: 'followed-image' });
      }),

    restart: (request) =>
      guarded(request, async (_form, actor) => {
        deps.logger.warn('restart requested by an administrator', { actor: actor.userId });
        try {
          await deps.audit.write({
            kind: 'admin',
            ts: toIso(deps.clock.now()),
            user_id: actor.userId,
            act: 'instance-restarted',
            object: { type: 'instance-config', id: 'process' },
            before: null,
            after: null,
          });
        } catch (err) {
          deps.logger.error('audit entry not written for a restart', { err });
        }
        // Answer first: the redirect reaches the browser before the process ends.
        setTimeout(() => deps.requestRestart(), 500).unref();
        return back({ [DONE_PARAM]: 'restarting' });
      }),
  };
}
