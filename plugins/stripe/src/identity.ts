/**
 * Identity of the `stripe` service — the one place its ids are written.
 *
 * Handbook : docs/handbook/services/stripe.md.
 *
 * `SERVICE_ID` is also written as `service:` and as the prefix of every id
 * in `risk-catalog.yaml`, and in the package name. Everything else — the
 * plugin id, the data-model service, the tool names, the resources
 * discovery returns — is derived from this module.
 */

import { toolPrefixFor } from '@vaubaan/plugin-sdk';

/** The service id. */
export const SERVICE_ID = 'stripe';

/** `stripe__` : prepended to every tool name. */
export const TOOL_PREFIX = toolPrefixFor(SERVICE_ID);

/** Public API of the service — a fact about Stripe, not instance configuration. */
export const STRIPE_API_BASE = 'https://api.stripe.com/v1';

/** The MCP tool names, in the order `tools/list` gives them. */
export const TOOL = {
  listProducts: `${TOOL_PREFIX}list_products`,
  listPrices: `${TOOL_PREFIX}list_prices`,
  listCustomers: `${TOOL_PREFIX}list_customers`,
  retrieveCustomer: `${TOOL_PREFIX}retrieve_customer`,
  listSubscriptions: `${TOOL_PREFIX}list_subscriptions`,
  listInvoices: `${TOOL_PREFIX}list_invoices`,
  listCharges: `${TOOL_PREFIX}list_charges`,
  listPaymentIntents: `${TOOL_PREFIX}list_payment_intents`,
  getBalance: `${TOOL_PREFIX}get_balance`,
  listEvents: `${TOOL_PREFIX}list_events`,
  createProduct: `${TOOL_PREFIX}create_product`,
  updateProduct: `${TOOL_PREFIX}update_product`,
  createPrice: `${TOOL_PREFIX}create_price`,
  updatePrice: `${TOOL_PREFIX}update_price`,
  createCoupon: `${TOOL_PREFIX}create_coupon`,
  createPromotionCode: `${TOOL_PREFIX}create_promotion_code`,
  createSubscription: `${TOOL_PREFIX}create_subscription`,
  updateSubscription: `${TOOL_PREFIX}update_subscription`,
  cancelSubscription: `${TOOL_PREFIX}cancel_subscription`,
  pauseSubscription: `${TOOL_PREFIX}pause_subscription`,
  createInvoice: `${TOOL_PREFIX}create_invoice`,
  finalizeInvoice: `${TOOL_PREFIX}finalize_invoice`,
  voidInvoice: `${TOOL_PREFIX}void_invoice`,
  createRefund: `${TOOL_PREFIX}create_refund`,
  createWebhookEndpoint: `${TOOL_PREFIX}create_webhook_endpoint`,
  createPayout: `${TOOL_PREFIX}create_payout`,
  deleteCustomer: `${TOOL_PREFIX}delete_customer`,
} as const;
