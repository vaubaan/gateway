/**
 * Stripe tool dispatcher — routes tool calls to the Stripe REST API v1
 * at https://api.stripe.com/v1/.
 *
 * Auth model : the stored secret is a Stripe API key (`sk_test_*`,
 * `sk_live_*`, or `rk_live_*`). It arrives already decrypted as a
 * plain `token` string. We use `Authorization: Bearer <token>`.
 *
 * Content-Type : Stripe uses `application/x-www-form-urlencoded` for
 * POST bodies (NOT JSON). GET endpoints use query parameters. DELETE
 * endpoints accept optional form params but typically need none.
 */

const STRIPE_API = 'https://api.stripe.com/v1';

export type FetchImpl = typeof fetch;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Flatten a nested object into `application/x-www-form-urlencoded` pairs
 * using Stripe's bracket notation for nested keys.
 *
 * Examples :
 *   { name: 'Pro' }                     → 'name=Pro'
 *   { items: [{ price: 'p_1' }] }       → 'items[0][price]=p_1'
 *   { metadata: { key: 'val' } }        → 'metadata[key]=val'
 *   { pause_collection: { behavior: 'void' } } → 'pause_collection[behavior]=void'
 */
function toFormBody(obj: Record<string, unknown>): string {
  const parts: string[] = [];

  function encode(prefix: string, value: unknown): void {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        encode(`${prefix}[${i}]`, value[i]);
      }
    } else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        encode(`${prefix}[${k}]`, v);
      }
    } else {
      parts.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
    }
  }

  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        encode(`${key}[${i}]`, value[i]);
      }
    } else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        encode(`${key}[${k}]`, v);
      }
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }

  return parts.join('&');
}

/** Build query-string from args (for GET requests). */
function toQueryString(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === null || value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

async function callStripeApi(
  fetchImpl: FetchImpl,
  token: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  let url = `${STRIPE_API}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  const init: RequestInit = { method, headers };

  if (method === 'GET') {
    url += toQueryString(args);
  } else {
    // POST and DELETE use form-encoded body.
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const body = toFormBody(args);
    if (body) init.body = body;
  }

  const res = await fetchImpl(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Stripe API ${method} ${path} ${res.status}: ${text.slice(0, 500)}`);
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

/**
 * Execute a Stripe tool call.
 *
 * @param fetchImpl - fetch implementation (injectable for tests)
 * @param token - the decrypted Stripe API key (sk_test_*, sk_live_*, rk_live_*)
 * @param tool - the full tool name (e.g. `stripe__create_product`)
 * @param args - the tool arguments
 */
export async function executeCall(
  fetchImpl: FetchImpl,
  token: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (tool) {
    // ─── READS ─────────────────────────────────────────────────────────────
    case 'stripe__list_products':
      return callStripeApi(fetchImpl, token, 'GET', '/products', args);

    case 'stripe__list_prices':
      return callStripeApi(fetchImpl, token, 'GET', '/prices', args);

    case 'stripe__list_customers':
      return callStripeApi(fetchImpl, token, 'GET', '/customers', args);

    case 'stripe__retrieve_customer': {
      const id = args.id as string;
      const { id: _, ...rest } = args;
      return callStripeApi(fetchImpl, token, 'GET', `/customers/${id}`, rest);
    }

    case 'stripe__list_subscriptions':
      return callStripeApi(fetchImpl, token, 'GET', '/subscriptions', args);

    case 'stripe__list_invoices':
      return callStripeApi(fetchImpl, token, 'GET', '/invoices', args);

    case 'stripe__list_charges':
      return callStripeApi(fetchImpl, token, 'GET', '/charges', args);

    case 'stripe__list_payment_intents':
      return callStripeApi(fetchImpl, token, 'GET', '/payment_intents', args);

    case 'stripe__get_balance':
      return callStripeApi(fetchImpl, token, 'GET', '/balance', {});

    case 'stripe__list_events':
      return callStripeApi(fetchImpl, token, 'GET', '/events', args);

    // ─── WRITES — catalog ────────────────────────────────────────────────
    case 'stripe__create_product':
      return callStripeApi(fetchImpl, token, 'POST', '/products', args);

    case 'stripe__update_product': {
      const id = args.id as string;
      const { id: _, ...rest } = args;
      return callStripeApi(fetchImpl, token, 'POST', `/products/${id}`, rest);
    }

    case 'stripe__create_price':
      return callStripeApi(fetchImpl, token, 'POST', '/prices', args);

    case 'stripe__update_price': {
      const id = args.id as string;
      const { id: _, ...rest } = args;
      return callStripeApi(fetchImpl, token, 'POST', `/prices/${id}`, rest);
    }

    case 'stripe__create_coupon':
      return callStripeApi(fetchImpl, token, 'POST', '/coupons', args);

    case 'stripe__create_promotion_code':
      return callStripeApi(fetchImpl, token, 'POST', '/promotion_codes', args);

    // ─── WRITES — subscriptions ──────────────────────────────────────────
    case 'stripe__create_subscription':
      return callStripeApi(fetchImpl, token, 'POST', '/subscriptions', args);

    case 'stripe__update_subscription': {
      const id = args.id as string;
      const { id: _, ...rest } = args;
      return callStripeApi(fetchImpl, token, 'POST', `/subscriptions/${id}`, rest);
    }

    case 'stripe__cancel_subscription': {
      const id = args.id as string;
      const { id: _, ...rest } = args;
      return callStripeApi(fetchImpl, token, 'DELETE', `/subscriptions/${id}`, rest);
    }

    case 'stripe__pause_subscription': {
      // Pause is technically a subscription update with pause_collection.
      const id = args.id as string;
      const { id: _, ...rest } = args;
      return callStripeApi(fetchImpl, token, 'POST', `/subscriptions/${id}`, rest);
    }

    // ─── WRITES — invoices ───────────────────────────────────────────────
    case 'stripe__create_invoice':
      return callStripeApi(fetchImpl, token, 'POST', '/invoices', args);

    case 'stripe__finalize_invoice': {
      const id = args.id as string;
      const { id: _, ...rest } = args;
      return callStripeApi(fetchImpl, token, 'POST', `/invoices/${id}/finalize`, rest);
    }

    case 'stripe__void_invoice': {
      const id = args.id as string;
      return callStripeApi(fetchImpl, token, 'POST', `/invoices/${id}/void`, {});
    }

    // ─── WRITES — refund ─────────────────────────────────────────────────
    case 'stripe__create_refund':
      return callStripeApi(fetchImpl, token, 'POST', '/refunds', args);

    // ─── WRITES — webhook ────────────────────────────────────────────────
    case 'stripe__create_webhook_endpoint':
      return callStripeApi(fetchImpl, token, 'POST', '/webhook_endpoints', args);

    default:
      throw new Error(`Stripe tool not implemented: ${tool}`);
  }
}
