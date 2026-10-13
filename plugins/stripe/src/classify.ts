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
 * Stripe-specific conventions :
 *
 *   1. **Mode comes from the resource, never from an argument.** A key is
 *      pinned to one mode and the namespaces are disjoint upstream. A
 *      resource whose mode cannot be read, or whose environment label is not
 *      that mode, is refused : the risk qualifier (label) and the API key
 *      (mode) must be the same fact.
 *   2. **Only declared arguments.** An argument the tool's schema does not
 *      declare (`expand`, a Stripe parameter nobody classified) refuses the
 *      call ; `execute` forwards the declared ones only.
 *   3. **Refund hierarchy** — `payment-intent[PI].charge[CH].refund.W`, with
 *      whichever of `charge` / `payment_intent` the call names.
 *   4. **Webhook secret as a synthetic entity** — `create_webhook_endpoint`
 *      emits both the endpoint write and the `secret.W` mint.
 *   5. **Customer PII overlay** — every read whose answer carries customer
 *      fields emits `customer[C].pii.R` next to its own slice : customers,
 *      invoices (`customer_email`, `customer_name`, `customer_address`),
 *      charges (`billing_details`, `receipt_email`), payment intents
 *      (`receipt_email`, `shipping`), and events, which embed whole objects,
 *      unless the `type` filter names a family without customer payload.
 *      The answer of a write is not modelled as a read.
 *   6. **subscription-create may charge immediately** — it emits the
 *      subscription write and a `payment-intent.W` (worst case).
 *   7. **An argument that changes the nature of a call adds its slice** —
 *      `update_subscription` scheduling a cancellation also emits `cancel.W`,
 *      `create_invoice` with `auto_advance` also emits `finalize.W`.
 *
 * Identifiers coming from the arguments are validated against `SAFE_IDENT`
 * before they are embedded ; a malformed id is `denied`, never escaped. A
 * missing optional id is the glob `*` (the call touches an unknown member).
 */

import type { ClassifyOutcome, Resource, Slice, SliceSegment } from '@vaubaan/plugin-sdk';

import { SAFE_IDENT, STRIPE_PROVIDER, modeOf, resolveStripeResource } from './resources.ts';
import { declaredArgsOf } from './tools.ts';

type Args = Readonly<Record<string, unknown>>;

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

/** `.` and `..` pass `SAFE_IDENT` but are collapsed by URL resolution into another endpoint. */
const DOTS_ONLY = /^\.+$/;

/** Arguments that name an object ; each is embedded in a slice and may end up in a path. */
const ID_ARGS = ['id', 'product', 'customer', 'coupon', 'charge', 'payment_intent'] as const;
type IdArg = (typeof ID_ARGS)[number];

/** An ident segment from an optional string argument : glob when absent, `null` when unusable. */
function identArg(args: Args, key: IdArg): SliceSegment | null {
  const value = args[key];
  if (value === undefined || value === null || value === '') return ANY_IDENT;
  if (typeof value !== 'string' || !SAFE_IDENT.test(value) || DOTS_ONLY.test(value)) return null;
  return ident(value);
}

function allUsable(
  segments: Readonly<Record<IdArg, SliceSegment | null>>,
): segments is Readonly<Record<IdArg, SliceSegment>> {
  return ID_ARGS.every((key) => segments[key] !== null);
}

/** The root every slice of a call hangs from, or the reason the call has none. */
function rootOf(resource: Resource): readonly SliceSegment[] | { readonly denied: string } {
  const mode = modeOf(resource);
  if (!mode) return { denied: `account: cannot determine the test/live mode of '${resource.ref}'` };
  if (resource.env !== mode) {
    return {
      denied: `account: '${resource.ref}' is a ${mode}-mode resource but its environment label is not '${mode}'`,
    };
  }
  return [name('account'), ident(resource.ref), name('mode'), ident(mode)];
}

/**
 * Does an update of a subscription schedule its cancellation ? Anything but
 * an absent value or an explicit "no" counts : `cancel_at_period_end: false`
 * and an empty `cancel_at` clear a scheduled cancellation, which is an update.
 */
function schedulesCancellation(args: Args): boolean {
  const atPeriodEnd = args.cancel_at_period_end;
  const at = args.cancel_at;
  const periodEndSet = atPeriodEnd !== undefined && atPeriodEnd !== null && atPeriodEnd !== false;
  const dateSet = at !== undefined && at !== null && at !== '';
  return periodEndSet || dateSet;
}

