/**
 * Host-agnostic HTTP handlers of the Connections surface
 * (`Request → Response`, never `next`). The Next route handlers under
 * `src/app/**` are one-line adapters over these.
 *
 *   POST /connections/connect/<provider>             start a flow / submit a form
 *   GET  /connections/callback/<provider>            the provider's redirect back
 *   POST /connections/<id>/discover                  refresh discovery
 *   POST /connections/<id>/revoke                    revoke (terminal)
 *   POST /connections/<id>/transfer                  transfer ownership to a group of the owner
 *   POST /admin/connections/<id>/reassign            give an ownerless connection an owner (operator)
 *   POST /connections/<id>/resources/<resourceId>    owner edits on a resource
 *   POST /connections/<id>/default-env               the owner's default environment label
 *                                                    for the unlabelled resources
 *
 * Every mutation requires a web session and passes the origin check (spec
 * §6). The callback is a top-level GET from the provider: it carries no
 * `Origin`, its protection is the single-use `state` bound to the user who
 * started the flow. Outcomes reach the next page as an opaque one-time notice
 * id, never as text in the URL.
 */
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
import { errorFields, type Logger } from '../logging';
import { CONNECT_ERROR_MESSAGES, ConnectError } from './errors';
import { echoOfForm } from './input';
import type { Notice, NoticeStore } from './pending';
import { providerGrantReport } from './provider-grant';
import {
  CONNECTIONS_PATH,
  type Actor,
  type Connected,
  type ConnectionService,
  type DiscoveryRecord,
} from './service';

export const NEW_CONNECTION_PATH = `${CONNECTIONS_PATH}/new`;
/** The connect page of a service: where a person connects it. */
export function connectPagePath(providerId: string): string {
  return `${NEW_CONNECTION_PATH}/${encodeURIComponent(providerId)}`;
}
/**
 * Where the connections that have no owner left are listed: the last region
 * of the Accounts page, shown to an administrator (see
 * docs/handbook/web-app.md).
 */
export const OWNERLESS_CONNECTIONS_PAGE = `${CONNECTIONS_PATH}#without-owner`;
/** The HTTP action that names a new owner for a connection that has none (operator). */
export const REASSIGN_ACTION_PATH = '/admin/connections';
export function REASSIGN_PATH(connectionId: string): string {
  return `${REASSIGN_ACTION_PATH}/${encodeURIComponent(connectionId)}/reassign`;
}
export const NOTICE_PARAM = 'notice';
/** Form inputs carrying a `CredentialField` value are named `field.<name>`. */
export const FIELD_PREFIX = 'field.';
/** Form inputs carrying an editable metadata list are named `meta.<key>`. */
export const METADATA_PREFIX = 'meta.';
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
  readonly notices: NoticeStore;
  readonly logger: Logger;
}

