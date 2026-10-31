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
 *      call (`undeclaredStripeArgument`) ; `execute` declines it with the
 *      same sentence.
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
 * Identifiers coming from the arguments are read by `readIdArgs` (grammar
 * `stripeId` : one path segment, no dot segment, no separator, no escape) —
 * the function `execute` builds its request from ; a malformed id is
 * `denied`, never escaped. A missing optional id is the glob `*` (the call
 * touches an unknown member).
 */

import {
  ANY_IDENT,
  declaredArgumentsOf,
  undeclaredArgumentDenial,
  type ClassifyOutcome,
  type Resource,
  type Slice,
  type SliceSegment,
} from '@vaubaan/plugin-sdk';

import { PROVIDER_ID, TOOL } from './identity.ts';
import { modeOf, readIdArgs, resolveStripeResource } from './resources.ts';
import { stripeTools } from './tools.ts';

type Args = Readonly<Record<string, unknown>>;

function slice(action: 'R' | 'W', segments: readonly SliceSegment[]): Slice {
  return { provider: PROVIDER_ID, path: segments, action };
}

function name(value: string): SliceSegment {
  return { kind: 'name', value };
}

function ident(value: string): SliceSegment {
  return { kind: 'ident', value };
}

/** The ident segment of an identifier argument : the glob when the call does not carry it. */
function segmentOf(id: string | null): SliceSegment {
  return id === null ? ANY_IDENT : ident(id);
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

/** The argument names each tool declares (`account` included) : its whole argument surface. */
export const DECLARED_ARGUMENTS = declaredArgumentsOf(stripeTools);

/**
 * The refusal of the first argument the tool does not declare, or `null`.
 * `classify` refuses with it before the budget ; `execute` declines with the
 * same sentence for a caller that skipped the classifier, since it forwards
 * the arguments it was given to Stripe.
 */
export function undeclaredStripeArgument(tool: string, args: Args): string | null {
  return undeclaredArgumentDenial(DECLARED_ARGUMENTS, tool, args);
}

function unknownTool(tool: string): string {
  return `unknown ${PROVIDER_ID} tool '${tool}'.`;
}

export function classifyStripe(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ClassifyOutcome {
  if (!DECLARED_ARGUMENTS.has(tool)) return { denied: unknownTool(tool) };
  const undeclared = undeclaredStripeArgument(tool, args);
  if (undeclared !== null) return { denied: undeclared };

  const target = resolveStripeResource(args, resources);
  if ('denied' in target) return target;
  const root = rootOf(target.resource);
  if ('denied' in root) return root;

  // The idents the tool may name ; the call is refused on the first malformed
  // one. `readIdArgs` is the reading `execute` sends from.
  const read = readIdArgs(args);
  if ('denied' in read) return read;
  const id = segmentOf(read.ids.id);
  const product = segmentOf(read.ids.product);
  const customer = segmentOf(read.ids.customer);
  const coupon = segmentOf(read.ids.coupon);
  const charge = segmentOf(read.ids.charge);
  const payment_intent = segmentOf(read.ids.payment_intent);

  /** The overlay a mission must accept to receive customer fields in an answer. */
  const pii = (who: SliceSegment): Slice =>
    slice('R', [...root, name('customer'), who, name('pii')]);

  switch (tool) {
    // ─── Reads — catalog ──────────────────────────────────────────────────
    case TOOL.listProducts:
      return { slices: [slice('R', [...root, name('product'), ANY_IDENT])] };
    case TOOL.listPrices:
      return {
        slices: [slice('R', [...root, name('product'), product, name('price'), ANY_IDENT])],
      };

    // ─── Reads — customers (business payload + PII overlay) ───────────────
    case TOOL.listCustomers:
      return { slices: [slice('R', [...root, name('customer'), ANY_IDENT]), pii(ANY_IDENT)] };
    case TOOL.retrieveCustomer:
      return { slices: [slice('R', [...root, name('customer'), id]), pii(id)] };

    // ─── Reads — billing history ──────────────────────────────────────────
    case TOOL.listSubscriptions:
      // A subscription names its customer by id only : no PII overlay.
      return {
        slices: [
          slice('R', [...root, name('customer'), customer, name('subscription'), ANY_IDENT]),
        ],
      };
    case TOOL.listInvoices:
      return {
        slices: [
          slice('R', [...root, name('customer'), customer, name('invoice'), ANY_IDENT]),
          pii(customer),
        ],
      };
    case TOOL.listCharges:
      return {
        slices: [
          slice('R', [...root, name('payment-intent'), payment_intent, name('charge'), ANY_IDENT]),
          pii(customer),
        ],
      };
    case TOOL.listPaymentIntents:
      return {
        slices: [slice('R', [...root, name('payment-intent'), ANY_IDENT]), pii(customer)],
      };

    // ─── Reads — monitoring ───────────────────────────────────────────────
    case TOOL.getBalance:
      return { slices: [slice('R', [...root, name('balance')])] };
    case TOOL.listEvents:
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
    case TOOL.createProduct:
      return { slices: [slice('W', [...root, name('product')])] };
    case TOOL.updateProduct:
      return { slices: [slice('W', [...root, name('product'), id])] };
    case TOOL.createPrice:
      return { slices: [slice('W', [...root, name('product'), product, name('price')])] };
    case TOOL.updatePrice:
      return {
        slices: [slice('W', [...root, name('product'), ANY_IDENT, name('price'), id])],
      };
    case TOOL.createCoupon:
      return { slices: [slice('W', [...root, name('coupon')])] };
    case TOOL.createPromotionCode:
      return { slices: [slice('W', [...root, name('coupon'), coupon, name('promotion-code')])] };

    // ─── Writes — subscriptions ───────────────────────────────────────────
    case TOOL.createSubscription:
      // Worst case : immediate proration charges the customer at creation.
      return {
        slices: [
          slice('W', [...root, name('customer'), customer, name('subscription')]),
          slice('W', [...root, name('payment-intent')]),
        ],
      };
    case TOOL.updateSubscription:
    case TOOL.pauseSubscription: {
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
    case TOOL.cancelSubscription:
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
    case TOOL.createInvoice: {
      const invoice = [...root, name('customer'), customer, name('invoice')];
      return {
        slices: [
          slice('W', invoice),
          ...(autoAdvances(args) ? [slice('W', [...invoice, ANY_IDENT, name('finalize')])] : []),
        ],
      };
    }
    case TOOL.finalizeInvoice:
      return {
        slices: [
          slice('W', [...root, name('customer'), ANY_IDENT, name('invoice'), id, name('finalize')]),
        ],
      };
    case TOOL.voidInvoice:
      return {
        slices: [
          slice('W', [...root, name('customer'), ANY_IDENT, name('invoice'), id, name('void')]),
        ],
      };

    // ─── Writes — money out ───────────────────────────────────────────────
    case TOOL.createRefund:
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
    case TOOL.createPayout:
      return { slices: [slice('W', [...root, name('payout')])] };

    // ─── Writes — customers ───────────────────────────────────────────────
    case TOOL.deleteCustomer:
      if (id === ANY_IDENT) return { denied: 'id: missing' };
      return { slices: [slice('W', [...root, name('customer'), id, name('delete')])] };

    // ─── Writes — webhooks (config + credential mint) ─────────────────────
    case TOOL.createWebhookEndpoint:
      return {
        slices: [
          slice('W', [...root, name('webhook-endpoint')]),
          slice('W', [...root, name('webhook-endpoint'), ANY_IDENT, name('secret')]),
        ],
      };

    default:
      return { denied: unknownTool(tool) };
  }
}
