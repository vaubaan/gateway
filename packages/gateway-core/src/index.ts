/**
 * @vaubaan/gateway-core — the v5 decision core, refusal model, audit shape
 * and pipeline skeleton. No transport, no store, no service: those are the
 * execution door (`apps/gateway/src/server/execution`), the embedded store and the plugins.
 */

// The public API, named: what the other packages and the applications import.
// A name missing here is internal to the package (structural test: no `export *`).
export { acceptedRisksOf, REFUSAL_CODES, tokenAttributionOf, tokenHolderLabel } from './types.ts';
export type {
  AuthenticatedToken,
  BearerKind,
  AccountLoss,
  AccountOwner,
  AccountStatus,
  MissionAccount,
  MissionContext,
  MissionResource,
  MissionResourceSet,
  TokenHolder,
} from './types.ts';
export {
  AUTH_FAILURE_MESSAGES,
  AUTH_FAILURE_REASONS,
  AUTH_REQUIRED_HTTP_STATUS,
  AUTH_REQUIRED_RPC_CODE,
  AuthError,
  isRefusal,
  isUnavailableAccountStatus,
  REFUSAL_RPC_CODE,
  refusalToRpcError,
  refuse,
  rpcError,
} from './errors.ts';
export type { AuthFailureReason, Refusal } from './errors.ts';
export {
  BOOTSTRAP_ACTOR_ID,
  BOOTSTRAP_ACTOR_LABEL,
  CONFIGURATION_ACTOR_ID,
  CONFIGURATION_ACTOR_LABEL,
  MemoryAuditWriter,
  RECOVERY_ACTOR_ID,
  RECOVERY_ACTOR_LABEL,
  SCHEDULE_ACTOR_ID,
  SCHEDULE_ACTOR_LABEL,
  DISCOVERY_ACTOR_ID,
  DISCOVERY_ACTOR_LABEL,
} from './audit.ts';
export type {
  AdminAct,
  AdminAuditEntry,
  AdminObjectType,
  AuditDecision,
  AuditEntry,
  AuditWriter,
  CallAuditEntry,
} from './audit.ts';
export { canonicalJson, fingerprintArguments } from './fingerprint.ts';
export { MemoryCacheClient } from './cache.ts';
export type { CacheClient } from './cache.ts';
export {
  candidateResourceSets,
  evaluateCallForMission,
  evaluateCallForResourceSets,
  resourceSetsLabel,
} from './risk-gateway.ts';
export type { CallVerdict, ResourceSetToJudge } from './risk-gateway.ts';
export {
  callAuditBase,
  CallPipeline,
  checkDoor,
  checkMissionActive,
  DoorAuthenticator,
  parseBearer,
  isUpstreamFailureError,
  isUpstreamRefusalError,
  upstreamErrorClassName,
  UpstreamFailureError,
  UpstreamRefusalError,
} from './pipeline.ts';
export type {
  BudgetDecision,
  BudgetInput,
  BudgetStage,
  CallOutcome,
  CallPipelineDeps,
  CallRequest,
  CallTarget,
  ClientOrigin,
  CredentialResolver,
  MissingLine,
  ResolvedCredential,
  ResourceResolution,
  ResourceStage,
  RiskStage,
  UpstreamStage,
} from './pipeline.ts';
export { jsonBytes, jsonMeter, requestBytesOf } from './bytes.ts';
export type { CallBytes, CallMeter } from './bytes.ts';
