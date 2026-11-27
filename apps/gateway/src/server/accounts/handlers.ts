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
 *   POST /accounts/<id>/rename                    the owner's name for the account
 *   GET  /reference/<service>/connect/<file>        a screenshot of the connect guide
 *                                                    (signed-in users; read-only)
 *   POST /api/accounts/refresh                    JSON `{ account_ids }`: a page that
 *                                                    shows these accounts asks to refresh
 *                                                    the stale ones (`AccountRefresher`),
 *                                                    answered `{ refreshed, changed }`
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
import type { RateLimiter } from '../compose/ports';
import type { ConnectFile } from '../plugins';
import { VAUBAAN_SERVICE } from '../vaubaan/acts';
import type { AccountRefresher } from './account-refresh';
import type { InstalledClientBroker } from './installed-broker';
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
/** Where the loopback sends the browser after a connect through Vaubaan's installed client. */
export const LOOPBACK_CONNECT_DONE_PATH = '/connections/loopback/done';
/** What the window of a connect through Vaubaan's installed client polls. */
export const LOOPBACK_CONNECT_STATUS_PATH = '/connections/loopback/status';
/** The page that tells a browser to go back to Vaubaan (the sign-in's, shared). */
const SIGNED_IN_ELSEWHERE_PAGE = '/login/elsewhere';
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
  /** The automatic refresh: a page asks it for the stale accounts it shows. */
  readonly refresher: Pick<AccountRefresher, 'refreshStale'>;
  readonly rateLimiter: RateLimiter;
  /** The ids of the accounts a person may use (owned or shared to them). */
  readonly reachOf: (actor: Actor) => Promise<ReadonlySet<string>>;
  /** A screenshot of a plugin's connect guide, or `null` (`readConnectFile` of `../plugins`). */
  readonly connectFile: (serviceId: string, file: string) => Promise<ConnectFile | null>;
  /** Vaubaan's installed-app clients, in local mode (`installed-broker.ts`); `null` elsewhere. */
  readonly installed?: InstalledClientBroker | null;
  /** Whether the person has created a mission, ever: until then, a new account leads to its starter mission. */
  readonly hasCreatedMission: (actor: Actor) => Promise<boolean>;
}

export interface AccountHandlers {
  /**
   * Starts a flow or submits a form. With the field `respond=json`, a redirect is answered
   * `{ location }` instead: the page sends its window there itself (the desktop app opens
   * a provider's page in the default browser and keeps the window).
   */
  connect(request: Request, serviceId: string): Promise<Response>;
  callback(request: Request, serviceId: string): Promise<Response>;
  /**
   * `GET /oauth/loopback` when its `state` names a connect through Vaubaan's installed
   * client (ADR local-instance-carries-installed-oauth-clients): keeps the provider's
   * answer and sends the browser on to the public URL. `null` when the state is not a
   * connect's (a sign-in's, handled by the auth module).
   */
  loopbackConnect(request: Request): Promise<Response | null>;
  /**
   * `GET /connections/loopback/done?state=`: the person's own browser goes on to the
   * service's callback; any other browser is told to go back to Vaubaan.
   */
  loopbackConnectDone(request: Request): Promise<Response>;
  /**
   * `POST /connections/loopback/status`: the window that started a connect polls it,
   * with the person's session: `pending`, `none`, or `done` with the callback to open.
   */
  loopbackConnectStatus(request: Request): Promise<Response>;
  discover(request: Request, accountId: string): Promise<Response>;
  revoke(request: Request, accountId: string): Promise<Response>;
  transfer(request: Request, accountId: string): Promise<Response>;
  reassign(request: Request, accountId: string): Promise<Response>;
  updateResource(request: Request, accountId: string, resourceId: string): Promise<Response>;
  setDefaultEnv(request: Request, accountId: string): Promise<Response>;
  rename(request: Request, accountId: string): Promise<Response>;
  /**
   * `POST /api/missions/:id/resources/check` — body `{ account_id }`: runs the
   * discovery of that account of the mission (its creator, or an owner of the
   * account) and answers `MissionResourceCheck` as JSON.
   */
  checkMissionResources(request: Request, missionId: string): Promise<Response>;
  /**
   * `POST /api/accounts/refresh` — body `{ account_ids }`: refreshes those the person
   * may use whose last refresh is stale, and answers which were refreshed and which
   * changed (the page then reads again). Others' accounts are silently left out.
   */
  refreshOnOpen(request: Request): Promise<Response>;
  /**
   * `GET /reference/:service/connect/:file` — a screenshot the plugin's connect guide
   * declares, for a signed-in user (the connect page's reader); 401 without a session,
   * 403 for the bootstrap operator, 404 for anything not declared.
   */
  connectFile(request: Request, serviceId: string, file: string): Promise<Response>;
}

/** At most this many accounts in one page's refresh. */
export const MAX_REFRESH_IDS = 100;
/** A person's pages ask at most this many refreshes a minute. */
export const REFRESH_ON_OPEN_RATE_LIMIT = 30;
export const REFRESH_ON_OPEN_RATE_WINDOW_MS = 60_000;

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

const INVALID_REFRESH = {
  error: 'invalid-refresh',
  message: `The body is { "account_ids": string[] } with at most ${MAX_REFRESH_IDS} ids.`,
};

