/**
 * Resend provider package — v4 risk-based modelling + runtime.
 *
 * Exposes the data-model + risk catalog + classifier needed by the
 * web/risk-catalog loader and the policy-engine runtime, plus the runtime
 * adapter + execute + tools.ts that fan out to the Resend REST API.
 */

// Runtime exports
export { ResendAdapter } from './resend-adapter.ts';
export { availableTools as resendAvailableTools } from './tools.ts';
export { executeCall as resendExecuteCall } from './execute.ts';

// v4 risk-based exports
export { dataModel as resendDataModel } from './data-model.ts';
export { resendRiskCatalog } from './risk-catalog.ts';
export { classifyResendV4 } from './risk-classifier.ts';
export type { ClassifyResult as ResendClassifyV4Result } from './risk-classifier.ts';
