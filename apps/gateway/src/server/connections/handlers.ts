/**
 * Host-agnostic HTTP handlers of the Connections surface and of Admin →
 * Provider apps (`Request → Response`, never `next`). The Next route handlers
 * under `src/app/**` are one-line adapters over these.
 *
 *   POST /connections/connect/<provider>             start a flow / submit a form
 *   GET  /connections/callback/<provider>            the provider's redirect back
 *   POST /connections/<id>/discover                  refresh discovery
 *   POST /connections/<id>/revoke                    revoke (terminal)
 *   POST /connections/<id>/resources/<resourceId>    owner edits on a resource
 *   POST /admin/provider-apps/<provider>             save / clear the company app, accept or
 *                                                    refuse unverified installations (operator)
 *
 * Every mutation requires a web session and passes the origin check (spec
 * §6). The callback is a top-level GET from the provider: it carries no
 * `Origin`, its protection is the single-use `state` bound to the user who
 * started the flow. Outcomes reach the next page as an opaque one-time notice
 * id, never as text in the URL.
 */
import type { AuditWriter } from '@vaubaan/gateway-core';
import type { PluginRegistry } from '@vaubaan/plugin-sdk';

import {
  auditActorId,
  type Authenticator,
  type Principal,
  type UserPrincipal,
} from '../auth/authenticator';
import {
  guardMutation,
  guardSession,
  OPERATOR_REFUSALS,
  refusalResponse,
  type RefusalWording,
} from '../auth/guard';
import { notAFormResponse, readForm } from '../auth/handlers';
import { resolveReturnTo } from '../http/return-to';
import type { Logger } from '../logging';
import {
  ProviderAppError,
  type ProviderAppsService,
  type ProviderAppStatus,
} from '../provider-apps';
import { toIso, type Clock } from '../store/clock';
import { CONNECT_ERROR_MESSAGES, ConnectError, errorMessage } from './errors';
import type { Notice, NoticeStore } from './pending';
import {
  CONNECTIONS_PATH,
  type Actor,
  type Connected,
  type ConnectionService,
  type DiscoveryRecord,
} from './service';

export const NEW_CONNECTION_PATH = `${CONNECTIONS_PATH}/new`;
export const PROVIDER_APPS_PAGE = '/admin/provider-apps';
export const NOTICE_PARAM = 'notice';
/** Form inputs carrying a `CredentialField` value are named `field.<name>`. */
export const FIELD_PREFIX = 'field.';
/** Form inputs carrying an editable metadata list are named `meta.<key>`. */
export const METADATA_PREFIX = 'meta.';
/** `action` values of the provider-app form besides the default save and `clear`. */
export const ACCEPT_UNVERIFIED_ACTION = 'accept-unverified';
export const REFUSE_UNVERIFIED_ACTION = 'refuse-unverified';
const CLEAR_ACTION = 'clear';
const LOGIN_PAGE = '/login';
const SEE_OTHER = 303;
const USER_REFUSALS: RefusalWording = {
  field: 'reason',
  noSession: 'no session',
  forbidden: 'connections belong to users; sign in through the IdP',
};

export interface ConnectionHandlerDeps {
  readonly publicUrl: URL;
  readonly authenticator: Authenticator;
  readonly connections: ConnectionService;
  /** Tells a provider this instance does not know from a failure of its app settings. */
  readonly registry: Pick<PluginRegistry, 'has'>;
  readonly providerApps: ProviderAppsService;
  readonly notices: NoticeStore;
  readonly audit: AuditWriter;
  readonly logger: Logger;
  readonly clock: Clock;
}

export interface ConnectionHandlers {
  connect(request: Request, providerId: string): Promise<Response>;
  callback(request: Request, providerId: string): Promise<Response>;
  discover(request: Request, connectionId: string): Promise<Response>;
  revoke(request: Request, connectionId: string): Promise<Response>;
  updateResource(request: Request, connectionId: string, resourceId: string): Promise<Response>;
  saveProviderApp(request: Request, providerId: string): Promise<Response>;
}

