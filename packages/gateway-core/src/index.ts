/**
 * @vaubaan/gateway-core — the v5 decision core, refusal model, audit shape
 * and pipeline skeleton. No transport, no store, no provider: those are the
 * execution door (`apps/gateway/src/server/execution`), the embedded store and the plugins.
 */

// The public API, named: what the other packages and the applications import.
// A name missing here is internal to the package (structural test: no `export *`).
export { acceptedRisksOf, REFUSAL_CODES, tokenAttributionOf, tokenHolderLabel } from './types.ts';
export type {
  AuthenticatedToken,
  BearerKind,
  ConnectionLoss,
  ConnectionOwner,
  ConnectionStatus,
  DelegationContext,
  MissionConnection,
  MissionContext,
  MissionResource,
  TokenHolder,
} from './types.ts';
export {
  AUTH_FAILURE_MESSAGES,
  AUTH_FAILURE_REASONS,
  AUTH_REQUIRED_HTTP_STATUS,
  AUTH_REQUIRED_RPC_CODE,
  AuthError,
  isRefusal,
  isUnavailableConnectionStatus,
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
export { evaluateCallForMission } from './risk-gateway.ts';
export type { CallVerdict } from './risk-gateway.ts';
export {
  callAuditBase,
  CallPipeline,
  checkDoor,
  checkMissionActive,
  DoorAuthenticator,
  parseBearer,
  upstreamErrorClassName,
  UpstreamFailureError,
  UpstreamRefusalError,
} from './pipeline.ts';
export type {
  BudgetDecision,
  BudgetStage,
  CallOutcome,
  CallPipelineDeps,
  CallRequest,
  CallTarget,
  ClientOrigin,
  CredentialResolver,
  ResolvedCredential,
  ResourceResolution,
  ResourceStage,
  RiskStage,
  UpstreamStage,
} from './pipeline.ts';
