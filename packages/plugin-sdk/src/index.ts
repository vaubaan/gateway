/**
 * `@vaubaan/plugin-sdk` — everything a provider plugin needs, and nothing
 * from the gateway application.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5 (plugins), §3.2 (presets), §10
 *        (structural tests) ; docs/spec/gateway-risk-model.md §7.
 * ADR  : docs/decisions/plugin-contract-and-credential-spec.md.
 * Handbook : docs/handbook/plugin-sdk.md.
 *
 * A plugin imports this package (and, transitively, `@vaubaan/shared` and
 * `@vaubaan/policy-engine`) ; it never imports `@vaubaan/gateway-core` or
 * `apps/gateway`. The host builds one `PluginRegistry` from the plugins it
 * ships — the single provider list every other list derives from.
 */

export * from './plugin.ts';
export * from './credential.ts';
export * from './catalog-loader.ts';
export * from './catalog-path.ts';
export * from './arguments.ts';
export * from './slices.ts';
export * from './refusal.ts';
export * from './env-of.ts';
export * from './define-plugin.ts';
export * from './registry.ts';
export * from './flags.ts';
export * from './streaming.ts';

// Re-exported so a plugin can import its whole vocabulary from one place.
export type {
  DataModel,
  DataModelCardinality,
  DataModelEntity,
  DataModelPlane,
  McpToolContent,
  McpToolDeclaration,
  McpToolResult,
  Preset,
  PresetEntry,
  Resource,
  RiskCatalog,
  RiskEntry,
  RiskId,
  RiskVector,
  ScopeCaps,
  Slice,
  SliceAction,
  SliceSegment,
} from '@vaubaan/shared';
export {
  UpstreamAuthError,
  UpstreamHttpError,
  toolPrefixFor,
  validateDataModel,
} from '@vaubaan/shared';
export { parseSlice, serializeSlice } from '@vaubaan/policy-engine';
