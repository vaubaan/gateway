/**
 * Representative calls of every tool of the `stripe` service
 * (`ServicePlugin.examples`) : the samples the plugin's tests run through the
 * kit and the site classifies when it builds (ADR
 * plugin-contract-and-credential-spec, amendment 2026-11-05).
 *
 * The samples run on the live mode of one account, the one a mission must
 * guard ; one names the mode explicitly among both.
 */
import { samplesOn, type Resource, type ToolSamples } from '@vaubaan/plugin-sdk';

import { SERVICE_ID, TOOL } from './identity.ts';

export const EXAMPLE_TEST_MODE: Resource = {
  service: SERVICE_ID,
  ref: 'acct_1/test',
  env: 'test',
  displayName: 'Acme (test)',
  metadata: { account_id: 'acct_1', mode: 'test' },
};
export const EXAMPLE_LIVE_MODE: Resource = {
  service: SERVICE_ID,
  ref: 'acct_1/live',
  env: 'live',
  displayName: 'Acme (live)',
  metadata: { account_id: 'acct_1', mode: 'live' },
};

const live = EXAMPLE_LIVE_MODE.ref;
const both = [EXAMPLE_TEST_MODE, EXAMPLE_LIVE_MODE];

export const stripeExamples: ToolSamples = samplesOn([EXAMPLE_LIVE_MODE], {
  [TOOL.listProducts]: [{ args: {} }, { args: { account: live }, resources: both }],
  [TOOL.listPrices]: [{ args: { product: 'prod_x' } }],
  [TOOL.listCustomers]: [{ args: {} }],
  [TOOL.retrieveCustomer]: [{ args: { id: 'cus_x' } }],
  [TOOL.listSubscriptions]: [{ args: { customer: 'cus_x' } }],
  [TOOL.listInvoices]: [{ args: {} }],
  [TOOL.listCharges]: [{ args: {} }],
  [TOOL.listPaymentIntents]: [{ args: {} }],
  [TOOL.getBalance]: [{ args: {} }],
  [TOOL.listEvents]: [{ args: {} }],
  [TOOL.createProduct]: [{ args: { name: 'Pro' } }],
  [TOOL.updateProduct]: [{ args: { id: 'prod_x' } }],
  [TOOL.createPrice]: [{ args: { product: 'prod_x', unit_amount: 1, currency: 'eur' } }],
  [TOOL.updatePrice]: [{ args: { id: 'price_x' } }],
  [TOOL.createCoupon]: [{ args: { percent_off: 10 } }],
  [TOOL.createPromotionCode]: [{ args: { coupon: 'co_x' } }],
  [TOOL.createSubscription]: [{ args: { customer: 'cus_x', items: [] } }],
  [TOOL.updateSubscription]: [
    { args: { id: 'sub_x' } },
    { args: { id: 'sub_x', cancel_at_period_end: true } },
  ],
  [TOOL.cancelSubscription]: [{ args: { id: 'sub_x' } }],
  [TOOL.pauseSubscription]: [{ args: { id: 'sub_x', pause_collection: {} } }],
  [TOOL.createInvoice]: [
    { args: { customer: 'cus_x' } },
    { args: { customer: 'cus_x', auto_advance: true } },
    { args: { customer: 'cus_x', expand: ['customer'] }, expectDenied: true },
  ],
  [TOOL.finalizeInvoice]: [{ args: { id: 'in_x' } }],
  [TOOL.voidInvoice]: [{ args: { id: 'in_x' } }],
  [TOOL.createRefund]: [{ args: { charge: 'ch_x' } }, { args: { payment_intent: 'pi_x' } }],
  [TOOL.createPayout]: [{ args: { amount: 100, currency: 'eur' } }],
  [TOOL.deleteCustomer]: [{ args: { id: 'cus_x' } }, { args: {}, expectDenied: true }],
  [TOOL.createWebhookEndpoint]: [{ args: { url: 'https://x', enabled_events: [] } }],
});
