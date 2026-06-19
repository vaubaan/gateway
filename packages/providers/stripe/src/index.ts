/**
 * Stripe provider package — v4 risk-based modelling.
 *
 * Exposes the data-model + risk catalog + classifier needed by the
 * web/risk-catalog loader and the policy-engine runtime. Adapter / execute /
 * tools.ts (the MCP wire that fans out to the Stripe REST v1) is out of
 * scope for the provider-modeler skill and will be added by the coding
 * agent who picks this provider up after the modelling pass (cf. handbook
 * §"Reste à faire").
 */

// v4 risk-based exports
export { dataModel as stripeDataModel } from './data-model.ts';
export { stripeRiskCatalog } from './risk-catalog.ts';
export { classifyStripeV4 } from './risk-classifier.ts';
export type { ClassifyResult as StripeClassifyV4Result } from './risk-classifier.ts';
