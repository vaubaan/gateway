/**
 * Stripe MCP tools — thin wrappers over the Stripe REST API v1.
 *
 * 27 tools : 10 reads (GET) and 17 writes (POST / DELETE). Names follow the
 * `<service>__<verb>_<noun>` convention of the SDK (`TOOL` in `identity.ts`).
 *
 * Every tool accepts an optional `account` argument : the ref of the Stripe
 * resource the call targets (`acct_123/test` or `acct_123/live`, as listed in
 * the mission). It is optional when the mission touches a single Stripe
 * resource ; the classifier refuses the call otherwise. The argument is
 * consumed by the gateway and never forwarded to Stripe.
 *
 * The declared properties are the whole argument surface : a call carrying
 * any other key is refused by the classifier and declined by `execute`, with
 * one sentence (`undeclaredStripeArgument` in `classify.ts`). Declaring a new
 * property therefore means deciding, in `classify.ts`, what it costs.
 *
 * Spec : docs/spec/gateway-risk-model.md §7 ; docs/spec/vaubaan-gateway.md §5.
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

import { TOOL } from './identity.ts';

/** Argument shared by every tool ; added by `withAccountArg` below. */
const ACCOUNT_ARG = {
  account: {
    type: 'string',
    description:
      'Stripe resource ref as listed in the mission (`acct_…/test` or `acct_…/live`). ' +
      'Optional when the mission touches a single Stripe resource.',
  },
} as const;

function withAccountArg(tool: McpToolDeclaration): McpToolDeclaration {
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: { ...ACCOUNT_ARG, ...(tool.inputSchema.properties ?? {}) },
    },
  };
}

// ─── Read tools ─────────────────────────────────────────────────────────────

const READ_TOOLS: readonly McpToolDeclaration[] = [
  {
    name: TOOL.listProducts,
    description: 'List all products. Backed by GET /v1/products.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of results to return (1–100, default 10).',
        },
        starting_after: {
          type: 'string',
          description: 'Cursor for pagination — the id of the last product in the previous page.',
        },
        active: {
          type: 'boolean',
          description: 'Filter by active status.',
        },
      },
    },
  },
  {
    name: TOOL.listPrices,
    description: 'List all prices, optionally filtered by product. Backed by GET /v1/prices.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of results to return (1–100, default 10).',
        },
        starting_after: {
          type: 'string',
          description: 'Cursor for pagination — the id of the last price in the previous page.',
        },
        product: {
          type: 'string',
          description: 'Filter prices by product id (prod_xxx).',
        },
        active: {
          type: 'boolean',
          description: 'Filter by active status.',
        },
        type: {
          type: 'string',
          description: 'Filter by price type: "one_time" or "recurring".',
        },
      },
    },
  },
  {
    name: TOOL.listCustomers,
    description:
      'List all customers. Returns PII fields (email, name, address, phone). Backed by GET /v1/customers.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of results to return (1–100, default 10).',
        },
        starting_after: {
          type: 'string',
          description: 'Cursor for pagination — the id of the last customer in the previous page.',
        },
        email: {
          type: 'string',
          description: 'Filter by exact email address.',
        },
      },
    },
  },
  {
    name: TOOL.retrieveCustomer,
    description:
      'Retrieve a single customer by id. Returns PII fields (email, name, address, phone, shipping). Backed by GET /v1/customers/:id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The customer id (cus_xxx).',
        },
      },
      required: ['id'],
    },
  },
  {
    name: TOOL.listSubscriptions,
    description:
      'List subscriptions, optionally filtered by customer or status. Backed by GET /v1/subscriptions.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of results to return (1–100, default 10).',
        },
        starting_after: {
          type: 'string',
          description:
            'Cursor for pagination — the id of the last subscription in the previous page.',
        },
        customer: {
          type: 'string',
          description: 'Filter by customer id (cus_xxx).',
        },
        status: {
          type: 'string',
          description:
            'Filter by status: "active", "past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "trialing", "paused", or "all".',
        },
        price: {
          type: 'string',
          description: 'Filter by price id (price_xxx).',
        },
      },
    },
  },
  {
    name: TOOL.listInvoices,
    description:
      'List invoices, optionally filtered by customer or status. Backed by GET /v1/invoices.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of results to return (1–100, default 10).',
        },
        starting_after: {
          type: 'string',
          description: 'Cursor for pagination — the id of the last invoice in the previous page.',
        },
        customer: {
          type: 'string',
          description: 'Filter by customer id (cus_xxx).',
        },
        status: {
          type: 'string',
          description: 'Filter by status: "draft", "open", "paid", "uncollectible", or "void".',
        },
        subscription: {
          type: 'string',
          description: 'Filter by subscription id (sub_xxx).',
        },
      },
    },
  },
  {
    name: TOOL.listCharges,
    description: 'List charges, optionally filtered by customer. Backed by GET /v1/charges.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of results to return (1–100, default 10).',
        },
        starting_after: {
          type: 'string',
          description: 'Cursor for pagination — the id of the last charge in the previous page.',
        },
        customer: {
          type: 'string',
          description: 'Filter by customer id (cus_xxx).',
        },
        payment_intent: {
          type: 'string',
          description: 'Filter by payment intent id (pi_xxx).',
        },
      },
    },
  },
  {
    name: TOOL.listPaymentIntents,
    description:
      'List payment intents, optionally filtered by customer. Backed by GET /v1/payment_intents.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of results to return (1–100, default 10).',
        },
        starting_after: {
          type: 'string',
          description:
            'Cursor for pagination — the id of the last payment intent in the previous page.',
        },
        customer: {
          type: 'string',
          description: 'Filter by customer id (cus_xxx).',
        },
      },
    },
  },
  {
    name: TOOL.getBalance,
    description:
      'Retrieve the current account balance (available, pending, connect_reserved). Backed by GET /v1/balance.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: TOOL.listEvents,
    description: 'List events (webhook delivery log / audit feed). Backed by GET /v1/events.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of results to return (1–100, default 10).',
        },
        starting_after: {
          type: 'string',
          description: 'Cursor for pagination — the id of the last event in the previous page.',
        },
        type: {
          type: 'string',
          description:
            'Filter by event type (e.g. "charge.succeeded", "invoice.paid"). Supports wildcards like "charge.*".',
        },
      },
    },
  },
];