export function createConnectionHandlers(deps: ConnectionHandlerDeps): ConnectionHandlers {
  const { logger } = deps;

  function redirect(location: string): Response {
    return new Response(null, {
      status: SEE_OTHER,
      headers: { Location: location, 'Cache-Control': 'no-store' },
    });
  }

  async function redirectWithNotice(
    principal: Principal,
    path: string,
    notice: Notice,
  ): Promise<Response> {
    const id = await deps.notices.put(principal.sessionId, notice);
    // `path` was validated when it was stored; it is validated again where it
    // becomes a `Location`, so a value stored by an older build cannot leave
    // the instance.
    const url = new URL(resolveReturnTo(path, deps.publicUrl) ?? CONNECTIONS_PATH, deps.publicUrl);
    url.searchParams.set(NOTICE_PARAM, id);
    return redirect(`${url.pathname}${url.search}${url.hash}`);
  }

  function failureNotice(err: unknown, title: string): Notice {
    if (err instanceof ConnectError) {
      const lines = [CONNECT_ERROR_MESSAGES[err.code]];
      if (err.detail) lines.push(err.detail);
      return { tone: 'danger', title, lines };
    }
    logger.error('connections: unexpected failure', { detail: errorMessage(err) });
    return {
      tone: 'danger',
      title,
      lines: ['An unexpected error occurred. The instance log has the detail.'],
    };
  }

  /** The signed-in user behind a mutation, or the response that refuses it. */
  async function userOf(
    request: Request,
  ): Promise<{ principal: UserPrincipal; actor: Actor } | { response: Response }> {
    const guard = await guardMutation(request, deps, 'user');
    if (!guard.ok) return { response: refusalResponse(guard, USER_REFUSALS) };
    return { principal: guard.principal, actor: actorOf(guard.principal) };
  }

  /**
   * The one audit entry of a provider-app change: what the settings were, what
   * they are. Written after the change is committed, so a failing write is
   * logged and never reported to the operator as a failed save.
   */
  async function auditProviderApp(
    principal: Principal,
    providerId: string,
    before: ProviderAppStatus,
    after: ProviderAppStatus,
  ): Promise<void> {
    const actor = auditActorId(principal);
    try {
      await deps.audit.write({
        kind: 'admin',
        ts: toIso(deps.clock.now()),
        user_id: actor,
        act: 'config-changed',
        object: { type: 'instance-config', id: `provider-app:${providerId}` },
        before: auditView(before),
        after: auditView(after),
        delegated_client_id: null,
      });
    } catch (err) {
      logger.error('audit entry not written for a saved configuration change', {
        actor,
        provider: providerId,
        object: `provider-app:${providerId}`,
        err,
      });
    }
  }

  /** Accepts or refuses installations the plugin cannot verify. */
  async function setInstallAcceptance(
    providerId: string,
    accept: boolean,
  ): Promise<ProviderAppChange> {
    const after = await deps.providerApps.setAcceptUnverifiedInstallations(providerId, accept);
    logger.warn('provider app: acceptance of unverified installations changed', {
      provider: providerId,
      accept,
    });
    return {
      after,
      notice: accept
        ? {
            tone: 'warning',
            title: `${after.displayName}: unverified installations are now accepted`,
            lines: [
              'Any signed-in user who knows the id of an installation of this app can connect it. Turn this off as soon as the plugin can verify installations.',
            ],
          }
        : {
            tone: 'success',
            title: `${after.displayName}: unverified installations are refused`,
            lines: ['Existing connections are unchanged; new ones are refused.'],
          },
    };
  }

  /** Removes the stored company app; refused when the mounted configuration sets it. */
  async function clearProviderApp(
    providerId: string,
    before: ProviderAppStatus,
  ): Promise<ProviderAppChange> {
    if (deps.providerApps.isReadOnly(providerId)) {
      throw new ProviderAppError([
        `${before.displayName} is set by the mounted configuration; edit it there`,
      ]);
    }
    await deps.providerApps.clear(providerId);
    const after = await deps.providerApps.status(providerId);
    logger.info('provider app settings saved', { provider: providerId, cleared: true });
    return {
      after,
      notice: {
        tone: 'success',
        title: `${after.displayName}: settings removed`,
        lines: ['Users can no longer start new connections to this provider.'],
      },
    };
  }

  /** Stores the company app from the form's `field.<name>` values. */
  async function storeProviderApp(providerId: string, form: FormData): Promise<ProviderAppChange> {
    await deps.providerApps.save(providerId, prefixedFields(form, FIELD_PREFIX));
    const after = await deps.providerApps.status(providerId);
    logger.info('provider app settings saved', { provider: providerId, cleared: false });
    return {
      after,
      notice: {
        tone: 'success',
        title: `${after.displayName}: saved`,
        lines: ['Secrets are encrypted at rest with the master key and never shown again.'],
      },
    };
  }

  /** The form's `action` picks the change; no action is a save. */
  function applyProviderAppAction(
    providerId: string,
    form: FormData,
    before: ProviderAppStatus,
  ): Promise<ProviderAppChange> {
    const action = stringField(form, 'action');
    if (action === ACCEPT_UNVERIFIED_ACTION) return setInstallAcceptance(providerId, true);
    if (action === REFUSE_UNVERIFIED_ACTION) return setInstallAcceptance(providerId, false);
    if (action === CLEAR_ACTION) return clearProviderApp(providerId, before);
    return storeProviderApp(providerId, form);
  }

  return {
    async connect(request, providerId) {
      const who = await userOf(request);
      if ('response' in who) return who.response;
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      const reconnectId = stringField(form, 'connection_id') || null;
      try {
        const result = await deps.connections.start(who.actor, providerId, {
          displayName: stringField(form, 'name'),
          returnTo: stringField(form, 'return_to') || null,
          reconnectId,
          fields: prefixedFields(form, FIELD_PREFIX),
        });
        if (result.kind === 'redirect') return redirect(result.url);
        return await redirectWithNotice(
          who.principal,
          result.returnTo ?? connectionPath(result.connection.id),
          connectedNotice(result),
        );
      } catch (err) {
        const unknownProvider = err instanceof ConnectError && err.code === 'provider-unknown';
        const back = unknownProvider
          ? NEW_CONNECTION_PATH
          : `${NEW_CONNECTION_PATH}/${encodeURIComponent(providerId)}${
              reconnectId ? `?connection=${encodeURIComponent(reconnectId)}` : ''
            }`;
        return redirectWithNotice(who.principal, back, failureNotice(err, 'Not connected'));
      }
    },

    async callback(request, providerId) {
      const guard = await guardSession(request, deps, 'user');
      if (!guard.ok) return redirect(LOGIN_PAGE);
      const { principal } = guard;
      try {
        const result = await deps.connections.complete(
          actorOf(principal),
          providerId,
          new URL(request.url).searchParams,
        );
        return await redirectWithNotice(
          principal,
          result.returnTo ?? connectionPath(result.connection.id),
          connectedNotice(result),
        );
      } catch (err) {
        return redirectWithNotice(principal, CONNECTIONS_PATH, failureNotice(err, 'Not connected'));
      }
    },

    async discover(request, connectionId) {
      const who = await userOf(request);
      if ('response' in who) return who.response;
      try {
        const outcome = await deps.connections.discover(who.actor, connectionId);
        return await redirectWithNotice(
          who.principal,
          connectionPath(connectionId),
          discoveryNotice(outcome),
        );
      } catch (err) {
        return redirectWithNotice(
          who.principal,
          CONNECTIONS_PATH,
          failureNotice(err, 'Discovery not refreshed'),
        );
      }
    },

    async revoke(request, connectionId) {
      const who = await userOf(request);
      if ('response' in who) return who.response;
      try {
        const revoked = await deps.connections.revoke(who.actor, connectionId);
        return await redirectWithNotice(who.principal, connectionPath(revoked.id), {
          tone: 'success',
          title: 'Connection revoked',
          lines: [
            'The stored credential was erased. Missions that carry this connection now refuse every call.',
            'The authorization granted at the provider is not withdrawn by the gateway: remove it there too if needed.',
          ],
        });
      } catch (err) {
        return redirectWithNotice(
          who.principal,
          CONNECTIONS_PATH,
          failureNotice(err, 'Not revoked'),
        );
      }
    },

    async updateResource(request, connectionId, resourceId) {
      const who = await userOf(request);
      if ('response' in who) return who.response;
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      try {
        const resource = await deps.connections.updateResource(
          who.actor,
          connectionId,
          resourceId,
          {
            ...(form.has('display_name') ? { displayName: stringField(form, 'display_name') } : {}),
            ...(form.has('env') ? { env: stringField(form, 'env') } : {}),
            // A checkbox is absent when unchecked: `hidden_present` marks a form that carries it.
            ...(form.has('hidden_present') ? { hidden: form.get('hidden') === 'on' } : {}),
            metadata: prefixedFields(form, METADATA_PREFIX),
          },
        );
        return await redirectWithNotice(who.principal, connectionPath(connectionId), {
          tone: 'success',
          title: 'Resource saved',
          lines: [`${resource.ref} — your edits are kept across discovery refreshes.`],
        });
      } catch (err) {
        const missing = err instanceof ConnectError && err.code === 'not-found';
        return redirectWithNotice(
          who.principal,
          missing ? CONNECTIONS_PATH : connectionPath(connectionId),
          failureNotice(err, 'Resource not saved'),
        );
      }
    },

    async saveProviderApp(request, providerId) {
      const guard = await guardMutation(request, deps, 'operator');
      if (!guard.ok) return refusalResponse(guard, OPERATOR_REFUSALS);

      const form = await readForm(request);
      if (!form) return notAFormResponse();
      // Only a provider this instance does not know is reported as unknown; a failure
      // to read its settings (the store, the configuration) is not, and propagates.
      if (!deps.registry.has(providerId)) {
        return redirectWithNotice(guard.principal, PROVIDER_APPS_PAGE, {
          tone: 'danger',
          title: 'Not saved',
          lines: [CONNECT_ERROR_MESSAGES['provider-unknown']],
        });
      }
      const anchor = `${PROVIDER_APPS_PAGE}#${encodeURIComponent(providerId)}`;
      const before = await deps.providerApps.status(providerId);
      try {
        const change = await applyProviderAppAction(providerId, form, before);
        await auditProviderApp(guard.principal, providerId, before, change.after);
        return await redirectWithNotice(guard.principal, anchor, change.notice);
      } catch (err) {
        if (err instanceof ProviderAppError) {
          return redirectWithNotice(guard.principal, anchor, {
            tone: 'danger',
            title: `${before.displayName}: not saved`,
            lines: err.problems,
          });
        }
        throw err;
      }
    },
  };
}

