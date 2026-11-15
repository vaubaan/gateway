/**
 * Host-agnostic HTTP handlers of the Accounts surface
 * (`Request → Response`, never `next`). The Next route handlers under
 * `src/app/**` are one-line adapters over these.
 *
 *   POST /accounts/connect/<service>             start a flow / submit a form
 *   GET  /connections/callback/<service>            the service's redirect back
 *   POST /accounts/<id>/discover                  refresh discovery
 *   POST /accounts/<id>/revoke                    revoke (terminal)
 *   POST /accounts/<id>/transfer                  transfer ownership to a group of the owner
 *   POST /admin/accounts/<id>/reassign            give an ownerless account an owner (operator)
 *   POST /accounts/<id>/resources/<resourceId>    owner edits on a resource
 *   POST /accounts/<id>/default-env               the owner's default environment label
 *                                                    for the unlabelled resources
 *   GET  /reference/<service>/connect/<file>        a screenshot of the connect guide
 *                                                    (signed-in users; read-only)
 *   POST /api/missions/<id>/resources/check          JSON `{ account_id }`: "check now"
 *                                                    on a mission card — discovery of that
 *                                                    account, answered as JSON with what
 *                                                    joined or left the mission
 *
 * Every mutation requires a web session and passes the origin check (spec
 * §6). The callback is a top-level GET from the service: it carries no
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
import { notAFormResponse, readForm, stringField } from '../http/form';
import { resolveReturnTo } from '../http/return-to';
import { errorFields, type Logger } from '../logging';
import type { ConnectFile } from '../plugins';
import { CONNECT_ERROR_MESSAGES, ConnectError } from './errors';
import { echoOfForm } from './input';
import type { Notice, NoticeStore } from './pending';
import { serviceGrantReport } from './service-grant';
import {
  ACCOUNTS_PATH,
  type Actor,
  type Connected,
  type AccountService,
  type DiscoveryRecord,
} from './service';

export const NEW_ACCOUNT_PATH = `${ACCOUNTS_PATH}/new`;
/** The connect page of a service: where a person connects it. */
export function connectPagePath(serviceId: string): string {
  return `${NEW_ACCOUNT_PATH}/${encodeURIComponent(serviceId)}`;
}
/**
 * Where the accounts that have no owner left are listed: the last region
 * of the Accounts page, shown to an administrator (see
 * docs/handbook/web-app.md).
 */
export const OWNERLESS_ACCOUNTS_PAGE = `${ACCOUNTS_PATH}#without-owner`;
/** The HTTP action that names a new owner for an account that has none (operator). */
export const REASSIGN_ACTION_PATH = '/admin/accounts';
export function REASSIGN_PATH(accountId: string): string {
  return `${REASSIGN_ACTION_PATH}/${encodeURIComponent(accountId)}/reassign`;
}
export const NOTICE_PARAM = 'notice';
/** Form inputs carrying a `CredentialField` value are named `field.<name>`. */
export const FIELD_PREFIX = 'field.';
/** The connect form's radio between the `CredentialAlternative`s of a key. */
export const ALTERNATIVE_FIELD = 'alternative';
/** Form inputs carrying an editable metadata list are named `meta.<key>`. */
export const METADATA_PREFIX = 'meta.';
const LOGIN_PAGE = '/login';
const SEE_OTHER = 303;
const USER_REFUSALS: RefusalWording = {
  field: 'reason',
  noSession: 'no session',
  forbidden: 'accounts belong to users; sign in through the IdP',
};

export interface AccountHandlerDeps {
  readonly publicUrl: URL;
  readonly authenticator: Authenticator;
  readonly accounts: AccountService;
  readonly notices: NoticeStore;
  readonly logger: Logger;
  /** A screenshot of a plugin's connect guide, or `null` (`readConnectFile` of `../plugins`). */
  readonly connectFile: (serviceId: string, file: string) => Promise<ConnectFile | null>;
}

export interface AccountHandlers {
  connect(request: Request, serviceId: string): Promise<Response>;
  callback(request: Request, serviceId: string): Promise<Response>;
  discover(request: Request, accountId: string): Promise<Response>;
  revoke(request: Request, accountId: string): Promise<Response>;
  transfer(request: Request, accountId: string): Promise<Response>;
  reassign(request: Request, accountId: string): Promise<Response>;
  updateResource(request: Request, accountId: string, resourceId: string): Promise<Response>;
  setDefaultEnv(request: Request, accountId: string): Promise<Response>;
  /**
   * `POST /api/missions/:id/resources/check` — body `{ account_id }`: runs the
   * discovery of that account of the mission (its creator, or an owner of the
   * account) and answers `MissionResourceCheck` as JSON.
   */
  checkMissionResources(request: Request, missionId: string): Promise<Response>;
  /**
   * `GET /reference/:service/connect/:file` — a screenshot the plugin's connect guide
   * declares, for a signed-in user (the connect page's reader); 401 without a session,
   * 403 for the bootstrap operator, 404 for anything not declared.
   */
  connectFile(request: Request, serviceId: string, file: string): Promise<Response>;
}

