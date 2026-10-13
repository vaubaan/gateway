/**
 * Budget, session and decision core (feature P1.3).
 *
 * Pure pieces (`decide`, period arithmetic, fingerprint, mission state) and their
 * store-backed executor (`SessionService`), the pipeline's `BudgetStage` adapter and
 * the counters-vs-audit structural check.
 * Handbook: docs/handbook/budget-and-sessions.md. ADR: docs/decisions/atomic-budget-accounting.md.
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
  decide,
  distinctRisks,
  type Allow,
  type ApprovalToConsume,
  type BudgetOutcome,
  type BudgetRefusalCode,
  type DecideInput,
  type RateProbe,
  type Refuse,
} from './decide.ts';
export {
  consumedInPeriod,
  deriveMissionState,
  type MissionState,
  type MissionStateInput,
  type PeriodCounter,
} from './mission-state.ts';
export { budgetMissionOf, policyEntryOf, sessionCounterOf, type BudgetMission } from './mapping.ts';
export {
  SessionService,
  type RecordCallAllowed,
  type RecordCallInput,
  type RecordCallRefused,
  type RecordCallResult,
  type SessionServiceDeps,
} from './session-service.ts';
export { createBudgetStage, type BudgetStageDeps } from './budget-stage.ts';
export {
  countersAgreeWithAudit,
  CREDIT_EVENT_KINDS,
  type ConsistencyDeps,
  type CounterAuditLine,
  type CounterAuditMismatch,
  type CounterAuditReport,
} from './consistency.ts';
