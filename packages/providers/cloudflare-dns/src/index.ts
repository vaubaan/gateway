/**
 * Cloudflare DNS provider package — v4 risk-based modelling.
 *
 * Exposes the data-model + risk catalog + classifier needed by the
 * web/risk-catalog loader and the policy-engine runtime.
 *
 * Runtime artifacts (adapter, execute, tools) are out of scope for the
 * risk-based modelling phase. They will be added when the Cloudflare DNS
 * runtime is implemented.
 */

// v4 risk-based exports
export { dataModel as cloudflareDnsDataModel } from './data-model.ts';
export { cloudflareDnsRiskCatalog } from './risk-catalog.ts';
export { classifyCloudflareDnsV4 } from './risk-classifier.ts';
export type { ClassifyResult as CloudflareDnsClassifyV4Result } from './risk-classifier.ts';
