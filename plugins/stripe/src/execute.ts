/**
 * Upstream calls of the `stripe` provider — Stripe REST API v1.
 *
 * Spec : docs/spec/vaubaan-gateway.md §2.4 — the credential arrives decrypted
 *        in the context, is used for one call, and never reaches the agent.
 *
 * Rules :
 *   - `fetch` comes from the context, never from the global ;
 *   - the key is chosen by the **mode of the resource the call targets**
 *     (`test_key` / `live_key`), never by an argument ;
 *   - 401 / 403 from Stripe → `UpstreamAuthError` ;
 *   - Stripe takes `application/x-www-form-urlencoded` bodies with bracket
 *     notation for nested keys (`items[0][price]=…`), and query parameters on
 *     GET ; the `account` argument is consumed here and never forwarded ;
 *   - the resource is resolved by the classifier's own `resolveStripeResource`
 *     and every identifier argument is read by its `readIdArgs` / `stripeId` :
 *     the id in the path and the ids in the query or the body are the ones
 *     the slices named, or the call is not made ;
 *   - only the arguments the tool's schema declares are forwarded
 *     (`declaredArgsOf`) : the classifier judged those and no other, so a
 *     Stripe parameter nobody classified (`expand`, `collection_method`…)
 *     never reaches the API, even if a caller skipped the classifier.
 */

