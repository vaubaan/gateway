/**
 * Budget, mission log and decision core.
 *
 * Pure pieces (`decide`, period arithmetic, fingerprint, mission state) and their
 * store-backed executor (`MissionLogService`), the pipeline's `BudgetStage` adapter and
 * the counters-vs-audit structural check.
 * Handbook: docs/handbook/budget-and-mission-logs.md. ADR: docs/decisions/atomic-budget-accounting.md.
 */
export { BudgetInvariantError } from './errors.ts';
export {
  currentPeriod,
  periodIndex,
  periodSpecOf,
  type CurrentPeriod,
  type PeriodSpec,
} from './period.ts';
export { canonicalJson, fingerprintArguments } from './fingerprint.ts';
export {
  combineSetDecisions,
  decide,
  distinctRisks,
  type Allow,
  type AllowAcrossSets,
  type BudgetLine,
  type BudgetOutcomeAcrossSets,
  type RefuseAcrossSets,
  type SetDecision,
  type ApprovalToConsume,
  type BudgetOutcome,
  type BudgetRefusalCode,
  type DecideInput,
  type RateProbe,
  type Refuse,
} from './decide.ts';
export {
  effectiveGate,
  GATE_EVENT_KINDS,
  openedGatesOf,
  openedInSet,
  type GateEventLike,
} from './gates.ts';
export {
  consumedInPeriod,
  deriveMissionState,
  type MissionState,
  type MissionStateInput,
  type PeriodCounter,
} from './mission-state.ts';
export {
  budgetMissionOf,
  budgetPeriodOf,
  isStale,
  periodOf,
  policyEntryOf,
  policyEntryRecordOf,
  policyLineInputOf,
  resourceSetLabelOf,
  missionLogCounterOf,
  statedPeriodOf,
  type BudgetMission,
  type BudgetResourceSet,
  type StatedPeriod,
} from './mapping.ts';
export {
  missionUsageReader,
  readMissionUsage,
  type MissionUsage,
  type MissionUsageReader,
  type MissionUsageLogs,
} from './mission-usage.ts';
export {
  livePolicy,
  MissionLogService,
  type RecordCallAllowed,
  type RecordCallInput,
  type RecordCallRefused,
  type RecordCallResult,
  type MissionLogServiceDeps,
} from './mission-log-service.ts';
export { createBudgetStage, type BudgetStageDeps } from './budget-stage.ts';
export {
  PERIOD_STATE_EVENT_KINDS,
  MissionLogRetention,
  type MissionLogPurge,
  type MissionLogRetentionDeps,
} from './retention.ts';
export {
  countersAgreeWithAudit,
  CREDIT_EVENT_KINDS,
  type ConsistencyDeps,
  type CounterAuditLine,
  type CounterAuditMismatch,
  type CounterAuditReport,
} from './consistency.ts';
