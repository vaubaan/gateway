/**
 * Classifier of the `stripe` provider : `(tool, args, resources) → slices`.
 *
 * Spec : docs/spec/gateway-risk-model.md §3, §7 ; docs/spec/vaubaan-gateway.md
 *        §10 ("a classification error is a security hole").
 *
 * Pure : no IO, no credential, no `Date`. Every slice is rooted at
 * `stripe.account[<ref>].mode[<mode>]` where `<ref>` is the mission resource
 * the call targets (`acct_123/live`) and `<mode>` its test/live mode. The
 * default `resourceEnvResolver` finds the ref as the first ident segment and
 * qualifies env-scoped risks (`stripe[live].refund-create`).
 *
 * Stripe-specific conventions, carried over from the v4 modelling :
 *
 *   1. **Mode comes from the resource, never from an argument.** A key is
 *      pinned to one mode and the namespaces are disjoint upstream.
 *   2. **Refund hierarchy** — `payment-intent[PI].charge[CH].refund.W`, with
 *      whichever of `charge` / `payment_intent` the call names.
 *   3. **Webhook secret as a synthetic entity** — `create_webhook_endpoint`
 *      emits both the endpoint write and the `secret.W` mint.
 *   4. **Customer PII overlay** — customer reads emit both `customer.R` and
 *      `customer[C].pii.R` so identity reads are accepted distinctly.
 *   5. **subscription-create may charge immediately** — it emits the
 *      subscription write and a `payment-intent.W` (worst case).
 *
 * Identifiers coming from the arguments are validated against `SAFE_IDENT`
 * before they are embedded ; a malformed id is `denied`, never escaped. A
 * missing optional id is the glob `*` (the call touches an unknown member).
 */

import type { ClassifyOutcome, Resource, Slice, SliceSegment } from '@vaubaan/plugin-sdk';

import { SAFE_IDENT, STRIPE_PROVIDER, modeOf, resolveStripeResource } from './resources.ts';

function slice(action: 'R' | 'W', segments: readonly SliceSegment[]): Slice {
  return { provider: STRIPE_PROVIDER, path: segments, action };
}

function name(value: string): SliceSegment {
  return { kind: 'name', value };
}

function ident(value: string): SliceSegment {
  return { kind: 'ident', value };
}

const ANY_IDENT: SliceSegment = { kind: 'ident', value: '*' };

/** Malformed-argument marker, distinct from "absent" (glob) and from a valid ident. */
const MALFORMED = Symbol('malformed');

/** An ident segment from an optional string argument : glob when absent, MALFORMED when unusable. */
function identArg(
  args: Readonly<Record<string, unknown>>,
  key: string,
): SliceSegment | typeof MALFORMED {
  const value = args[key];
  if (value === undefined || value === null || value === '') return ANY_IDENT;
  return typeof value === 'string' && SAFE_IDENT.test(value) ? ident(value) : MALFORMED;
}