/** `auto_advance` makes Stripe finalize and collect on its own ; only an explicit "no" is a draft. */
function autoAdvances(args: Args): boolean {
  const value = args.auto_advance;
  return value !== undefined && value !== null && value !== false;
}

/** Event families whose objects carry no customer field (payouts, balance, the commercial catalog). */
const EVENT_TYPE_WITHOUT_CUSTOMER_DATA =
  /^(balance|payout|product|price|plan|coupon|promotion_code)\.[a-z_.*]+$/;

function eventsMayCarryCustomerData(args: Args): boolean {
  return typeof args.type !== 'string' || !EVENT_TYPE_WITHOUT_CUSTOMER_DATA.test(args.type);
}

export function classifyStripe(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ClassifyOutcome {
  const declared = declaredArgsOf(tool);
  if (!declared) return { denied: `unknown stripe tool '${tool}'.` };
  const undeclared = Object.keys(args).find((key) => !declared.has(key));
  if (undeclared !== undefined) {
    return { denied: `${undeclared}: not an argument of '${tool}' — nothing classifies it` };
  }

  const target = resolveStripeResource(args, resources);
  if ('denied' in target) return target;
  const root = rootOf(target.resource);
  if ('denied' in root) return root;

  // The idents the tool may name ; the call is refused on the first malformed one.
  const idents = {
    id: identArg(args, 'id'),
    product: identArg(args, 'product'),
    customer: identArg(args, 'customer'),
    coupon: identArg(args, 'coupon'),
    charge: identArg(args, 'charge'),
    payment_intent: identArg(args, 'payment_intent'),
  };
  if (!allUsable(idents)) {
    const malformed = ID_ARGS.find((key) => idents[key] === null);
    return { denied: `${malformed}: malformed identifier` };
  }
  const { id, product, customer, coupon, charge, payment_intent } = idents;

  /** The overlay a mission must accept to receive customer fields in an answer. */
  const pii = (who: SliceSegment): Slice =>
    slice('R', [...root, name('customer'), who, name('pii')]);

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
      return { slices: [slice('R', [...root, name('customer'), ANY_IDENT]), pii(ANY_IDENT)] };
    case 'stripe__retrieve_customer':
      return { slices: [slice('R', [...root, name('customer'), id]), pii(id)] };

    // ─── Reads — billing history ──────────────────────────────────────────
    case 'stripe__list_subscriptions':
      // A subscription names its customer by id only : no PII overlay.
      return {
        slices: [
          slice('R', [...root, name('customer'), customer, name('subscription'), ANY_IDENT]),
        ],
      };
    case 'stripe__list_invoices':
      return {
        slices: [
          slice('R', [...root, name('customer'), customer, name('invoice'), ANY_IDENT]),
          pii(customer),
        ],
      };
    case 'stripe__list_charges':
      return {
        slices: [
          slice('R', [...root, name('payment-intent'), payment_intent, name('charge'), ANY_IDENT]),
          pii(customer),
        ],
      };
    case 'stripe__list_payment_intents':
      return {
        slices: [slice('R', [...root, name('payment-intent'), ANY_IDENT]), pii(customer)],
      };

    // ─── Reads — monitoring ───────────────────────────────────────────────
    case 'stripe__get_balance':
      return { slices: [slice('R', [...root, name('balance')])] };
    case 'stripe__list_events':
      // Events mirror the ledger for the cardinal events ; both slices so the
      // `read-balance` risk covers either pattern. An event embeds the whole
      // object it is about (a customer, an invoice, a charge).
      return {
        slices: [
          slice('R', [...root, name('event'), ANY_IDENT]),
          slice('R', [...root, name('balance-transaction'), ANY_IDENT]),
          ...(eventsMayCarryCustomerData(args) ? [pii(ANY_IDENT)] : []),
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
    case 'stripe__pause_subscription': {
      // Pause is an update carrying `pause_collection` ; same risk as update.
      // Scheduling a cancellation through the update endpoint is a cancel.
      const subscription = [...root, name('customer'), ANY_IDENT, name('subscription'), id];
      return {
        slices: [
          slice('W', subscription),
          ...(schedulesCancellation(args) ? [slice('W', [...subscription, name('cancel')])] : []),
        ],
      };
    }
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
    case 'stripe__create_invoice': {
      const invoice = [...root, name('customer'), customer, name('invoice')];
      return {
        slices: [
          slice('W', invoice),
          ...(autoAdvances(args) ? [slice('W', [...invoice, ANY_IDENT, name('finalize')])] : []),
        ],
      };
    }
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
