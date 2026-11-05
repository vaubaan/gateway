/**
 * Upstream calls of the `axonaut` provider, and the discovery of its account.
 *
 * Spec : docs/spec/vaubaan-gateway.md §2.4 — the credential arrives decrypted
 *        in the context, is used for one call, and is never returned.
 * Handbook : docs/handbook/providers/axonaut.md §6.
 *
 *   - every request goes through the SDK's `httpJson` (bounded answer, no
 *     redirect, failures thrown typed: 401 / 403 `UpstreamAuthError`, another
 *     status `UpstreamHttpError`, an answer the guard refuses
 *     `UpstreamProtocolError`);
 *   - the key travels in the `userApiKey` header, the scheme Axonaut's
 *     OpenAPI file declares; `page` travels as a header too, where the file
 *     declares it;
 *   - the request is the one `readCall` built, the reader `classify` used:
 *     what is executed is what was classified. What it refuses is declined
 *     with `refusalResult`, before any request;
 *   - `GET /me` answers the API key itself (`user_api_key`): `readMe` keeps
 *     only the fields it names and nothing else of that answer is ever
 *     returned, logged or stored. No tool calls `/me`.
 */

import {
  CredentialRefusal,
  UpstreamProtocolError,
  anyJson,
  expectCredentialKind,
  httpJson,
  isList,
  isRecord,
  jsonResult,
  refusalResult,
  type ConnectionContext,
  type ExecuteContext,
  type Guard,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { readCall, type Method } from './call.ts';
import { axonautId } from './fields.ts';
import { API_KEY_FIELD, PROVIDER_ID } from './identity.ts';

/** Public API of the provider — a fact about Axonaut, not instance configuration. */
export const AXONAUT_API_BASE = 'https://axonaut.com/api/v2';

/** The header Axonaut reads the key from (`securitySchemes.userApiKey`, `in: header`). */
export const API_KEY_HEADER = 'userApiKey';

export async function executeAxonaut(
  ctx: ExecuteContext,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<McpToolResult> {
  const call = readCall(tool, args, ctx.resources);
  // Declined here, before any request : a result the agent reads, not an upstream failure.
  if ('denied' in call) return refusalResult(call.denied);
  const { request: r } = call;
  const answer = await request(ctx, r.method, r.path, anyJson, {
    ...(r.query ? { query: r.query } : {}),
    ...(r.page !== undefined ? { page: r.page } : {}),
    ...(r.body !== undefined ? { body: r.body } : {}),
  });
  // A deletion answers without content (202 or an empty 200): say what was done.
  return jsonResult(answer === null && r.confirmation ? r.confirmation : answer);
}

// ─── `/me` : the user and the account the key opens ──────────────────────

/** What this plugin reads of `GET /me`, and nothing else: never the key it also answers. */
export interface AxonautMe {
  readonly fullname: string | null;
  readonly email: string | null;
  readonly account: { readonly id: string; readonly companyName: string } | null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The answer of `/me` is a JSON object; the projection below copies the named
 * fields out of it. The first entry of `account` is the account the key opens
 * (an Axonaut user belongs to one company account).
 */
const isMeAnswer: Guard<Record<string, unknown>> = isRecord;

function projectMe(answer: Record<string, unknown>): AxonautMe {
  const accounts = isList(answer.account) ? answer.account : [];
  const first = accounts[0];
  let account: AxonautMe['account'] = null;
  if (isRecord(first)) {
    const accountId =
      typeof first.id === 'number' || typeof first.id === 'string' ? first.id : null;
    account = {
      id: accountId === null ? '' : String(accountId),
      companyName: stringOrNull(first.company_name) ?? '',
    };
  }
  return { fullname: stringOrNull(answer.fullname), email: stringOrNull(answer.email), account };
}

/** `GET /me`, projected: the user's name and e-mail address and the account, never the key. */
export async function readMe(ctx: ConnectionContext): Promise<AxonautMe> {
  return projectMe(await request(ctx, 'GET', '/me', isMeAnswer));
}

/** The one resource of a connection: the Axonaut account the key opens. */
export async function discoverAxonautResources(
  ctx: ConnectionContext,
): Promise<readonly Resource[]> {
  const me = await readMe(ctx);
  if (me.account === null) {
    throw new CredentialRefusal('This Axonaut key opens no company account.');
  }
  // A ref the classifier would refuse is of no use to a mission: say so now.
  const ref = axonautId(me.account.id);
  if (ref === null) {
    throw new UpstreamProtocolError(`${PROVIDER_ID} GET /me: the account id is not an Axonaut id`);
  }
  const companyName = me.account.companyName || `Axonaut account ${ref}`;
  return [
    {
      provider: PROVIDER_ID,
      ref,
      displayName: companyName,
      metadata: {
        account_id: ref,
        company_name: companyName,
        ...(me.email ? { user_email: me.email } : {}),
      },
    },
  ];
}

// ─── The transport ───────────────────────────────────────────────────────

export interface RequestOptions {
  readonly query?: URLSearchParams;
  readonly page?: number;
  readonly body?: unknown;
}

function keyOf(ctx: ConnectionContext): string {
  const secret = expectCredentialKind(PROVIDER_ID, ctx.credential, 'api-key');
  const key = secret.fields[API_KEY_FIELD];
  if (!key) throw new Error(`${PROVIDER_ID}: the credential has no '${API_KEY_FIELD}' field`);
  return key;
}

/** One call to Axonaut with the connection's key, its answer read through `guard`. */
export async function request<T>(
  ctx: ConnectionContext,
  method: Method,
  path: string,
  guard: Guard<T>,
  options: RequestOptions = {},
): Promise<T> {
  const query = options.query ? `?${options.query.toString()}` : '';
  return httpJson(
    ctx,
    {
      url: `${AXONAUT_API_BASE}${path}${query}`,
      method,
      headers: {
        [API_KEY_HEADER]: keyOf(ctx),
        ...(options.page !== undefined ? { page: String(options.page) } : {}),
      },
      ...(options.body !== undefined ? { body: options.body } : {}),
      what: `${PROVIDER_ID} ${method} ${path}`,
    },
    guard,
  );
}
