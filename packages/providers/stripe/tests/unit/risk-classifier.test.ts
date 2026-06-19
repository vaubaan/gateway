/**
 * Unit tests for `classifyStripeV4` — the Stripe v4 risk-based classifier.
 *
 * Spec     : docs/spec/gateway-risk-model.md §3, §7.
 * Research : .vaubaan/research/providers/stripe.md §2 + §5.
 *
 * Each test pins down :
 *   - the slice(s) emitted for a given (tool, args) call,
 *   - the mode (test/live) propagation from the binding into every slice,
 *   - the customer-PII overlay on customer reads (research Q3),
 *   - the webhook-endpoint + secret dual emission on create (research Q8),
 *   - the subscription-create + payment-intent worst-case (research §4.3),
 *   - the refund hierarchy slice path (research §5.7),
 *   - the denials (unknown tool, no binding).
 */
import { describe, expect, test } from 'vitest';
import type { ProviderBinding } from '@vaubaan/shared';
import { serializeSlice } from '@vaubaan/policy-engine';

import { classifyStripeV4 } from '../../src/risk-classifier.ts';

const liveBinding: ProviderBinding = {
  id: 'b1',
  project_id: 'p1',
  provider: 'stripe',
  resource_ref: 'acct_live',
  display_name: null,
  environment: 'live',
  metadata: {},
  created_at: '2026-01-01',
};

const testBinding: ProviderBinding = {
  id: 'b2',
  project_id: 'p1',
  provider: 'stripe',
  resource_ref: 'acct_test',
  display_name: null,
  environment: 'test',
  metadata: {},
  created_at: '2026-01-01',
};

function classify(
  tool: string,
  args: Record<string, unknown> = {},
  bindings: ReadonlyArray<ProviderBinding> = [liveBinding],
): string[] {
  const result = classifyStripeV4(tool, args, bindings);
  if ('denied' in result) {
    throw new Error(`unexpected denial: ${result.denied}`);
  }
  return result.slices.map((s) => serializeSlice(s));
}

describe('classifyStripeV4 — reads (catalog)', () => {
  test('list_products → product[*].R', () => {
    expect(classify('stripe__list_products')).toEqual([
      'stripe.account[acct_live].mode[live].product[*].R',
    ]);
  });

  test('list_prices(product=prod_x) → product[prod_x].price[*].R', () => {
    expect(classify('stripe__list_prices', { product: 'prod_x' })).toEqual([
      'stripe.account[acct_live].mode[live].product[prod_x].price[*].R',
    ]);
  });
});

describe('classifyStripeV4 — reads (customers + PII overlay, research Q3)', () => {
  test('list_customers emits both customer[*].R AND customer[*].pii.R', () => {
    const sl = classify('stripe__list_customers');
    expect(sl).toContain('stripe.account[acct_live].mode[live].customer[*].R');
    expect(sl).toContain('stripe.account[acct_live].mode[live].customer[*].pii.R');
  });

  test('retrieve_customer(id=cus_x) emits both customer[cus_x].R AND customer[cus_x].pii.R', () => {
    const sl = classify('stripe__retrieve_customer', { id: 'cus_x' });
    expect(sl).toContain('stripe.account[acct_live].mode[live].customer[cus_x].R');
    expect(sl).toContain('stripe.account[acct_live].mode[live].customer[cus_x].pii.R');
  });
});

describe('classifyStripeV4 — reads (billing history)', () => {
  test('list_subscriptions(customer=cus_x) → customer[cus_x].subscription[*].R', () => {
    expect(classify('stripe__list_subscriptions', { customer: 'cus_x' })).toEqual([
      'stripe.account[acct_live].mode[live].customer[cus_x].subscription[*].R',
    ]);
  });

  test('list_invoices(customer=cus_x) → customer[cus_x].invoice[*].R', () => {
    expect(classify('stripe__list_invoices', { customer: 'cus_x' })).toEqual([
      'stripe.account[acct_live].mode[live].customer[cus_x].invoice[*].R',
    ]);
  });

  test('list_charges → payment-intent[*].charge[*].R', () => {
    expect(classify('stripe__list_charges')).toEqual([
      'stripe.account[acct_live].mode[live].payment-intent[*].charge[*].R',
    ]);
  });

  test('list_payment_intents → payment-intent[*].R', () => {
    expect(classify('stripe__list_payment_intents')).toEqual([
      'stripe.account[acct_live].mode[live].payment-intent[*].R',
    ]);
  });
});

