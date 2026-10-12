/**
 * Cloudflare DNS provider package — v4 risk-based modelling + runtime.
 *
 * Exposes the data-model + risk catalog + classifier needed by the
 * web/risk-catalog loader and the policy-engine runtime, plus the runtime
 * adapter + execute + tools.ts that fan out to the Cloudflare REST API.
 */

// Runtime exports
export { CloudflareDnsAdapter } from './cloudflare-dns-adapter.ts';
export { availableTools as cloudflareDnsAvailableTools } from './tools.ts';
export { executeCall as cloudflareDnsExecuteCall } from './execute.ts';

// v4 risk-based exports
export { dataModel as cloudflareDnsDataModel } from './data-model.ts';
export { cloudflareDnsRiskCatalog } from './risk-catalog.ts';
export { classifyCloudflareDnsV4 } from './risk-classifier.ts';
export type { ClassifyResult as CloudflareDnsClassifyV4Result } from './risk-classifier.ts';
