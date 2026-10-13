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
 *     GET ; the `account` argument is consumed here and never forwarded.
 */

import {
  UpstreamAuthError,
  expectCredentialKind,
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
  resolveStripeResource,
  stripeResourceRef,
  type StripeMode,
} from './resources.ts';
import { availableTools } from './tools.ts';

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
}

const byId = (prefix: string, suffix = '') => ({
  path: (a: Args) => `/${prefix}/${encodeURIComponent(String(a.id))}${suffix}`,
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
  stripe__create_invoice: { method: 'POST', path: () => '/invoices' },
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

// ─── v5 entry points ──────────────────────────────────────────────────────────

export async function executeStripe(
  ctx: ExecuteContext,
  tool: string,
  args: Args,
): Promise<McpToolResult> {
  const route = ROUTES[tool];
  if (!route) return { content: [{ type: 'text', text: `unknown tool '${tool}'` }], isError: true };

  const target = resolveStripeResource(args, ctx.resources);
  if ('denied' in target) throw new Error(`stripe: ${target.denied}`);
  const mode = modeOf(target.resource);
  if (!mode) {
    throw new Error(`stripe: cannot determine the test/live mode of '${target.resource.ref}'`);
  }
  const key = keyFor(ctx, mode);

  const { account: _account, ...forwarded } = args;
  const payload = await callStripeApi(
    ctx.fetch,
    key,
    route.method,
    route.path(forwarded),
    forwardedArgs(route, forwarded),
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
    const account = (await callStripeApi(
      ctx.fetch,
      key,
      'GET',
      '/account',
      {},
      ctx.signal,
    )) as AccountDto;
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

function keyFor(ctx: ConnectionContext, mode: StripeMode): string {
  const secret = expectCredentialKind(STRIPE_PROVIDER, ctx.credential, 'api-key');
  const key = secret.fields[KEY_FIELD_BY_MODE[mode]];
  if (!key) throw new Error(`stripe: this connection has no ${mode}-mode key`);
  return key;
}

function forwardedArgs(route: Route, args: Args): Args {
  if (route.forward === false) return {};
  if (!route.consumes) return args;
  const rest: Record<string, unknown> = { ...args };
  for (const key of route.consumes) delete rest[key];
  return rest;
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
    throw new Error(message);
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ─── Legacy v4 entry point ───────────────────────────────────────────────────

/** @deprecated legacy v4, deleted in P1.6 — use `executeStripe(ctx, tool, args)`. */
export type FetchImpl = typeof fetch;

const V4_TOOL_NAMES: ReadonlySet<string> = new Set(availableTools.map((t) => t.name));

/**
 * The v4 dispatcher : one raw API key, no resource. Kept for
 * `apps/gateway/src/lib/gateway/build.ts` until P1.6.
 *
 * @deprecated legacy v4, deleted in P1.6 — use `executeStripe(ctx, tool, args)`.
 */
export async function executeCall(
  fetchImpl: FetchImpl,
  token: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const route = V4_TOOL_NAMES.has(tool) ? ROUTES[tool] : undefined;
  if (!route) throw new Error(`Stripe tool not implemented: ${tool}`);
  return callStripeApi(
    fetchImpl,
    token,
    route.method,
    route.path(args),
    forwardedArgs(route, args),
  );
}
