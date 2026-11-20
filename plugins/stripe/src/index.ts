/**
 * `@vaubaan/plugin-stripe` — Stripe billing for SaaS operators, on the v5 SDK.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7.
 * ADR  : docs/decisions/plugin-contract-and-credential-spec.md.
 * Handbook : docs/handbook/services/stripe.md ; guide : plugins/stripe/README.md.
 *
 * Credential : `api-key` with two optional secret fields, the test-mode key
 * and the live-mode key (`credential.ts`). Each key present yields one resource
 * (`acct_123/test`, `acct_123/live`) whose `env` is the mode, so env-scoped
 * risks resolve as `stripe[live].refund-create`. The YAML catalog is loaded
 * here, once, at import (that is, at gateway boot).
 */

import { catalogPathNextTo, definePlugin, loadCatalogFile } from '@vaubaan/plugin-sdk';

import { classifyStripe } from './classify.ts';
import { stripeCredential } from './credential.ts';
import { stripeDataModel } from './data-model.ts';
import { discoverStripeResources, executeStripe } from './execute.ts';
import { SERVICE_ID } from './identity.ts';
import { STRIPE_ICON, STRIPE_ICON_COLOR } from './icon.ts';
import { stripeToolTitles } from './tool-titles.ts';
import { stripeTools } from './tools.ts';
import { stripeExamples } from './examples.ts';

// The YAML sits next to this module ; `catalogPathNextTo` keeps the path a
// filesystem path the bundler leaves alone (docs/handbook/plugin-sdk.md).
export const stripeCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

export const stripePlugin = definePlugin({
  id: SERVICE_ID,
  displayName: 'Stripe',
  icon: STRIPE_ICON,
  iconColor: STRIPE_ICON_COLOR,
  resourceNoun: { one: 'mode', other: 'modes' },
  version: '0.5.2',
  description:
    'Billing operations on a Stripe account : catalog, customers, subscriptions, invoices, ' +
    'refunds, payouts, webhooks — test and live modes as separate resources.',
  summary:
    'One account is one Stripe account, given as a test key, a live key, or both; each mode is its own resource, labelled test or live by the plugin. Every permission is held per mode, so a mission can work freely in test mode and touch live billing only within its limits and after your yes.',
  manualRevocation:
    'Delete or roll the API key in the Stripe Dashboard, under Developers, API keys.',
  docsUrl: 'https://github.com/vaubaan/gateway/blob/main/docs/handbook/services/stripe.md',
  tools: stripeTools,
  toolTitles: stripeToolTitles,
  examples: stripeExamples,
  dataModel: stripeDataModel,
  catalog: stripeCatalog.catalog,
  credential: stripeCredential,
  classify: classifyStripe,
  execute: executeStripe,
  discoverResources: discoverStripeResources,
});

export default stripePlugin;

export { classifyStripe, stripeDataModel, stripeTools };
export { STRIPE_KEYS_PAGE, stripeCredential, verifyStripeKeys } from './credential.ts';
export { SERVICE_ID, STRIPE_API_BASE, TOOL, TOOL_PREFIX } from './identity.ts';
export {
  discoverStripeResources,
  executeStripe,
  stripeAccounts,
  type StripeAccount,
} from './execute.ts';
export {
  KEY_FIELD_BY_MODE,
  STRIPE_ACCOUNT_REF,
  STRIPE_ID,
  STRIPE_MODES,
  modeOf,
  resolveStripeResource,
  stripeAccountRef,
  stripeId,
  stripeResourceRef,
  type StripeMode,
} from './resources.ts';
export { EXAMPLE_LIVE_MODE, EXAMPLE_TEST_MODE, stripeExamples } from './examples.ts';