/** What a provider-app action changed, and what the operator is told. */
interface ProviderAppChange {
  readonly after: ProviderAppStatus;
  readonly notice: Notice;
}

export function connectionPath(connectionId: string): string {
  return `${CONNECTIONS_PATH}/${encodeURIComponent(connectionId)}`;
}

export function actorOf(principal: UserPrincipal): Actor {
  return { user: principal.user, groups: principal.groups };
}

function connectedNotice(result: Connected): Notice {
  const title = result.reconnected ? 'Reconnected' : 'Connected';
  const stored = 'The credential is stored encrypted, under your name.';
  if (!result.discovery) {
    return {
      tone: 'info',
      title,
      lines: [
        stored,
        'Install the public key shown below on the host, then use "Refresh discovery".',
      ],
    };
  }
  if (!result.discovery.ok) {
    return {
      tone: 'warning',
      title: `${title}, but resource discovery failed`,
      lines: [
        stored,
        result.discovery.error ?? 'The provider gave no reason.',
        'Fix the cause, then use "Refresh discovery".',
      ],
    };
  }
  return {
    tone: 'success',
    title,
    lines: [stored, `${countLabel(result.discovery.count)} discovered. Label their environments.`],
  };
}

function discoveryNotice(outcome: DiscoveryRecord): Notice {
  return outcome.ok
    ? {
        tone: 'success',
        title: 'Discovery refreshed',
        lines: [
          `${countLabel(outcome.count)} reachable. Your labels, names and hidden flags are unchanged.`,
        ],
      }
    : {
        tone: 'danger',
        title: 'Discovery failed',
        lines: [
          outcome.error ?? 'The provider gave no reason.',
          'The known resources are unchanged.',
        ],
      };
}

function countLabel(count: number): string {
  return count === 1 ? '1 resource' : `${count} resources`;
}

function auditView(status: ProviderAppStatus): Record<string, unknown> {
  return {
    source: status.source,
    values: status.values,
    secrets_set: status.secretsSet,
    ...(status.installVerification ? { install_verification: status.installVerification } : {}),
  };
}

function stringField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function prefixedFields(form: FormData, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of form.entries()) {
    if (name.startsWith(prefix) && typeof value === 'string')
      out[name.slice(prefix.length)] = value;
  }
  return out;
}
