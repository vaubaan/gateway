/**
 * `@vaubaan/shared` — types and pure helpers shared by every package.
 *
 * Spec : docs/spec/vaubaan-gateway.md §0 (vocabulary), §2 (domain), §4.1
 *        (refusal codes) ; docs/spec/gateway-risk-model.md (risk model).
 * ADR  : docs/decisions/plugin-contract-and-credential-spec.md.
 *
 * No IO, no framework import, except `api-key.ts` (argon2, node:crypto),
 * which makes this barrel server-only. Browser code and the packages the
 * UI bundles (`@vaubaan/policy-engine`) import values from the subpaths
 * `@vaubaan/shared/risk-id` and `@vaubaan/shared/api-key` instead ; type
 * imports from the barrel are erased and always safe.
 *
 * The legacy v4 row types stay reachable from this barrel until the last
 * plugin migrates (feature P1.2) ; see `legacy-v4.ts` for the list and the
 * removal rule.
 */

export * from './mcp.ts';
export * from './api-key.ts';
export * from './risk.ts';
export * from './risk-id.ts';
export * from './refusal.ts';
export * from './domain.ts';
export * from './data-model.ts';
export * from './legacy-v4.ts';
