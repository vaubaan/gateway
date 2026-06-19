/**
 * Stripe v4 risk-based classifier — maps a concrete `(tool, args, bindings)`
 * call to the set of slices the runtime intersects with the risk catalog.
 *
 * Spec     : docs/spec/gateway-risk-model.md §3, §7.
 * Research : .vaubaan/research/providers/stripe.md §2 (tool mapping) + §4
 *            (lint coverage) + §5 (edge cases) + §6 (decisions actées).
 *
 * Distinctive Stripe twists vs the 7 prior providers :
 *
 *   1. **Mode (test/live) is implicit via the binding** — Stripe API keys
 *      are mode-pinned (`sk_test_*` / `sk_live_*`) and namespaces are
 *      disjoint upstream. The classifier reads the mode from the binding's
 *      `environment` field (resolved at runtime by qualifyRiskId to produce
 *      `stripe[live].refund-create` etc.). Tool args never carry a `mode`
 *      parameter — no risk of mixing test/live.
 *
 *   2. **Refund hierarchy** — a refund is a child of charge, itself child of
 *      payment-intent. The slice path is correspondingly long
 *      (`account[A].mode[M].payment-intent[PI].charge[CH].refund[R].W`)
 *      to keep the data-model honest (research Q7).
 *
 *   3. **Webhook secret as synthetic entity** — `create_webhook_endpoint`
 *      emits BOTH `webhook-endpoint.W` (config) AND
 *      `webhook-endpoint[W].secret.W` (credential mint) so the operator
 *      must accept both `webhook-endpoint-write` and `mint-webhook-secret`
 *      (research Q8).
 *
 *   4. **Customer PII overlay** — `list_customers` / `retrieve_customer`
 *      emit BOTH `customer.R` (business payload) AND `customer[C].pii.R`
 *      (PII payload). The same upstream REST call returns both ; we surface
 *      them as separate slices so the operator can opt into RGPD-sensitive
 *      reads distinctly (research Q3).
 *
 *   5. **subscription-create may charge immediately** — when proration is
 *      due, Stripe charges the customer at create time. The classifier
 *      emits BOTH `customer[C].subscription.W` AND `payment-intent.W`
 *      systematically (worst-case, research §4.3 cas 2). The operator must
 *      accept both risks at mint.
 *
 *   6. **No `payment_intent.confirm` exposed at MVP** (research Q9) — flow
 *      normal SaaS confirms via Stripe Checkout client-side or via
 *      `create_payment_intent { confirm: true }` atomically. If exposed
 *      later, a dedicated `stripe.payment-intent-confirm` risk must be
 *      added ; until then it falls to the `stripe.uncategorized-write`
 *      fallback (fail-loud).
 *
 *   7. **No `payment_intent.confirm` / no `delete_customer` / no Connect
 *      tools** at MVP (research §2.4) — fall to the fallback if surfaced.
 */

import type { ProviderBinding, Slice, SliceSegment } from '@vaubaan/shared';

export type ClassifyResult = { slices: Slice[] } | { denied: string };

// ─── Slice helpers ─────────────────────────────────────────────────────────

function slice(action: 'R' | 'W', segments: readonly SliceSegment[]): Slice {
  return { provider: 'stripe', path: segments, action };
}

function name(value: string): SliceSegment {
  return { kind: 'name', value };
}

function ident(value: string): SliceSegment {
  return { kind: 'ident', value };
}

const ANY_IDENT: SliceSegment = { kind: 'ident', value: '*' };

// ─── Binding plumbing ──────────────────────────────────────────────────────

function pickStripeBinding(bindings: ReadonlyArray<ProviderBinding>): ProviderBinding | null {
  return bindings.find((b) => b.provider === 'stripe') ?? null;
}

/** Resolve the account ident segment from the binding's `resource_ref`
 *  (the Stripe account id, `acct_*`). Falls back to `*` when absent so the
 *  classifier stays robust during the early binding-bootstrap. */
function accountSeg(binding: ProviderBinding): SliceSegment {
  const ref = binding.resource_ref;
  return typeof ref === 'string' && ref.length > 0 ? ident(ref) : ANY_IDENT;
}

/** Resolve the mode ident segment from the binding's `environment` field.
 *  Convention : `'live' | 'test'` (string), aligned with the other env-scopable
 *  providers (research §6.bis). Falls back to `*` when absent so a legacy
 *  binding without `environment` does not bypass the catalog. */
function modeSeg(binding: ProviderBinding): SliceSegment {
  const env = binding.environment;
  if (env === 'live' || env === 'test') return ident(env);
  return ANY_IDENT;
}