/** The accounts a page asks to refresh, or `null` when the body is not that. */
async function refreshTargetsOf(request: Request): Promise<string[] | null> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { account_ids: ids, ...extra } = raw as Record<string, unknown>;
  if (Object.keys(extra).length > 0 || !Array.isArray(ids) || ids.length > MAX_REFRESH_IDS) {
    return null;
  }
  return ids.every((id): id is string => typeof id === 'string' && id !== '') ? ids : null;
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

  /**
   * Where a connection lands (spec §7.2): the page it was asked to return to; else,
   * for someone who created no mission yet, the creation form filled in for the new
   * account (its starter mission, spec §7.4); else the account's page. A reconnection,
   * a Vaubaan account (its page offers the platform management mission) and an
   * account whose resources could not be read yet land on the account's page.
   */
  async function landingOf(actor: Actor, result: Connected): Promise<string> {
    if (result.returnTo) return result.returnTo;
    const own = accountPath(result.account.id);
    if (result.reconnected || !result.discovery?.ok) return own;
    if (result.account.service === VAUBAAN_SERVICE) return own;
    if (await deps.hasCreatedMission(actor)) return own;
    return starterMissionPath(result.account.id);
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
    async refreshOnOpen(request) {
      const guard = await guardMutation(request, deps, 'user');
      if (!guard.ok) return refusalResponse(guard, USER_REFUSALS);
      const ids = await refreshTargetsOf(request);
      if (ids === null) return json(400, INVALID_REFRESH);
      const actor = actorOf(guard.principal);
      const decision = await deps.rateLimiter.take(
        `refresh-on-open:${actor.user.id}`,
        REFRESH_ON_OPEN_RATE_LIMIT,
        REFRESH_ON_OPEN_RATE_WINDOW_MS,
      );
      if (!decision.allowed) {
        // Not an error a page shows: it keeps what it rendered.
        return json(200, { refreshed: [], changed: [] });
      }
      const reach = await deps.reachOf(actor);
      const outcome = await deps.refresher.refreshStale(ids.filter((id) => reach.has(id)));
      return json(200, outcome);
    },

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
      const asJson = stringField(form, 'respond') === 'json';
      const answer = async (response: Promise<Response>): Promise<Response> => {
        const res = await response;
        return asJson ? json(200, { location: res.headers.get('Location') ?? ACCOUNTS_PATH }) : res;
      };
      try {
        const result = await deps.accounts.start(who.actor, serviceId, {
          displayName: stringField(form, 'name'),
          returnTo: stringField(form, 'return_to') || null,
          reconnectId,
          fields: typed,
          alternative: stringField(form, ALTERNATIVE_FIELD) || null,
        });
        if (result.kind === 'redirect') {
          return asJson ? json(200, { location: result.url }) : redirect(result.url);
        }
        return await answer(
          redirectWithNotice(
            who.principal,
            await landingOf(who.actor, result),
            connectedNotice(result),
          ),
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
        return answer(
          redirectWithNotice(
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
          ),
        );
      }
    },

    async loopbackConnect(request) {
      if (!deps.installed) return null;
      const query = new URL(request.url).searchParams;
      if (!(await deps.installed.owns(query.get('state')))) return null;
      const outcome = await deps.installed.callback(query);
      const done = new URL(LOOPBACK_CONNECT_DONE_PATH, deps.publicUrl);
      if (outcome.kind === 'back') done.searchParams.set('state', outcome.state);
      // On to the public URL, where the person's session is.
      return redirect(done.href);
    },

    async loopbackConnectDone(request) {
      const state = new URL(request.url).searchParams.get('state') ?? '';
      const guard = await guardSession(request, deps, 'user');
      if (guard.ok && deps.installed) {
        const callback = await deps.installed.callbackUrlOf(state, guard.principal.user.id);
        if (callback) return redirect(callback);
      }
      // The desktop app's default browser: the app's window finishes the connection.
      return redirect(`${SIGNED_IN_ELSEWHERE_PAGE}?outcome=${state ? 'done' : 'expired'}`);
    },

    async loopbackConnectStatus(request) {
      const who = await userOf(request);
      if ('response' in who) return who.response;
      if (!deps.installed) return json(200, { status: 'none' });
      return json(200, await deps.installed.statusOf(who.actor.user.id));
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
        const actor = actorOf(principal);
        const result = await deps.accounts.complete(
          actor,
          serviceId,
          new URL(request.url).searchParams,
        );
        return await redirectWithNotice(
          principal,
          await landingOf(actor, result),
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

    async rename(request, accountId) {
      const who = await userOf(request);
      if ('response' in who) return who.response;
      const form = await readForm(request);
      if (!form) return notAFormResponse();
      try {
        const updated = await deps.accounts.rename(
          who.actor,
          accountId,
          stringField(form, 'display_name'),
        );
        return await redirectWithNotice(who.principal, accountPath(accountId), {
          tone: 'success',
          title: 'Account renamed',
          lines: [`It now reads ${updated.displayName} everywhere, in the missions too.`],
        });
      } catch (err) {
        const missing = err instanceof ConnectError && err.code === 'not-found';
        return redirectWithNotice(
          who.principal,
          missing ? ACCOUNTS_PATH : accountPath(accountId),
          failureNotice(err, 'Account not renamed'),
        );
      }
    },
  };
}

/** The creation form filled in for one account: its starter mission (spec §7.4). */
export function starterMissionPath(accountId: string): string {
  return `/missions/new?account=${encodeURIComponent(accountId)}`;
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