describe('classifyStripeV4 — reads (monitoring)', () => {
  test('get_balance → balance.R singleton', () => {
    expect(classify('stripe__get_balance')).toEqual([
      'stripe.account[acct_live].mode[live].balance.R',
    ]);
  });

  test('list_events emits both event[*].R AND balance-transaction[*].R (research §4.4)', () => {
    const sl = classify('stripe__list_events');
    expect(sl).toContain('stripe.account[acct_live].mode[live].event[*].R');
    expect(sl).toContain('stripe.account[acct_live].mode[live].balance-transaction[*].R');
  });
});

describe('classifyStripeV4 — writes (catalog)', () => {
  test('create_product → product.W (no ident)', () => {
    expect(classify('stripe__create_product')).toEqual([
      'stripe.account[acct_live].mode[live].product.W',
    ]);
  });

  test('update_product(id=prod_x) → product[prod_x].W', () => {
    expect(classify('stripe__update_product', { id: 'prod_x' })).toEqual([
      'stripe.account[acct_live].mode[live].product[prod_x].W',
    ]);
  });

  test('create_price(product=prod_x) → product[prod_x].price.W', () => {
    expect(classify('stripe__create_price', { product: 'prod_x' })).toEqual([
      'stripe.account[acct_live].mode[live].product[prod_x].price.W',
    ]);
  });

  test('update_price(id=price_x) → product[*].price[price_x].W', () => {
    expect(classify('stripe__update_price', { id: 'price_x' })).toEqual([
      'stripe.account[acct_live].mode[live].product[*].price[price_x].W',
    ]);
  });

  test('create_coupon → coupon.W', () => {
    expect(classify('stripe__create_coupon')).toEqual([
      'stripe.account[acct_live].mode[live].coupon.W',
    ]);
  });

  test('create_promotion_code(coupon=coup_x) → coupon[coup_x].promotion-code.W', () => {
    expect(classify('stripe__create_promotion_code', { coupon: 'coup_x' })).toEqual([
      'stripe.account[acct_live].mode[live].coupon[coup_x].promotion-code.W',
    ]);
  });
});

describe('classifyStripeV4 — writes (subscriptions)', () => {
  test('create_subscription emits BOTH subscription.W AND payment-intent.W (worst-case)', () => {
    const sl = classify('stripe__create_subscription', { customer: 'cus_x' });
    expect(sl).toContain('stripe.account[acct_live].mode[live].customer[cus_x].subscription.W');
    expect(sl).toContain('stripe.account[acct_live].mode[live].payment-intent.W');
  });

  test('update_subscription(id=sub_x) → customer[*].subscription[sub_x].W', () => {
    expect(classify('stripe__update_subscription', { id: 'sub_x' })).toEqual([
      'stripe.account[acct_live].mode[live].customer[*].subscription[sub_x].W',
    ]);
  });

  test('cancel_subscription(id=sub_x) → customer[*].subscription[sub_x].cancel.W', () => {
    expect(classify('stripe__cancel_subscription', { id: 'sub_x' })).toEqual([
      'stripe.account[acct_live].mode[live].customer[*].subscription[sub_x].cancel.W',
    ]);
  });

  test('pause_subscription → subscription update path (not cancel)', () => {
    // Pause maps to the subscription-update risk (research §6.bis).
    expect(classify('stripe__pause_subscription', { id: 'sub_x' })).toEqual([
      'stripe.account[acct_live].mode[live].customer[*].subscription[sub_x].W',
    ]);
  });
});

describe('classifyStripeV4 — writes (invoices)', () => {
  test('create_invoice(customer=cus_x) → customer[cus_x].invoice.W', () => {
    expect(classify('stripe__create_invoice', { customer: 'cus_x' })).toEqual([
      'stripe.account[acct_live].mode[live].customer[cus_x].invoice.W',
    ]);
  });

  test('finalize_invoice(id=inv_x) → invoice[inv_x].finalize.W', () => {
    expect(classify('stripe__finalize_invoice', { id: 'inv_x' })).toEqual([
      'stripe.account[acct_live].mode[live].customer[*].invoice[inv_x].finalize.W',
    ]);
  });

  test('void_invoice(id=inv_x) → invoice[inv_x].void.W (distinct from finalize)', () => {
    expect(classify('stripe__void_invoice', { id: 'inv_x' })).toEqual([
      'stripe.account[acct_live].mode[live].customer[*].invoice[inv_x].void.W',
    ]);
  });
});