// ─── Write tools ────────────────────────────────────────────────────────────

const WRITE_TOOLS: readonly McpToolDeclaration[] = [
  {
    name: TOOL.createProduct,
    description: 'Create a new product. Backed by POST /v1/products.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The product name, displayed to customers.',
        },
        description: {
          type: 'string',
          description: 'Product description.',
        },
        active: {
          type: 'boolean',
          description: 'Whether the product is currently available for purchase (default true).',
        },
        metadata: {
          type: 'object',
          description: 'Arbitrary key-value metadata.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: TOOL.updateProduct,
    description: 'Update an existing product. Backed by POST /v1/products/:id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The product id (prod_xxx).',
        },
        name: {
          type: 'string',
          description: 'Updated product name.',
        },
        description: {
          type: 'string',
          description: 'Updated product description.',
        },
        active: {
          type: 'boolean',
          description: 'Whether the product is active.',
        },
        metadata: {
          type: 'object',
          description: 'Arbitrary key-value metadata.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: TOOL.createPrice,
    description: 'Create a new price for a product. Backed by POST /v1/prices.',
    inputSchema: {
      type: 'object',
      properties: {
        product: {
          type: 'string',
          description: 'The product id (prod_xxx) this price belongs to.',
        },
        unit_amount: {
          type: 'number',
          description: 'Price amount in the smallest currency unit (e.g. cents for USD).',
        },
        currency: {
          type: 'string',
          description: 'Three-letter ISO currency code (e.g. "usd", "eur").',
        },
        recurring: {
          type: 'object',
          description:
            'Recurring billing configuration. Set `interval` ("day", "week", "month", "year") and optionally `interval_count`.',
          properties: {
            interval: {
              type: 'string',
              description: 'Billing interval: "day", "week", "month", or "year".',
            },
            interval_count: {
              type: 'number',
              description: 'Number of intervals between billings (default 1).',
            },
          },
        },
        active: {
          type: 'boolean',
          description: 'Whether the price is active (default true).',
        },
        metadata: {
          type: 'object',
          description: 'Arbitrary key-value metadata.',
        },
      },
      required: ['product', 'unit_amount', 'currency'],
    },
  },
  {
    name: TOOL.updatePrice,
    description: 'Update an existing price. Backed by POST /v1/prices/:id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The price id (price_xxx).',
        },
        active: {
          type: 'boolean',
          description: 'Whether the price is active.',
        },
        metadata: {
          type: 'object',
          description: 'Arbitrary key-value metadata.',
        },
        nickname: {
          type: 'string',
          description: 'A brief description of the price, hidden from customers.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: TOOL.createCoupon,
    description: 'Create a new coupon (amount-off or percent-off). Backed by POST /v1/coupons.',
    inputSchema: {
      type: 'object',
      properties: {
        percent_off: {
          type: 'number',
          description: 'Percentage discount (1–100). Mutually exclusive with amount_off.',
        },
        amount_off: {
          type: 'number',
          description:
            'Amount to subtract in the smallest currency unit. Mutually exclusive with percent_off.',
        },
        currency: {
          type: 'string',
          description: 'Required when using amount_off. Three-letter ISO currency code.',
        },
        duration: {
          type: 'string',
          description: 'How long the coupon applies: "forever", "once", or "repeating".',
        },
        duration_in_months: {
          type: 'number',
          description:
            'Number of months the coupon applies (required when duration is "repeating").',
        },
        name: {
          type: 'string',
          description: 'Display name of the coupon.',
        },
        metadata: {
          type: 'object',
          description: 'Arbitrary key-value metadata.',
        },
      },
    },
  },
  {
    name: TOOL.createPromotionCode,
    description:
      'Create a customer-facing promotion code for an existing coupon. Backed by POST /v1/promotion_codes.',
    inputSchema: {
      type: 'object',
      properties: {
        coupon: {
          type: 'string',
          description: 'The coupon id this promotion code will redeem.',
        },
        code: {
          type: 'string',
          description:
            'The customer-facing code string (e.g. "SUMMER20"). Auto-generated if omitted.',
        },
        active: {
          type: 'boolean',
          description: 'Whether the promotion code is active (default true).',
        },
        max_redemptions: {
          type: 'number',
          description: 'Maximum number of times this code can be redeemed.',
        },
        metadata: {
          type: 'object',
          description: 'Arbitrary key-value metadata.',
        },
      },
      required: ['coupon'],
    },
  },
  {
    name: TOOL.createSubscription,
    description:
      'Create a new subscription for a customer. May trigger an immediate charge if proration applies. Backed by POST /v1/subscriptions.',
    inputSchema: {
      type: 'object',
      properties: {
        customer: {
          type: 'string',
          description: 'The customer id (cus_xxx).',
        },
        items: {
          type: 'array',
          description: 'List of subscription items (each with a price id and optional quantity).',
          items: {
            type: 'object',
            properties: {
              price: {
                type: 'string',
                description: 'The price id (price_xxx).',
              },
              quantity: {
                type: 'number',
                description: 'Number of units (default 1).',
              },
            },
            required: ['price'],
          },
        },
        default_payment_method: {
          type: 'string',
          description: 'Payment method id (pm_xxx) to use for this subscription.',
        },
        trial_period_days: {
          type: 'number',
          description: 'Number of trial days before billing starts.',
        },
        promotion_code: {
          type: 'string',
          description: 'Promotion code id to apply.',
        },
        metadata: {
          type: 'object',
          description: 'Arbitrary key-value metadata.',
        },
      },
      required: ['customer', 'items'],
    },
  },
  {
    name: TOOL.updateSubscription,
    description:
      'Update an existing subscription (change plan, quantity, payment method, metadata). Backed by POST /v1/subscriptions/:id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The subscription id (sub_xxx).',
        },
        items: {
          type: 'array',
          description: 'Updated subscription items.',
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'The subscription item id (si_xxx). Required for existing items.',
              },
              price: {
                type: 'string',
                description: 'The price id (price_xxx).',
              },
              quantity: {
                type: 'number',
                description: 'Number of units.',
              },
            },
          },
        },
        default_payment_method: {
          type: 'string',
          description: 'Payment method id (pm_xxx) to use.',
        },
        proration_behavior: {
          type: 'string',
          description: 'Proration behavior: "create_prorations", "none", or "always_invoice".',
        },
        cancel_at_period_end: {
          type: 'boolean',
          description:
            'If true, the subscription is cancelled at the end of the current period — classified as a cancellation. False clears a scheduled cancellation.',
        },
        cancel_at: {
          type: 'number',
          description:
            'Unix timestamp at which the subscription is cancelled — classified as a cancellation.',
        },
        metadata: {
          type: 'object',
          description: 'Arbitrary key-value metadata.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: TOOL.cancelSubscription,
    description:
      'Cancel a subscription. Irreversible — stops future billing. Backed by DELETE /v1/subscriptions/:id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The subscription id (sub_xxx).',
        },
        cancel_at_period_end: {
          type: 'boolean',
          description:
            'If true, delay cancellation until the end of the current period instead of immediately.',
        },
        prorate: {
          type: 'boolean',
          description: 'Whether to prorate the cancellation.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: TOOL.pauseSubscription,
    description:
      'Pause a subscription by setting pause_collection. Technically an update with pause_collection field. Backed by POST /v1/subscriptions/:id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The subscription id (sub_xxx).',
        },
        pause_collection: {
          type: 'object',
          description: 'Pause configuration.',
          properties: {
            behavior: {
              type: 'string',
              description:
                'Pause behavior: "keep_as_draft" (invoices stay draft), "mark_uncollectible", or "void" (invoices voided).',
            },
            resumes_at: {
              type: 'number',
              description: 'Unix timestamp when the subscription should automatically resume.',
            },
          },
          required: ['behavior'],
        },
      },
      required: ['id', 'pause_collection'],
    },
  },
  {
    name: TOOL.createInvoice,
    description:
      'Create a draft invoice for a customer. No notification is sent until finalized. Backed by POST /v1/invoices.',
    inputSchema: {
      type: 'object',
      properties: {
        customer: {
          type: 'string',
          description: 'The customer id (cus_xxx).',
        },
        auto_advance: {
          type: 'boolean',
          description:
            'If true, Stripe finalizes the invoice and attempts collection on its own — classified as a finalization. Default false: the invoice stays a draft.',
        },
        description: {
          type: 'string',
          description: 'Invoice description.',
        },
        metadata: {
          type: 'object',
          description: 'Arbitrary key-value metadata.',
        },
      },
      required: ['customer'],
    },
  },
  {
    name: TOOL.finalizeInvoice,
    description:
      'Finalize a draft invoice — locks it, notifies the customer (email by default), and triggers automatic collection if auto_advance is true. Backed by POST /v1/invoices/:id/finalize.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The invoice id (in_xxx).',
        },
        auto_advance: {
          type: 'boolean',
          description: 'Override auto_advance for this finalization.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: TOOL.voidInvoice,
    description:
      'Void a finalized invoice. Irreversible — the invoice becomes permanently inert. Backed by POST /v1/invoices/:id/void.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The invoice id (in_xxx).',
        },
      },
      required: ['id'],
    },
  },
  {
    name: TOOL.createRefund,
    description:
      'Create a refund on a charge or payment intent. Real money leaves the merchant account. Irreversible. Backed by POST /v1/refunds.',
    inputSchema: {
      type: 'object',
      properties: {
        charge: {
          type: 'string',
          description: 'The charge id (ch_xxx) to refund. Mutually exclusive with payment_intent.',
        },
        payment_intent: {
          type: 'string',
          description: 'The payment intent id (pi_xxx) to refund. Mutually exclusive with charge.',
        },
        amount: {
          type: 'number',
          description: 'Amount to refund in the smallest currency unit. Omit for a full refund.',
        },
        reason: {
          type: 'string',
          description:
            'Reason for the refund: "duplicate", "fraudulent", or "requested_by_customer".',
        },
        metadata: {
          type: 'object',
          description: 'Arbitrary key-value metadata.',
        },
      },
    },
  },
  {
    name: TOOL.createWebhookEndpoint,
    description:
      'Create a webhook endpoint. Returns a signing secret (whsec_*) that is only available at creation time. Backed by POST /v1/webhook_endpoints.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL that will receive webhook events.',
        },
        enabled_events: {
          type: 'array',
          items: { type: 'string' },
          description:
            'List of event types to receive (e.g. ["charge.succeeded", "invoice.paid"]). Use ["*"] for all events.',
        },
        description: {
          type: 'string',
          description: 'Optional description for the endpoint.',
        },
        metadata: {
          type: 'object',
          description: 'Arbitrary key-value metadata.',
        },
      },
      required: ['url', 'enabled_events'],
    },
  },
  {
    name: TOOL.createPayout,
    description:
      'Send funds from the Stripe balance to the bank account or debit card on file (real money ' +
      'out in live mode). Backed by POST /v1/payouts.',
    inputSchema: {
      type: 'object',
      properties: {
        amount: {
          type: 'number',
          description: 'Positive integer in the smallest currency unit (cents).',
        },
        currency: {
          type: 'string',
          description: 'Three-letter ISO currency code, lowercase.',
        },
        description: {
          type: 'string',
          description: 'Arbitrary string attached to the payout.',
        },
        statement_descriptor: {
          type: 'string',
          description: 'Text shown on the bank statement (22 characters max).',
        },
        destination: {
          type: 'string',
          description:
            'Id of the bank account or card to send funds to (default external account when absent).',
        },
        method: {
          type: 'string',
          description: '`standard` (default) or `instant`.',
        },
        metadata: {
          type: 'object',
          description: 'Arbitrary key-value metadata.',
        },
      },
      required: ['amount', 'currency'],
    },
  },
  {
    name: TOOL.deleteCustomer,
    description:
      'Permanently delete a customer. Cannot be undone ; immediately cancels every active ' +
      'subscription of the customer. Backed by DELETE /v1/customers/:id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Customer id (cus_xxx).',
        },
      },
      required: ['id'],
    },
  },
];

/** Every tool of the plugin, each accepting the optional `account` ref. */
export const stripeTools: readonly McpToolDeclaration[] = [...READ_TOOLS, ...WRITE_TOOLS].map(
  withAccountArg,
);
