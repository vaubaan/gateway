/**
 * Canonical argument fingerprint — re-exported from `@vaubaan/gateway-core`, where the
 * pipeline uses it for the audit entry's `arguments_hash` (one hash everywhere: audit,
 * approval requests, approvals, the `approval-required` refusal).
 */
export { canonicalJson, fingerprintArguments } from '@vaubaan/gateway-core';
