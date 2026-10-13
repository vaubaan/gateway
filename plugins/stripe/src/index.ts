/**
 * `@vaubaan/plugin-stripe` — Stripe billing for SaaS operators, on the v5 SDK.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7.
 * ADR  : docs/decisions/plugin-contract-and-credential-spec.md.
 * Handbook : docs/handbook/providers/stripe.md ; guide : plugins/stripe/README.md.
 *
 * Credential : `api-key` with two optional secret fields, the test-mode key
 * and the live-mode key. Each key present yields one resource
 * (`acct_123/test`, `acct_123/live`) whose `env` is the mode, so env-scoped
 * risks resolve as `stripe[live].refund-create`. The YAML catalog is loaded
 * here, once, at import (that is, at gateway boot).
 */

import { catalogPathNextTo, definePlugin, loadCatalogFile } from '@vaubaan/plugin-sdk';

import { classifyStripe } from './classify.ts';
import { stripeDataModel } from './data-model.ts';
import { discoverStripeResources, executeStripe } from './execute.ts';
import { stripeTools } from './tools.ts';

// The YAML sits next to this module ; `catalogPathNextTo` keeps the path a
// filesystem path the bundler leaves alone (ADR plugin-catalog-path-and-standalone-tracing).
export const stripeCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

const KEY_HELP =
  'A restricted key (rk_…) limited to the objects you expect the agent to touch is preferable ' +
  'to the full secret key (sk_…).';

export const stripePlugin = definePlugin({
  id: 'stripe',
  displayName: 'Stripe',
  version: '0.2.0',
  description:
    'Billing operations on a Stripe account : catalog, customers, subscriptions, invoices, ' +
    'refunds, payouts, webhooks — test and live modes as separate resources.',
  docsUrl:
    'https://github.com/sbw-vaubaan/vaubaan-gateway/blob/main/docs/handbook/providers/stripe.md',
  tools: stripeTools,
  dataModel: stripeDataModel,
  catalog: stripeCatalog.catalog,
  credential: {
    kind: 'api-key',
    createUrl: 'https://dashboard.stripe.com/apikeys',
    fields: [
      {
        name: 'test_key',
        label: 'Test-mode key',
        secret: true,
        required: false,
        placeholder: 'sk_test_… or rk_test_…',
        pattern: '^(sk|rk)_test_[A-Za-z0-9]+$',
        help: `Key of the sandbox. Leave empty for a live-only connection. ${KEY_HELP}`,
      },
      {
        name: 'live_key',
        label: 'Live-mode key',
        secret: true,
        required: false,
        placeholder: 'sk_live_… or rk_live_…',
        pattern: '^(sk|rk)_live_[A-Za-z0-9]+$',
        help: `Key of the live account (real money). Leave empty for a test-only connection. ${KEY_HELP}`,
      },
    ],
  },
  classify: classifyStripe,
  execute: executeStripe,
  discoverResources: discoverStripeResources,
});

export default stripePlugin;

export { classifyStripe, stripeDataModel, stripeTools };
export { STRIPE_API_BASE, discoverStripeResources, executeStripe } from './execute.ts';
export {
  KEY_FIELD_BY_MODE,
  STRIPE_MODES,
  modeOf,
  resolveStripeResource,
  stripeResourceRef,
  type StripeMode,
} from './resources.ts';
