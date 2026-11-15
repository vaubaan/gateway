/**
 * What each tool of the `stripe` service does, in a few words a person reads at
 * a glance (`ServicePlugin.toolTitles`) : the head of an approval request in
 * the web interface, before the resource the call resolves to. A verb and its
 * object, sentence case, no final period. For people only : never part of
 * `tools/list`, and the host decides nothing from it.
 *
 * A structural test of the gateway checks that every tool of a shipped plugin
 * has its title : a new tool is added here with its declaration.
 */

import { TOOL } from './identity.ts';

export const stripeToolTitles: Readonly<Record<string, string>> = {
  [TOOL.listProducts]: 'List products',
  [TOOL.listPrices]: 'List prices',
  [TOOL.listCustomers]: 'List customers',
  [TOOL.retrieveCustomer]: 'Read a customer',
  [TOOL.listSubscriptions]: 'List subscriptions',
  [TOOL.listInvoices]: 'List invoices',
  [TOOL.listCharges]: 'List charges',
  [TOOL.listPaymentIntents]: 'List payment intents',
  [TOOL.getBalance]: 'Read the balance',
  [TOOL.listEvents]: 'List events',
  [TOOL.createProduct]: 'Create a product',
  [TOOL.updateProduct]: 'Change a product',
  [TOOL.createPrice]: 'Create a price',
  [TOOL.updatePrice]: 'Change a price',
  [TOOL.createCoupon]: 'Create a coupon',
  [TOOL.createPromotionCode]: 'Create a promotion code',
  [TOOL.createSubscription]: 'Create a subscription',
  [TOOL.updateSubscription]: 'Change a subscription',
  [TOOL.cancelSubscription]: 'Cancel a subscription',
  [TOOL.pauseSubscription]: 'Pause a subscription',
  [TOOL.createInvoice]: 'Create a draft invoice',
  [TOOL.finalizeInvoice]: 'Finalize an invoice',
  [TOOL.voidInvoice]: 'Void an invoice',
  [TOOL.createRefund]: 'Refund a payment',
  [TOOL.createWebhookEndpoint]: 'Create a webhook endpoint',
  [TOOL.createPayout]: 'Pay out to the bank account',
  [TOOL.deleteCustomer]: 'Delete a customer',
};
