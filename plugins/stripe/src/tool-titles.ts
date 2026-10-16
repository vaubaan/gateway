/**
 * What each tool of the `stripe` provider does, in a few words a person reads at
 * a glance (`ProviderPlugin.toolTitles`) : the head of an approval request in
 * the web interface, before the resource the call resolves to. A verb and its
 * object, sentence case, no final period. For people only : never part of
 * `tools/list`, and the host decides nothing from it.
 *
 * A structural test of the gateway checks that every tool of a shipped plugin
 * has its title : a new tool is added here with its declaration.
 */

export const stripeToolTitles: Readonly<Record<string, string>> = {
  stripe__list_products: 'List products',
  stripe__list_prices: 'List prices',
  stripe__list_customers: 'List customers',
  stripe__retrieve_customer: 'Read a customer',
  stripe__list_subscriptions: 'List subscriptions',
  stripe__list_invoices: 'List invoices',
  stripe__list_charges: 'List charges',
  stripe__list_payment_intents: 'List payment intents',
  stripe__get_balance: 'Read the balance',
  stripe__list_events: 'List events',
  stripe__create_product: 'Create a product',
  stripe__update_product: 'Change a product',
  stripe__create_price: 'Create a price',
  stripe__update_price: 'Change a price',
  stripe__create_coupon: 'Create a coupon',
  stripe__create_promotion_code: 'Create a promotion code',
  stripe__create_subscription: 'Create a subscription',
  stripe__update_subscription: 'Change a subscription',
  stripe__cancel_subscription: 'Cancel a subscription',
  stripe__pause_subscription: 'Pause a subscription',
  stripe__create_invoice: 'Create a draft invoice',
  stripe__finalize_invoice: 'Finalize an invoice',
  stripe__void_invoice: 'Void an invoice',
  stripe__create_refund: 'Refund a payment',
  stripe__create_webhook_endpoint: 'Create a webhook endpoint',
  stripe__create_payout: 'Pay out to the bank account',
  stripe__delete_customer: 'Delete a customer',
};