describe('classifyStripeV4 — writes (refund — cardinal)', () => {
  test('create_refund(charge=ch_x) → payment-intent[*].charge[ch_x].refund.W', () => {
    expect(classify('stripe__create_refund', { charge: 'ch_x' })).toEqual([
      'stripe.account[acct_live].mode[live].payment-intent[*].charge[ch_x].refund.W',
    ]);
  });

  test('create_refund(payment_intent=pi_x) → payment-intent[pi_x].charge[*].refund.W', () => {
    expect(classify('stripe__create_refund', { payment_intent: 'pi_x' })).toEqual([
      'stripe.account[acct_live].mode[live].payment-intent[pi_x].charge[*].refund.W',
    ]);
  });

  test('create_refund(both charge AND payment_intent) → uses both as idents', () => {
    expect(classify('stripe__create_refund', { charge: 'ch_x', payment_intent: 'pi_x' })).toEqual([
      'stripe.account[acct_live].mode[live].payment-intent[pi_x].charge[ch_x].refund.W',
    ]);
  });
});

describe('classifyStripeV4 — writes (webhook endpoint + secret mint, research Q8)', () => {
  test('create_webhook_endpoint emits BOTH webhook-endpoint.W AND webhook-endpoint[*].secret.W', () => {
    const sl = classify('stripe__create_webhook_endpoint');
    expect(sl).toContain('stripe.account[acct_live].mode[live].webhook-endpoint.W');
    expect(sl).toContain('stripe.account[acct_live].mode[live].webhook-endpoint[*].secret.W');
  });
});

describe('classifyStripeV4 — mode propagation (test vs live)', () => {
  test('live binding produces mode[live] in slices', () => {
    expect(classify('stripe__get_balance', {}, [liveBinding])).toEqual([
      'stripe.account[acct_live].mode[live].balance.R',
    ]);
  });

  test('test binding produces mode[test] in slices', () => {
    expect(classify('stripe__get_balance', {}, [testBinding])).toEqual([
      'stripe.account[acct_test].mode[test].balance.R',
    ]);
  });

  test('binding without environment falls back to mode[*] (safe wildcard)', () => {
    const noEnv: ProviderBinding = {
      ...liveBinding,
      environment: null,
    };
    expect(classify('stripe__get_balance', {}, [noEnv])).toEqual([
      'stripe.account[acct_live].mode[*].balance.R',
    ]);
  });

  test('binding with garbage environment falls back to mode[*]', () => {
    const weirdEnv: ProviderBinding = {
      ...liveBinding,
      environment: 'production',
    };
    expect(classify('stripe__get_balance', {}, [weirdEnv])).toEqual([
      'stripe.account[acct_live].mode[*].balance.R',
    ]);
  });
});

describe('classifyStripeV4 — denials', () => {
  test('unknown tool → denied', () => {
    const result = classifyStripeV4('stripe__bogus', {}, [liveBinding]);
    expect(result).toEqual({ denied: "unknown stripe tool 'stripe__bogus'." });
  });

  test('no stripe binding on the token → denied', () => {
    const result = classifyStripeV4('stripe__get_balance', {}, []);
    expect(result).toEqual({ denied: 'no stripe binding is attached to this token.' });
  });

  test('non-stripe bindings are ignored (binding picker)', () => {
    const other: ProviderBinding = {
      ...liveBinding,
      provider: 'gmail',
    };
    const result = classifyStripeV4('stripe__get_balance', {}, [other]);
    expect(result).toEqual({ denied: 'no stripe binding is attached to this token.' });
  });
});

describe('classifyStripeV4 — confirm/delete/connect tools fall through to denied (MVP scope)', () => {
  // The classifier knows 25 tools ; anything else is denied here (the
  // fallback risk only kicks in if the runtime executes the call via a
  // non-classifier path). This is fail-loud by design — adding a new tool
  // requires (1) classifier case + (2) catalog risk entry.
  for (const tool of [
    'stripe__delete_customer',
    'stripe__confirm_payment_intent',
    'stripe__create_payout',
    'stripe__create_transfer',
    'stripe__create_account', // Connect
  ]) {
    test(`'${tool}' is denied at the classifier (fail-loud)`, () => {
      const result = classifyStripeV4(tool, {}, [liveBinding]);
      expect(result).toHaveProperty('denied');
    });
  }
});
