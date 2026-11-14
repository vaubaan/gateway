/**
 * `@vaubaan/shared` — types and pure helpers shared by every package.
 *
 * Spec : docs/spec/vaubaan-gateway.md §0 (vocabulary), §2 (domain), §4.1
 *        (refusal codes) ; docs/spec/gateway-risk-model.md (risk model).
 * ADR  : docs/decisions/plugin-contract-and-credential-spec.md.
 *
 * No IO, no framework import, except `api-key.ts` (node:crypto),
 * which makes this barrel server-only. Browser code and the packages the
 * UI bundles (`@vaubaan/policy-engine`) import values from the subpaths
 * `@vaubaan/shared/risk-id`, `@vaubaan/shared/domain` (closed sets and
 * their guards : `GATES`, `isGate`…), `@vaubaan/shared/time` and `@vaubaan/shared/api-key`
 * instead ; type imports from the barrel are erased and always safe.
 */

// The public API, named: what the other packages and the applications import.
// A name missing here is internal to the package (structural test: no `export *`).
export {
  CredentialRefusal,
  isCredentialRefusal,
  isUpstreamAuthError,
  isUpstreamHttpError,
  splitToolName,
  toolPrefixFor,
  UpstreamAuthError,
  UpstreamHttpError,
} from './mcp.ts';
export { brandError, errorBrand, hasErrorBrand } from './brand.ts';
export {
  isAdvisorySubject,
  isSemverVersion,
  isVersionsFeed,
  isVersionsFeedAdvisory,
  VERSIONS_FEED_LIMITS,
  VERSIONS_FEED_SCHEMA,
} from './versions-feed.ts';
export type { AdvisorySubject, VersionsFeed, VersionsFeedAdvisory } from './versions-feed.ts';
export type {
  JsonRpcError,
  JsonRpcSuccess,
  McpToolContent,
  McpToolDeclaration,
  McpToolResult,
} from './mcp.ts';
export {
  API_KEY_PATTERN,
  apiKeyMatchesDigest,
  digestApiKey,
  generateApiKey,
  parseApiKey,
} from './api-key.ts';
export { RISK_VECTOR_AXES } from './risk.ts';
export type {
  InfraLimits,
  MacroAction,
  MacroActionEntry,
  RiskCatalog,
  RiskDecision,
  RiskEntry,
  RiskId,
  RiskVector,
  ScopeCaps,
  Slice,
  SliceAction,
  SliceSegment,
} from './risk.ts';
export {
  baseRiskId,
  ENV_LABEL_PATTERN,
  formatRiskId,
  isExplicitRiskId,
  isProviderId,
  isRiskId,
  parseRiskId,
  WILDCARD_CHARS,
} from './risk-id.ts';
export { isRefusalCode, REFUSAL_CODES } from './refusal.ts';
export type { RefusalCode } from './refusal.ts';
export {
  acceptedRisksOf,
  CREDENTIAL_KINDS,
  GATES,
  isCredentialKind,
  isGate,
  isMissionTokenKind,
  lineKeyOf,
  MISSION_TOKEN_KINDS,
  policyLineKey,
} from './domain.ts';
export type {
  AuditDecision,
  Budget,
  ClaimResolution,
  Account,
  AccountResource,
  AccountStatus,
  CredentialKind,
  Gate,
  GroupSource,
  Iso8601,
  Mission,
  MissionPolicy,
  MissionPolicyEntry,
  MissionStatus,
  MissionTokenKind,
  Period,
  PolicyLineKey,
  Principal,
  RateLimit,
  RequestKind,
  RequestStatus,
  Resource,
  Session,
  SessionCounter,
  SessionEventKind,
  ShareStatus,
  TokenAttribution,
} from './domain.ts';
export { parseEventDetails } from './session-events.ts';
export type {
  ApprovalEventDetails,
  CallAllowedEventDetails,
  CallRefusedEventDetails,
  ExtensionEventDetails,
  GateChangedEventDetails,
  GateOpenedEventDetails,
  MissionChangedEventDetails,
  RequestClosedState,
  RequestEventDetails,
  RevocationEventDetails,
  RotationEventDetails,
  SessionEventDetails,
} from './session-events.ts';
export { validateDataModel } from './data-model.ts';
export type {
  DataModel,
  DataModelCardinality,
  DataModelEntity,
  DataModelPlane,
} from './data-model.ts';
export { matchWildcard, WILDCARD_ANY, WILDCARD_ONE, wildcardLiteral } from './wildcard.ts';
export type { WildcardToken } from './wildcard.ts';