export interface ConnectionHandlers {
  connect(request: Request, providerId: string): Promise<Response>;
  callback(request: Request, providerId: string): Promise<Response>;
  discover(request: Request, connectionId: string): Promise<Response>;
  revoke(request: Request, connectionId: string): Promise<Response>;
  transfer(request: Request, connectionId: string): Promise<Response>;
  reassign(request: Request, connectionId: string): Promise<Response>;
  updateResource(request: Request, connectionId: string, resourceId: string): Promise<Response>;
  setDefaultEnv(request: Request, connectionId: string): Promise<Response>;
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
    logger.error('connections: unexpected failure', errorFields(err));
    return {
      tone: 'danger',
      title,
      lines: ['An unexpected error occurred. The log of the gateway has the detail.'],
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

  return {
    async connect(request, providerId) {
      const who = await userOf(request);
      if ('response' in who) return who.response;
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      const reconnectId = stringField(form, 'connection_id') || null;
      const typed = prefixedFields(form, FIELD_PREFIX);
      try {
        const result = await deps.connections.start(who.actor, providerId, {
          displayName: stringField(form, 'name'),
          returnTo: stringField(form, 'return_to') || null,
          reconnectId,
          fields: typed,
        });
        if (result.kind === 'redirect') return redirect(result.url);
        return await redirectWithNotice(
          who.principal,
          result.returnTo ?? connectionPath(result.connection.id),
          connectedNotice(result),
        );
      } catch (err) {
        const unknownProvider = err instanceof ConnectError && err.code === 'provider-unknown';
        // Back to the same form: the account being reconnected and the page to
        // return to afterwards stay in its address.
        const query = new URLSearchParams();
        if (reconnectId) query.set('connection', reconnectId);
        const returnTo = stringField(form, 'return_to');
        if (returnTo) query.set('return_to', returnTo);
        const back = unknownProvider
          ? NEW_CONNECTION_PATH
          : `${NEW_CONNECTION_PATH}/${encodeURIComponent(providerId)}${
              query.size > 0 ? `?${query.toString()}` : ''
            }`;
        // The form comes back as it was typed, the field in error marked: the
        // name and the non-secret values only — a key is never kept.
        const provider = unknownProvider ? null : await deps.connections.provider(providerId);
        const notice = failureNotice(err, 'Not connected');
        return redirectWithNotice(
          who.principal,
          back,
          provider
            ? { ...notice, form: echoOfForm(provider.fields, typed, stringField(form, 'name')) }
            : notice,
        );
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
          failureNotice(err, 'Not refreshed'),
        );
      }
    },

    async revoke(request, connectionId) {
      const who = await userOf(request);
      if ('response' in who) return who.response;
      try {
        const revoked = await deps.connections.revoke(who.actor, connectionId);
        const at = deps.connections.providerGrantOf(revoked);
        const grant = providerGrantReport(at.providerLabel, revoked.providerGrant, at.grant.byHand);
        return await redirectWithNotice(who.principal, connectionPath(revoked.id), {
          // The act succeeded either way; the tone says whether something is left to do.
          tone: grant.actionNeeded ? 'warning' : 'success',
          title: 'Account disconnected',
          lines: [
            'The stored credential was erased. The missions that used this account no longer reach it, for good: one that used other accounts keeps running on them, one that used only this account is stopped. A disconnected account never comes back; a mission for the account that replaces it is a new mission.',
            `${grant.title}. ${grant.text}`,
          ],
        });
      } catch (err) {
        return redirectWithNotice(
          who.principal,
          CONNECTIONS_PATH,
          failureNotice(err, 'Not disconnected'),
        );
      }
    },

    async transfer(request, connectionId) {
      const who = await userOf(request);
      if ('response' in who) return who.response;
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      try {
        const groupId = stringField(form, 'group_id');
        await deps.connections.transfer(who.actor, connectionId, groupId);
        const group = who.actor.groups.find((g) => g.id === groupId);
        return await redirectWithNotice(who.principal, connectionPath(connectionId), {
          tone: 'success',
          title: group ? `Transferred to the ${group.name} team` : 'Transferred',
          lines: [
            'Every member of this team, now and later, is a full owner: they may give access, reconnect, transfer or disconnect.',
            'The accesses already given are unchanged.',
          ],
        });
      } catch (err) {
        const missing = err instanceof ConnectError && err.code === 'not-found';
        return redirectWithNotice(
          who.principal,
          missing ? CONNECTIONS_PATH : connectionPath(connectionId),
          failureNotice(err, 'Not transferred'),
        );
      }
    },

    async reassign(request, connectionId) {
      const guard = await guardMutation(request, deps, 'operator');
      if (!guard.ok) return refusalResponse(guard, OPERATOR_REFUSALS);
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      try {
        const reassigned = await deps.connections.reassign(
          auditActorId(guard.principal),
          connectionId,
          stringField(form, 'owner_kind') === 'group'
            ? { kind: 'group', groupId: stringField(form, 'owner_group') }
            : { kind: 'user', email: stringField(form, 'owner_email') },
        );
        return await redirectWithNotice(guard.principal, OWNERLESS_CONNECTIONS_PAGE, {
          tone: 'success',
          title: `${reassigned.displayName} has a new owner`,
          lines: [
            reassigned.status === 'expired'
              ? 'The account needs reconnecting: its new owner must reconnect it.'
              : 'The account takes an owner’s acts again: its new owner may give access, reconnect, transfer or disconnect it.',
          ],
        });
      } catch (err) {
        return redirectWithNotice(
          guard.principal,
          OWNERLESS_CONNECTIONS_PAGE,
          failureNotice(err, 'No owner named'),
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
          lines: [`${resource.ref} — your edits are kept when the account is refreshed.`],
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

    async setDefaultEnv(request, connectionId) {
      const who = await userOf(request);
      if ('response' in who) return who.response;
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      try {
        const updated = await deps.connections.setDefaultEnv(
          who.actor,
          connectionId,
          form.has('default_env') ? stringField(form, 'default_env') : '',
        );
        return await redirectWithNotice(who.principal, connectionPath(connectionId), {
          tone: 'success',
          title: updated.defaultEnv
            ? `Unlabelled resources are ${updated.defaultEnv}`
            : 'No default environment',
          lines: [
            updated.defaultEnv
              ? `Every resource of this account without a label of its own now carries ${updated.defaultEnv}, including the ones found later. A resource's own label still wins.`
              : 'A resource without a label of its own carries no environment: permissions tied to an environment are refused on it.',
          ],
        });
      } catch (err) {
        const missing = err instanceof ConnectError && err.code === 'not-found';
        return redirectWithNotice(
          who.principal,
          missing ? CONNECTIONS_PATH : connectionPath(connectionId),
          failureNotice(err, 'Default environment not saved'),
        );
      }
    },
  };
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
      lines: [stored, 'Install the public key shown below on the host, then use “Refresh”.'],
    };
  }
  if (!result.discovery.ok) {
    return {
      tone: 'warning',
      title: `${title}, but looking for what it reaches failed`,
      lines: [
        stored,
        result.discovery.error ?? 'The service gave no reason.',
        'Fix the cause, then use “Refresh”.',
      ],
    };
  }
  return {
    tone: 'success',
    title,
    lines: [stored, `${countLabel(result.discovery.count)} found.`],
  };
}

function discoveryNotice(outcome: DiscoveryRecord): Notice {
  return outcome.ok
    ? {
        tone: 'success',
        title: 'Refreshed',
        lines: [
          `${countLabel(outcome.count)} found. Your names, labels and hidden marks are unchanged.`,
        ],
      }
    : {
        tone: 'danger',
        title: 'Refresh failed',
        lines: [
          outcome.error ?? 'The service gave no reason.',
          'What was found before is unchanged.',
        ],
      };
}

function countLabel(count: number): string {
  return count === 1 ? '1 resource' : `${count} resources`;
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
