/**
 * Upstream calls of the `stripe` service — Stripe REST API v1.
 *
 * Spec : docs/spec/vaubaan-gateway.md §2.4 — the credential arrives decrypted
 *        in the context, is used for one call, and never reaches the agent.
 *
 * Rules :
 *   - `fetch` comes from the context, never from the global ;
 *   - the key is chosen by the **mode of the resource the call targets**
 *     (`test_key` / `live_key`), never by an argument ;
 *   - every request goes through the SDK's `httpJson` : 401 / 403 from
 *     Stripe → `UpstreamAuthError`, another failed status →
 *     `UpstreamHttpError`, an answer that is not JSON (Stripe always
 *     answers JSON) → `UpstreamProtocolError` ;
 *   - Stripe takes `application/x-www-form-urlencoded` bodies with bracket
 *     notation for nested keys (`items[0][price]=…`), and query parameters on
 *     GET ; the `account` argument is consumed here and never forwarded ;
 *   - the resource is resolved by the classifier's own `resolveStripeResource`
 *     and every identifier argument is read by its `readIdArgs` / `stripeId` :
 *     the id in the path and the ids in the query or the body are the ones
 *     the slices named, or the call is not made ;
 *   - a call carrying an argument the tool's schema does not declare is
 *     declined with the classifier's own sentence (`undeclaredStripeArgument`) :
 *     the classifier judged the declared ones and no other, so a Stripe
 *     parameter nobody classified (`expand`, `collection_method`…) never
 *     reaches the API, even if a caller skipped the classifier.
 */

import {
  type AccountContext,
  anyJson,
  CredentialRefusal,
  declining,
  type ExecuteContext,
  ExecutorRefusal,
  expectCredentialKind,
  type Guard,
  httpJson,
  isRecord,
  jsonResult,
  type McpToolResult,
  queryString,
  refusalResult,
  type Resource,
  UpstreamAuthError,
  type UpstreamIo,
} from '@vaubaan/plugin-sdk';

import { DECLARED_ARGUMENTS, undeclaredStripeArgument } from './classify.ts';
import { SERVICE_ID, STRIPE_API_BASE, TOOL } from './identity.ts';
import {
  KEY_FIELD_BY_MODE,
  STRIPE_MODES,
  keyMatchesMode,
  modeOf,
  readIdArgs,
  resolveStripeResource,
  stripeId,
  stripeResourceRef,
  type StripeMode,
} from './resources.ts';

const HTTP_FORBIDDEN = 403;

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
  [TOOL.listProducts]: { method: 'GET', path: () => '/products' },
  [TOOL.listPrices]: { method: 'GET', path: () => '/prices' },
  [TOOL.listCustomers]: { method: 'GET', path: () => '/customers' },
  [TOOL.retrieveCustomer]: { method: 'GET', ...byId('customers') },
  [TOOL.listSubscriptions]: { method: 'GET', path: () => '/subscriptions' },
  [TOOL.listInvoices]: { method: 'GET', path: () => '/invoices' },
  [TOOL.listCharges]: { method: 'GET', path: () => '/charges' },
  [TOOL.listPaymentIntents]: { method: 'GET', path: () => '/payment_intents' },
  [TOOL.getBalance]: { method: 'GET', path: () => '/balance', forward: false },
  [TOOL.listEvents]: { method: 'GET', path: () => '/events' },
  // writes — catalog
  [TOOL.createProduct]: { method: 'POST', path: () => '/products' },
  [TOOL.updateProduct]: { method: 'POST', ...byId('products') },
  [TOOL.createPrice]: { method: 'POST', path: () => '/prices' },
  [TOOL.updatePrice]: { method: 'POST', ...byId('prices') },
  [TOOL.createCoupon]: { method: 'POST', path: () => '/coupons' },
  [TOOL.createPromotionCode]: { method: 'POST', path: () => '/promotion_codes' },
  // writes — subscriptions
  [TOOL.createSubscription]: { method: 'POST', path: () => '/subscriptions' },
  [TOOL.updateSubscription]: { method: 'POST', ...byId('subscriptions') },
  [TOOL.cancelSubscription]: { method: 'DELETE', ...byId('subscriptions') },
  [TOOL.pauseSubscription]: { method: 'POST', ...byId('subscriptions') },
  // writes — invoices
  // A draft is a draft whatever the account's API version defaults to.
  [TOOL.createInvoice]: {
    method: 'POST',
    path: () => '/invoices',
    defaults: { auto_advance: false },
  },
  [TOOL.finalizeInvoice]: { method: 'POST', ...byId('invoices', '/finalize') },
  [TOOL.voidInvoice]: { method: 'POST', ...byId('invoices', '/void'), forward: false },
  // writes — money out
  [TOOL.createRefund]: { method: 'POST', path: () => '/refunds' },
  [TOOL.createPayout]: { method: 'POST', path: () => '/payouts' },
  // writes — customers
  [TOOL.deleteCustomer]: { method: 'DELETE', ...byId('customers'), forward: false },
  // writes — webhooks
  [TOOL.createWebhookEndpoint]: { method: 'POST', path: () => '/webhook_endpoints' },
};

// ─── Entry points ─────────────────────────────────────────────────────────────