const INVALID_CHECK = {
  error: 'invalid-check',
  message: 'The body is { "account_id": string }.',
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

/** The account a "check now" names, or `null` when the body is not one. */
async function checkTargetOf(request: Request): Promise<string | null> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { account_id: accountId, ...extra } = raw as Record<string, unknown>;
  if (Object.keys(extra).length > 0) return null;
  return typeof accountId === 'string' && accountId !== '' ? accountId : null;
}

export function createAccountHandlers(deps: AccountHandlerDeps): AccountHandlers {
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
    const url = new URL(resolveReturnTo(path, deps.publicUrl) ?? ACCOUNTS_PATH, deps.publicUrl);
    url.searchParams.set(NOTICE_PARAM, id);
    return redirect(`${url.pathname}${url.search}${url.hash}`);
  }

  function failureNotice(err: unknown, title: string): Notice {
    if (err instanceof ConnectError) {
      const lines = [CONNECT_ERROR_MESSAGES[err.code]];
      if (err.detail) lines.push(err.detail);
      return { tone: 'danger', title, lines };
    }
    logger.error('accounts: unexpected failure', errorFields(err));
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
    async checkMissionResources(request, missionId) {
      const guard = await guardMutation(request, deps, 'user');
      if (!guard.ok) return refusalResponse(guard, USER_REFUSALS);
      const accountId = await checkTargetOf(request);
      if (accountId === null) return json(400, INVALID_CHECK);
      try {
        const check = await deps.accounts.checkForMission(
          actorOf(guard.principal),
          missionId,
          accountId,
        );
        return json(200, check);
      } catch (err) {
        if (!(err instanceof ConnectError)) {
          logger.error('accounts: unexpected failure', errorFields(err));
          return json(500, {
            error: 'internal',
            message: 'The log of the gateway has the detail.',
          });
        }
        switch (err.code) {
          case 'not-found':
            return json(404, { error: 'not-found', message: 'No such mission or account.' });
          case 'rate-limited':
            return json(
              429,
              { error: 'rate-limited', message: 'Too many checks. Wait a minute and retry.' },
              { 'Retry-After': String(Math.max(1, Math.ceil(err.retryAfterMs / 1000))) },
            );
          default:
            return json(409, { error: err.code, message: CONNECT_ERROR_MESSAGES[err.code] });
        }
      }
    },

    async connect(request, serviceId) {
      const who = await userOf(request);
      if ('response' in who) return who.response;
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      const reconnectId = stringField(form, 'account_id') || null;
      const typed = prefixedFields(form, FIELD_PREFIX);
      try {
        const result = await deps.accounts.start(who.actor, serviceId, {
          displayName: stringField(form, 'name'),
          returnTo: stringField(form, 'return_to') || null,
          reconnectId,
          fields: typed,
          alternative: stringField(form, ALTERNATIVE_FIELD) || null,
        });
        if (result.kind === 'redirect') return redirect(result.url);
        return await redirectWithNotice(
          who.principal,
          result.returnTo ?? accountPath(result.account.id),
          connectedNotice(result),
        );
      } catch (err) {
        const unknownService = err instanceof ConnectError && err.code === 'service-unknown';
        // Back to the same form: the account being reconnected and the page to
        // return to afterwards stay in its address.
        const query = new URLSearchParams();
        if (reconnectId) query.set('account', reconnectId);
        const returnTo = stringField(form, 'return_to');
        if (returnTo) query.set('return_to', returnTo);
        const back = unknownService
          ? NEW_ACCOUNT_PATH
          : `${NEW_ACCOUNT_PATH}/${encodeURIComponent(serviceId)}${
              query.size > 0 ? `?${query.toString()}` : ''
            }`;
        // The form comes back as it was typed, the field in error marked: the
        // name and the non-secret values only — a key is never kept.
        const service = unknownService ? null : await deps.accounts.service(serviceId);
        const notice = failureNotice(err, 'Not connected');
        return redirectWithNotice(
          who.principal,
          back,
          service
            ? {
                ...notice,
                form: echoOfForm(
                  service,
                  typed,
                  stringField(form, 'name'),
                  stringField(form, ALTERNATIVE_FIELD) || null,
                ),
              }
            : notice,
        );
      }
    },

    async connectFile(request, serviceId, file) {
      const guard = await guardSession(request, deps, 'user');
      if (!guard.ok) return refusalResponse(guard, USER_REFUSALS);
      const found = await deps.connectFile(serviceId, file);
      if (!found) return new Response(null, { status: 404 });
      return new Response(new Uint8Array(found.body), {
        headers: {
          'Content-Type': found.contentType,
          'Cache-Control': 'private, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    },

    async callback(request, serviceId) {
      const guard = await guardSession(request, deps, 'user');
      if (!guard.ok) return redirect(LOGIN_PAGE);
      const { principal } = guard;
      try {
        const result = await deps.accounts.complete(
          actorOf(principal),
          serviceId,
          new URL(request.url).searchParams,
        );
        return await redirectWithNotice(
          principal,
          result.returnTo ?? accountPath(result.account.id),
          connectedNotice(result),
        );
      } catch (err) {
        return redirectWithNotice(principal, ACCOUNTS_PATH, failureNotice(err, 'Not connected'));
      }
    },

    async discover(request, accountId) {
      const who = await userOf(request);
      if ('response' in who) return who.response;
      try {
        const outcome = await deps.accounts.discover(who.actor, accountId);
        return await redirectWithNotice(
          who.principal,
          accountPath(accountId),
          discoveryNotice(outcome),
        );
      } catch (err) {
        return redirectWithNotice(
          who.principal,
          ACCOUNTS_PATH,
          failureNotice(err, 'Not refreshed'),
        );
      }
    },

    async revoke(request, accountId) {
      const who = await userOf(request);
      if ('response' in who) return who.response;
      try {
        const revoked = await deps.accounts.revoke(who.actor, accountId);
        const at = deps.accounts.serviceGrantOf(revoked);
        const grant = serviceGrantReport(at.serviceLabel, revoked.serviceGrant, at.grant.byHand);
        return await redirectWithNotice(who.principal, accountPath(revoked.id), {
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
          ACCOUNTS_PATH,
          failureNotice(err, 'Not disconnected'),
        );
      }
    },

    async transfer(request, accountId) {
      const who = await userOf(request);
      if ('response' in who) return who.response;
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      try {
        const groupId = stringField(form, 'group_id');
        await deps.accounts.transfer(who.actor, accountId, groupId);
        const group = who.actor.groups.find((g) => g.id === groupId);
        return await redirectWithNotice(who.principal, accountPath(accountId), {
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
          missing ? ACCOUNTS_PATH : accountPath(accountId),
          failureNotice(err, 'Not transferred'),
        );
      }
    },

    async reassign(request, accountId) {
      const guard = await guardMutation(request, deps, 'operator');
      if (!guard.ok) return refusalResponse(guard, OPERATOR_REFUSALS);
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      try {
        const reassigned = await deps.accounts.reassign(
          auditActorId(guard.principal),
          accountId,
          stringField(form, 'owner_kind') === 'group'
            ? { kind: 'group', groupId: stringField(form, 'owner_group') }
            : { kind: 'user', email: stringField(form, 'owner_email') },
        );
        return await redirectWithNotice(guard.principal, OWNERLESS_ACCOUNTS_PAGE, {
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
          OWNERLESS_ACCOUNTS_PAGE,
          failureNotice(err, 'No owner named'),
        );
      }
    },

    async updateResource(request, accountId, resourceId) {
      const who = await userOf(request);
      if ('response' in who) return who.response;
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      try {
        const resource = await deps.accounts.updateResource(who.actor, accountId, resourceId, {
          ...(form.has('display_name') ? { displayName: stringField(form, 'display_name') } : {}),
          ...(form.has('env') ? { env: stringField(form, 'env') } : {}),
          // A checkbox is absent when unchecked: `hidden_present` marks a form that carries it.
          ...(form.has('hidden_present') ? { hidden: form.get('hidden') === 'on' } : {}),
          metadata: prefixedFields(form, METADATA_PREFIX),
        });
        return await redirectWithNotice(who.principal, accountPath(accountId), {
          tone: 'success',
          title: 'Resource saved',
          lines: [`${resource.ref} — your edits are kept when the account is refreshed.`],
        });
      } catch (err) {
        const missing = err instanceof ConnectError && err.code === 'not-found';
        return redirectWithNotice(
          who.principal,
          missing ? ACCOUNTS_PATH : accountPath(accountId),
          failureNotice(err, 'Resource not saved'),
        );
      }
    },

    async setDefaultEnv(request, accountId) {
      const who = await userOf(request);
      if ('response' in who) return who.response;
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      try {
        const updated = await deps.accounts.setDefaultEnv(
          who.actor,
          accountId,
          form.has('default_env') ? stringField(form, 'default_env') : '',
        );
        return await redirectWithNotice(who.principal, accountPath(accountId), {
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
          missing ? ACCOUNTS_PATH : accountPath(accountId),
          failureNotice(err, 'Default environment not saved'),
        );
      }
    },
  };
}

export function accountPath(accountId: string): string {
  return `${ACCOUNTS_PATH}/${encodeURIComponent(accountId)}`;
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

function prefixedFields(form: FormData, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of form.entries()) {
    if (name.startsWith(prefix) && typeof value === 'string')
      out[name.slice(prefix.length)] = value;
  }
  return out;
}