/** Read a string arg uniformly (returns `null` when missing/empty). */
function strArg(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Resolve an ident segment from a string arg, with `*` fallback. */
function identArg(args: Record<string, unknown>, key: string): SliceSegment {
  const v = strArg(args, key);
  return v !== null ? ident(v) : ANY_IDENT;
}

// ─── Classifier ────────────────────────────────────────────────────────────

/**
 * Classify a Stripe tool call into the slice(s) it touches.
 *
 * Returns `{ slices: Slice[] }` on success — the runtime intersects each
 * slice with the catalog. Returns `{ denied: string }` for an unknown tool
 * or when no Stripe binding is attached.
 *
 * The 25 supported tools cover the 6 cardinal use-cases (research §0) :
 * catalog browsing, customer onboarding, subscription management, invoice
 * lifecycle, refund issuance, webhook integration. Tools outside this list
 * (e.g. `delete_customer`, `payment_intent.confirm`, Stripe Connect) are
 * rejected with `denied` at this layer ; if they ever reach the runtime via
 * a non-classifier path, the fallback risk `stripe.uncategorized-write`
 * catches them (fail-loud by design).
 */
export function classifyStripeV4(
  tool: string,
  args: Record<string, unknown>,
  bindings: ReadonlyArray<ProviderBinding>,
): ClassifyResult {
  const binding = pickStripeBinding(bindings);
  if (!binding) {
    return { denied: 'no stripe binding is attached to this token.' };
  }
  const acct = accountSeg(binding);
  const mode = modeSeg(binding);

  /** Shorthand : build the `account[A].mode[M]` prefix common to every
   *  Stripe slice. Returns a fresh array (segments are immutable so callers
   *  can extend by spreading). */
  const root: readonly SliceSegment[] = [name('account'), acct, name('mode'), mode];

  switch (tool) {
    // ─── READS — catalog ──────────────────────────────────────────────────
    case 'stripe__list_products':
      return {
        slices: [slice('R', [...root, name('product'), ANY_IDENT])],
      };

    case 'stripe__list_prices': {
      // `product` arg is the Stripe product id (filter) — keep it as ident
      // when present so the slice is descriptive in the audit log.
      const productSeg = identArg(args, 'product');
      return {
        slices: [slice('R', [...root, name('product'), productSeg, name('price'), ANY_IDENT])],
      };
    }

    // ─── READS — customers (with PII overlay, research Q3) ────────────────
    case 'stripe__list_customers':
      return {
        slices: [
          slice('R', [...root, name('customer'), ANY_IDENT]),
          slice('R', [...root, name('customer'), ANY_IDENT, name('pii')]),
        ],
      };

    case 'stripe__retrieve_customer': {
      const cust = identArg(args, 'id');
      return {
        slices: [
          slice('R', [...root, name('customer'), cust]),
          slice('R', [...root, name('customer'), cust, name('pii')]),
        ],
      };
    }

    // ─── READS — subscriptions / invoices / payments ──────────────────────
    case 'stripe__list_subscriptions': {
      const cust = identArg(args, 'customer');
      return {
        slices: [slice('R', [...root, name('customer'), cust, name('subscription'), ANY_IDENT])],
      };
    }

    case 'stripe__list_invoices': {
      const cust = identArg(args, 'customer');
      return {
        slices: [slice('R', [...root, name('customer'), cust, name('invoice'), ANY_IDENT])],
      };
    }

    case 'stripe__list_charges': {
      // Charges are children of payment-intent — wildcard the PI.
      return {
        slices: [
          slice('R', [...root, name('payment-intent'), ANY_IDENT, name('charge'), ANY_IDENT]),
        ],
      };
    }

    case 'stripe__list_payment_intents':
      return {
        slices: [slice('R', [...root, name('payment-intent'), ANY_IDENT])],
      };

    // ─── READS — monitoring ───────────────────────────────────────────────
    case 'stripe__get_balance':
      return { slices: [slice('R', [...root, name('balance')])] };

    case 'stripe__list_events':
      // Events mirror balance-transactions for most cardinal events ;
      // emit both slices so the catalog risk `read-balance` covers either
      // pattern (research §4.4).
      return {
        slices: [
          slice('R', [...root, name('event'), ANY_IDENT]),
          slice('R', [...root, name('balance-transaction'), ANY_IDENT]),
        ],
      };

    // ─── WRITES — catalog ─────────────────────────────────────────────────
    case 'stripe__create_product':
      return {
        slices: [slice('W', [...root, name('product')])],
      };

    case 'stripe__update_product': {
      const prod = identArg(args, 'id');
      return { slices: [slice('W', [...root, name('product'), prod])] };
    }

    case 'stripe__create_price': {
      const prod = identArg(args, 'product');
      return {
        slices: [slice('W', [...root, name('product'), prod, name('price')])],
      };
    }

    case 'stripe__update_price': {
      const price = identArg(args, 'id');
      return {
        slices: [slice('W', [...root, name('product'), ANY_IDENT, name('price'), price])],
      };
    }

    case 'stripe__create_coupon':
      return { slices: [slice('W', [...root, name('coupon')])] };

    case 'stripe__create_promotion_code': {
      const coupon = identArg(args, 'coupon');
      return {
        slices: [slice('W', [...root, name('coupon'), coupon, name('promotion-code')])],
      };
    }

    // ─── WRITES — subscriptions ───────────────────────────────────────────
    case 'stripe__create_subscription': {
      // Worst-case : emit both the subscription write AND the payment-intent
      // write (research §4.3 cas 2 — proration immediate triggers a charge).
      // The operator must accept both `stripe.subscription-create` AND
      // `stripe.read-billing-history` payment-intent overlap ; we keep the
      // PI write distinct so an "ops monitoring" preset that explicitly
      // forbids payment-intent writes can still allow sub-create against
      // future Stripe option `proration_behavior: 'none'`.
      const cust = identArg(args, 'customer');
      return {
        slices: [
          slice('W', [...root, name('customer'), cust, name('subscription')]),
          slice('W', [...root, name('payment-intent')]),
        ],
      };
    }

    case 'stripe__update_subscription': {
      const sub = identArg(args, 'id');
      return {
        slices: [slice('W', [...root, name('customer'), ANY_IDENT, name('subscription'), sub])],
      };
    }

    case 'stripe__cancel_subscription': {
      const sub = identArg(args, 'id');
      return {
        slices: [
          slice('W', [
            ...root,
            name('customer'),
            ANY_IDENT,
            name('subscription'),
            sub,
            name('cancel'),
          ]),
        ],
      };
    }

    case 'stripe__pause_subscription': {
      // Pause = update with `pause_collection` field (research §6.bis).
      // Maps to the subscription-update risk, not cancel.
      const sub = identArg(args, 'id');
      return {
        slices: [slice('W', [...root, name('customer'), ANY_IDENT, name('subscription'), sub])],
      };
    }

    // ─── WRITES — invoices ────────────────────────────────────────────────
    case 'stripe__create_invoice': {
      const cust = identArg(args, 'customer');
      return {
        slices: [slice('W', [...root, name('customer'), cust, name('invoice')])],
      };
    }

    case 'stripe__finalize_invoice': {
      const inv = identArg(args, 'id');
      return {
        slices: [
          slice('W', [
            ...root,
            name('customer'),
            ANY_IDENT,
            name('invoice'),
            inv,
            name('finalize'),
          ]),
        ],
      };
    }

    case 'stripe__void_invoice': {
      const inv = identArg(args, 'id');
      return {
        slices: [
          slice('W', [...root, name('customer'), ANY_IDENT, name('invoice'), inv, name('void')]),
        ],
      };
    }

    // ─── WRITES — refund (cardinal) ───────────────────────────────────────
    case 'stripe__create_refund': {
      // Stripe refund can be filtered by `charge` OR `payment_intent` ;
      // resolve the most specific path we can.
      const charge = strArg(args, 'charge');
      const pi = strArg(args, 'payment_intent');
      const piSeg = pi !== null ? ident(pi) : ANY_IDENT;
      const chSeg = charge !== null ? ident(charge) : ANY_IDENT;
      return {
        slices: [
          slice('W', [
            ...root,
            name('payment-intent'),
            piSeg,
            name('charge'),
            chSeg,
            name('refund'),
          ]),
        ],
      };
    }

    // ─── WRITES — webhook (config + credential mint) ──────────────────────
    case 'stripe__create_webhook_endpoint': {
      // Emit BOTH the endpoint config write AND the synthetic secret mint
      // (research §1.5, §4.3 cas 3, Q8). The operator must accept both
      // `webhook-endpoint-write` AND `mint-webhook-secret`.
      return {
        slices: [
          slice('W', [...root, name('webhook-endpoint')]),
          slice('W', [...root, name('webhook-endpoint'), ANY_IDENT, name('secret')]),
        ],
      };
    }

    default:
      return { denied: `unknown stripe tool '${tool}'.` };
  }
}