/**
 * What this executor declines itself — an undeclared argument, an account outside
 * the mission, a malformed identifier, a mode the account holds no key for —
 * is an `ExecutorRefusal`,
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
  const undeclared = undeclaredStripeArgument(tool, args);
  if (undeclared !== null) throw new ExecutorRefusal(undeclared);

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
    ctx,
    key,
    route.method,
    path,
    forwardedArgs(tool, route, args),
    anyJson,
  );
  // An empty answer (Stripe sends none in practice) reads as `{}`, as it always has.
  return jsonResult(payload ?? {});
}

interface AccountDto {
  readonly id: string;
  readonly business_profile?: { readonly name?: string | null } | null;
  readonly settings?: { readonly dashboard?: { readonly display_name?: string | null } } | null;
}

/** The Stripe account one key of the account opens. */
export interface StripeAccount {
  readonly mode: StripeMode;
  readonly id: string;
  /** The Dashboard display name, else the business name, else the account id. */
  readonly label: string;
}

/**
 * The account behind each key the credential carries : `GET /v1/account`
 * with each key. A key whose prefix contradicts its field (`sk_live_…` pasted
 * as the test key) is refused before any call ; a key Stripe will not let
 * describe its account (a restricted key) is refused with the fix.
 */
export async function stripeAccounts(ctx: AccountContext): Promise<readonly StripeAccount[]> {
  const secret = expectCredentialKind(SERVICE_ID, ctx.credential, 'api-key');
  const accounts: StripeAccount[] = [];
  for (const mode of STRIPE_MODES) {
    const field = KEY_FIELD_BY_MODE[mode];
    const key = secret.fields[field];
    if (!key) continue;
    if (!keyMatchesMode(key, mode)) {
      throw new CredentialRefusal(
        `stripe: the ${mode}-mode key must start with sk_${mode}_ (or rk_${mode}_).`,
      );
    }
    const account = await readAccount(ctx, key, mode);
    const label =
      account.settings?.dashboard?.display_name ?? account.business_profile?.name ?? account.id;
    accounts.push({ mode, id: account.id, label });
  }
  if (accounts.length === 0) {
    throw new CredentialRefusal('stripe: paste a test-mode key, a live-mode key, or both.');
  }
  return accounts;
}

async function readAccount(
  ctx: AccountContext,
  key: string,
  mode: StripeMode,
): Promise<AccountDto> {
  try {
    return await callStripeApi(ctx, key, 'GET', '/account', {}, isAccountDto, {
      what: `${SERVICE_ID}: GET /account with the ${mode}-mode key`,
    });
  } catch (err) {
    // 403 : the key is valid but lacks a permission — a restricted key.
    if (err instanceof UpstreamAuthError && err.upstreamStatus === HTTP_FORBIDDEN) {
      throw new CredentialRefusal(
        `stripe: the ${mode}-mode key may not read its own account: paste the secret key (sk_${mode}_…) instead of a restricted key.`,
        HTTP_FORBIDDEN,
      );
    }
    throw err;
  }
}

/**
 * One resource per mode the credential carries a key for (`stripeAccounts`) :
 * `ref` = `<account id>/<mode>`, `env` = the mode.
 */
export async function discoverStripeResources(ctx: AccountContext): Promise<readonly Resource[]> {
  return (await stripeAccounts(ctx)).map(({ mode, id, label }) => ({
    service: SERVICE_ID,
    ref: stripeResourceRef(id, mode),
    env: mode,
    displayName: `${label} (${mode})`,
    metadata: { account_id: id, mode },
  }));
}

/**
 * An account with an id : the one field read unconditionally. The names under
 * it are read with optional chaining, each falling back to the next.
 */
function isAccountDto(value: unknown): value is AccountDto {
  return isRecord(value) && typeof value.id === 'string' && value.id !== '';
}

function keyFor(ctx: AccountContext, mode: StripeMode): string {
  const secret = expectCredentialKind(SERVICE_ID, ctx.credential, 'api-key');
  const key = secret.fields[KEY_FIELD_BY_MODE[mode]];
  if (!key) throw new ExecutorRefusal(`stripe: this account has no ${mode}-mode key`);
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
  for (const key of DECLARED_ARGUMENTS.get(tool) ?? []) {
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
    } else if (isRecord(value)) {
      for (const [k, v] of Object.entries(value)) {
        encode(`${prefix}[${k}]`, v);
      }
    } else {
      parts.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
    }
  };
  for (const [key, value] of Object.entries(obj)) encode(key, value);
  return parts.join('&');
}

/**
 * One call to the Stripe API with `key`. A GET carries its arguments in the
 * query string ; any other method carries them as a form body in Stripe's
 * bracket notation, and says it is a form even when the form is empty.
 */
function callStripeApi<T>(
  io: UpstreamIo,
  key: string,
  method: HttpMethod,
  path: string,
  args: Args,
  guard: Guard<T>,
  options: { readonly what?: string } = {},
): Promise<T> {
  const authorization = `Bearer ${key}`;
  if (method === 'GET') {
    return httpJson(
      io,
      {
        url: `${STRIPE_API_BASE}${path}${queryString(args)}`,
        headers: { authorization },
        ...options,
      },
      guard,
    );
  }
  const form = toFormBody(args);
  return httpJson(
    io,
    {
      url: `${STRIPE_API_BASE}${path}`,
      method,
      headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' },
      ...(form ? { rawBody: form } : {}),
      ...options,
    },
    guard,
  );
}