import {
  ExecutorRefusal,
  UpstreamAuthError,
  UpstreamHttpError,
  declining,
  expectCredentialKind,
  refusalResult,
  type ConnectionContext,
  type ExecuteContext,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import {
  KEY_FIELD_BY_MODE,
  STRIPE_MODES,
  STRIPE_PROVIDER,
  keyMatchesMode,
  modeOf,
  readIdArgs,
  resolveStripeResource,
  stripeId,
  stripeResourceRef,
  type StripeMode,
} from './resources.ts';
import { declaredArgsOf } from './tools.ts';

/** Public API of the provider — a fact about Stripe, not instance configuration. */
export const STRIPE_API_BASE = 'https://api.stripe.com/v1';

type HttpMethod = 'GET' | 'POST' | 'DELETE';
type Args = Readonly<Record<string, unknown>>;

interface Route {
  readonly method: HttpMethod;
  /** Path under `/v1`, built from the arguments it consumes. */
  readonly path: (args: Args) => string;
  /** Arguments consumed by the path, removed from the forwarded set. */
  readonly consumes?: readonly string[];
  /** When false, no argument is forwarded (singleton endpoints, verbs). */
  readonly forward?: boolean;
  /** Values sent when the call does not carry the argument : the safe side, stated to Stripe. */
  readonly defaults?: Args;
}

/**
 * The object id a path is built from, read by the classifier's own `stripeId` :
 * one path segment of unreserved characters, interpolated as it is. A call
 * without one never reaches a collection endpoint.
 */
function pathId(args: Args): string {
  const id = stripeId(args.id);
  if (id === null) throw new ExecutorRefusal('stripe: id: missing or malformed');
  return id;
}

const byId = (prefix: string, suffix = '') => ({
  path: (a: Args) => `/${prefix}/${pathId(a)}${suffix}`,
  consumes: ['id'],
});

/** Tool → Stripe endpoint. Every declared tool has a row ; the classifier enforces the inverse. */
const ROUTES: Readonly<Record<string, Route>> = {
  // reads
  stripe__list_products: { method: 'GET', path: () => '/products' },
  stripe__list_prices: { method: 'GET', path: () => '/prices' },
  stripe__list_customers: { method: 'GET', path: () => '/customers' },
  stripe__retrieve_customer: { method: 'GET', ...byId('customers') },
  stripe__list_subscriptions: { method: 'GET', path: () => '/subscriptions' },
  stripe__list_invoices: { method: 'GET', path: () => '/invoices' },
  stripe__list_charges: { method: 'GET', path: () => '/charges' },
  stripe__list_payment_intents: { method: 'GET', path: () => '/payment_intents' },
  stripe__get_balance: { method: 'GET', path: () => '/balance', forward: false },
  stripe__list_events: { method: 'GET', path: () => '/events' },
  // writes — catalog
  stripe__create_product: { method: 'POST', path: () => '/products' },
  stripe__update_product: { method: 'POST', ...byId('products') },
  stripe__create_price: { method: 'POST', path: () => '/prices' },
  stripe__update_price: { method: 'POST', ...byId('prices') },
  stripe__create_coupon: { method: 'POST', path: () => '/coupons' },
  stripe__create_promotion_code: { method: 'POST', path: () => '/promotion_codes' },
  // writes — subscriptions
  stripe__create_subscription: { method: 'POST', path: () => '/subscriptions' },
  stripe__update_subscription: { method: 'POST', ...byId('subscriptions') },
  stripe__cancel_subscription: { method: 'DELETE', ...byId('subscriptions') },
  stripe__pause_subscription: { method: 'POST', ...byId('subscriptions') },
  // writes — invoices
  // A draft is a draft whatever the account's API version defaults to.
  stripe__create_invoice: {
    method: 'POST',
    path: () => '/invoices',
    defaults: { auto_advance: false },
  },
  stripe__finalize_invoice: { method: 'POST', ...byId('invoices', '/finalize') },
  stripe__void_invoice: { method: 'POST', ...byId('invoices', '/void'), forward: false },
  // writes — money out
  stripe__create_refund: { method: 'POST', path: () => '/refunds' },
  stripe__create_payout: { method: 'POST', path: () => '/payouts' },
  // writes — customers
  stripe__delete_customer: { method: 'DELETE', ...byId('customers'), forward: false },
  // writes — webhooks
  stripe__create_webhook_endpoint: { method: 'POST', path: () => '/webhook_endpoints' },
};

// ─── Entry points ─────────────────────────────────────────────────────────────

/**
 * What this executor declines itself — an account outside the mission, a malformed
 * identifier, a mode the connection holds no key for — is an `ExecutorRefusal`,
 * returned as an `isError` result : no request left, nothing failed at Stripe.
 */
export function executeStripe(
  ctx: ExecuteContext,
  tool: string,
  args: Args,
): Promise<McpToolResult> {
  return declining(() => executeDeclared(ctx, tool, args));
}

async function executeDeclared(
  ctx: ExecuteContext,
  tool: string,
  args: Args,
): Promise<McpToolResult> {
  const route = Object.hasOwn(ROUTES, tool) ? ROUTES[tool] : undefined;
  if (!route) return refusalResult(`unknown tool '${tool}'`);

  const target = resolveStripeResource(args, ctx.resources);
  if ('denied' in target) throw new ExecutorRefusal(`stripe: ${target.denied}`);
  const mode = modeOf(target.resource);
  if (!mode) {
    throw new ExecutorRefusal(
      `stripe: cannot determine the test/live mode of '${target.resource.ref}'`,
    );
  }
  const key = keyFor(ctx, mode);

  const path = route.path(args);
  // Every identifier argument is read the way the classifier read it : one
  // that it would have refused is not sent in a query string or a body either.
  const ids = readIdArgs(args);
  if ('denied' in ids) throw new ExecutorRefusal(`stripe: ${ids.denied}`);

  const payload = await callStripeApi(
    ctx.fetch,
    key,
    route.method,
    path,
    forwardedArgs(tool, route, args),
    ctx.signal,
  );
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

interface AccountDto {
  readonly id: string;
  readonly business_profile?: { readonly name?: string | null } | null;
  readonly settings?: { readonly dashboard?: { readonly display_name?: string | null } } | null;
}

/**
 * One resource per mode the credential carries a key for : `GET /v1/account`
 * with each key, `ref` = `<account id>/<mode>`, `env` = the mode. A key whose
 * prefix contradicts its field (`sk_live_…` pasted as the test key) is
 * refused before any call.
 */
export async function discoverStripeResources(
  ctx: ConnectionContext,
): Promise<readonly Resource[]> {
  const secret = expectCredentialKind(STRIPE_PROVIDER, ctx.credential, 'api-key');
  const resources: Resource[] = [];
  for (const mode of STRIPE_MODES) {
    const field = KEY_FIELD_BY_MODE[mode];
    const key = secret.fields[field];
    if (!key) continue;
    if (!keyMatchesMode(key, mode)) {
      throw new Error(`stripe: ${field} must be a ${mode}-mode key (sk_${mode}_… or rk_${mode}_…)`);
    }
    const account = await callStripeApi(ctx.fetch, key, 'GET', '/account', {}, ctx.signal);
    if (!isAccountDto(account)) {
      throw new Error(`stripe: GET /account with the ${mode}-mode key returned no account id`);
    }
    const label =
      account.settings?.dashboard?.display_name ?? account.business_profile?.name ?? account.id;
    resources.push({
      provider: STRIPE_PROVIDER,
      ref: stripeResourceRef(account.id, mode),
      env: mode,
      displayName: `${label} (${mode})`,
      metadata: { account_id: account.id, mode },
    });
  }
  if (resources.length === 0) {
    throw new Error('stripe: the credential carries neither a test key nor a live key');
  }
  return resources;
}

function isAccountDto(value: unknown): value is AccountDto {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    value.id !== ''
  );
}

function keyFor(ctx: ConnectionContext, mode: StripeMode): string {
  const secret = expectCredentialKind(STRIPE_PROVIDER, ctx.credential, 'api-key');
  const key = secret.fields[KEY_FIELD_BY_MODE[mode]];
  if (!key) throw new ExecutorRefusal(`stripe: this connection has no ${mode}-mode key`);
  return key;
}

/** Arguments the gateway consumes itself, whatever the tool. */
const NEVER_FORWARDED: ReadonlySet<string> = new Set(['account']);

/**
 * What goes to Stripe : the arguments the tool declares, minus the ones the
 * gateway or the path consumed, over the route's defaults. Anything else the
 * call carried is dropped — it was never classified.
 */
function forwardedArgs(tool: string, route: Route, args: Args): Args {
  if (route.forward === false) return {};
  const consumed = new Set(route.consumes ?? []);
  const forwarded: Record<string, unknown> = { ...route.defaults };
  for (const key of declaredArgsOf(tool) ?? []) {
    if (NEVER_FORWARDED.has(key) || consumed.has(key)) continue;
    const value = args[key];
    if (value !== undefined && value !== null) forwarded[key] = value;
  }
  return forwarded;
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

/**
 * Flatten a nested object into form-urlencoded pairs with Stripe's bracket
 * notation : `{ items: [{ price: 'p' }] }` → `items[0][price]=p`.
 */
function toFormBody(obj: Args): string {
  const parts: string[] = [];
  const encode = (prefix: string, value: unknown): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => encode(`${prefix}[${i}]`, v));
    } else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        encode(`${prefix}[${k}]`, v);
      }
    } else {
      parts.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
    }
  };
  for (const [key, value] of Object.entries(obj)) encode(key, value);
  return parts.join('&');
}

function toQueryString(args: Args): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === null || value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

async function callStripeApi(
  fetchImpl: typeof fetch,
  key: string,
  method: HttpMethod,
  path: string,
  args: Args,
  signal?: AbortSignal,
): Promise<unknown> {
  let url = `${STRIPE_API_BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
  };
  const init: RequestInit = { method, headers, ...(signal ? { signal } : {}) };
  if (method === 'GET') {
    url += toQueryString(args);
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const body = toFormBody(args);
    if (body) init.body = body;
  }

  const res = await fetchImpl(url, init);
  const text = await res.text();
  if (!res.ok) {
    const message = `Stripe API ${method} ${path} ${res.status}: ${text.slice(0, 500)}`;
    if (res.status === 401 || res.status === 403) throw new UpstreamAuthError(message, res.status);
    throw new UpstreamHttpError(message, res.status);
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