export function classifyStripe(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ClassifyOutcome {
  const target = resolveStripeResource(args, resources);
  if ('denied' in target) return target;
  const mode = modeOf(target.resource);
  const root: readonly SliceSegment[] = [
    name('account'),
    ident(target.resource.ref),
    name('mode'),
    mode ? ident(mode) : ANY_IDENT,
  ];

  // Collect the idents the tool may name ; refuse the call on the first malformed one.
  const idents: Record<string, SliceSegment> = {};
  for (const key of ['id', 'product', 'customer', 'coupon', 'charge', 'payment_intent']) {
    const seg = identArg(args, key);
    if (seg === MALFORMED) return { denied: `${key}: malformed identifier` };
    idents[key] = seg;
  }
  const { id, product, customer, coupon, charge, payment_intent } = idents as Record<
    'id' | 'product' | 'customer' | 'coupon' | 'charge' | 'payment_intent',
    SliceSegment
  >;

  switch (tool) {
    // ─── Reads — catalog ──────────────────────────────────────────────────
    case 'stripe__list_products':
      return { slices: [slice('R', [...root, name('product'), ANY_IDENT])] };
    case 'stripe__list_prices':
      return {
        slices: [slice('R', [...root, name('product'), product, name('price'), ANY_IDENT])],
      };

    // ─── Reads — customers (business payload + PII overlay) ───────────────
    case 'stripe__list_customers':
      return {
        slices: [
          slice('R', [...root, name('customer'), ANY_IDENT]),
          slice('R', [...root, name('customer'), ANY_IDENT, name('pii')]),
        ],
      };
    case 'stripe__retrieve_customer':
      return {
        slices: [
          slice('R', [...root, name('customer'), id]),
          slice('R', [...root, name('customer'), id, name('pii')]),
        ],
      };

    // ─── Reads — billing history ──────────────────────────────────────────
    case 'stripe__list_subscriptions':
      return {
        slices: [
          slice('R', [...root, name('customer'), customer, name('subscription'), ANY_IDENT]),
        ],
      };
    case 'stripe__list_invoices':
      return {
        slices: [slice('R', [...root, name('customer'), customer, name('invoice'), ANY_IDENT])],
      };
    case 'stripe__list_charges':
      return {
        slices: [
          slice('R', [...root, name('payment-intent'), ANY_IDENT, name('charge'), ANY_IDENT]),
        ],
      };
    case 'stripe__list_payment_intents':
      return { slices: [slice('R', [...root, name('payment-intent'), ANY_IDENT])] };

    // ─── Reads — monitoring ───────────────────────────────────────────────
    case 'stripe__get_balance':
      return { slices: [slice('R', [...root, name('balance')])] };
    case 'stripe__list_events':
      // Events mirror the ledger for the cardinal events ; both slices so the
      // `read-balance` risk covers either pattern.
      return {
        slices: [
          slice('R', [...root, name('event'), ANY_IDENT]),
          slice('R', [...root, name('balance-transaction'), ANY_IDENT]),
        ],
      };

    // ─── Writes — catalog ─────────────────────────────────────────────────
    case 'stripe__create_product':
      return { slices: [slice('W', [...root, name('product')])] };
    case 'stripe__update_product':
      return { slices: [slice('W', [...root, name('product'), id])] };
    case 'stripe__create_price':
      return { slices: [slice('W', [...root, name('product'), product, name('price')])] };
    case 'stripe__update_price':
      return {
        slices: [slice('W', [...root, name('product'), ANY_IDENT, name('price'), id])],
      };
    case 'stripe__create_coupon':
      return { slices: [slice('W', [...root, name('coupon')])] };
    case 'stripe__create_promotion_code':
      return { slices: [slice('W', [...root, name('coupon'), coupon, name('promotion-code')])] };

    // ─── Writes — subscriptions ───────────────────────────────────────────
    case 'stripe__create_subscription':
      // Worst case : immediate proration charges the customer at creation.
      return {
        slices: [
          slice('W', [...root, name('customer'), customer, name('subscription')]),
          slice('W', [...root, name('payment-intent')]),
        ],
      };
    case 'stripe__update_subscription':
    case 'stripe__pause_subscription':
      // Pause is an update carrying `pause_collection` ; same risk as update.
      return {
        slices: [slice('W', [...root, name('customer'), ANY_IDENT, name('subscription'), id])],
      };
    case 'stripe__cancel_subscription':
      return {
        slices: [
          slice('W', [
            ...root,
            name('customer'),
            ANY_IDENT,
            name('subscription'),
            id,
            name('cancel'),
          ]),
        ],
      };

    // ─── Writes — invoices ────────────────────────────────────────────────
    case 'stripe__create_invoice':
      return { slices: [slice('W', [...root, name('customer'), customer, name('invoice')])] };
    case 'stripe__finalize_invoice':
      return {
        slices: [
          slice('W', [...root, name('customer'), ANY_IDENT, name('invoice'), id, name('finalize')]),
        ],
      };
    case 'stripe__void_invoice':
      return {
        slices: [
          slice('W', [...root, name('customer'), ANY_IDENT, name('invoice'), id, name('void')]),
        ],
      };

    // ─── Writes — money out ───────────────────────────────────────────────
    case 'stripe__create_refund':
      return {
        slices: [
          slice('W', [
            ...root,
            name('payment-intent'),
            payment_intent,
            name('charge'),
            charge,
            name('refund'),
          ]),
        ],
      };
    case 'stripe__create_payout':
      return { slices: [slice('W', [...root, name('payout')])] };

    // ─── Writes — customers ───────────────────────────────────────────────
    case 'stripe__delete_customer':
      if (id === ANY_IDENT) return { denied: 'id: missing' };
      return { slices: [slice('W', [...root, name('customer'), id, name('delete')])] };

    // ─── Writes — webhooks (config + credential mint) ─────────────────────
    case 'stripe__create_webhook_endpoint':
      return {
        slices: [
          slice('W', [...root, name('webhook-endpoint')]),
          slice('W', [...root, name('webhook-endpoint'), ANY_IDENT, name('secret')]),
        ],
      };

    default:
      return { denied: `unknown stripe tool '${tool}'.` };
  }
}
