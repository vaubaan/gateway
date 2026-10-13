/**
 * Audit (feature P1.8): the Audit page's search, the Mission session page's
 * view, the retention sweeper. Read-only over the store, apart from the
 * purge.
 * Handbook: docs/handbook/audit.md.
 */
import { SessionHistoryRetention } from '../budget/retention';
import type { InstanceConfig } from '../config';
import type { Logger } from '../logging';
import type { MissionService } from '../missions';
import type { Store } from '../store';
import { systemClock, type Clock } from '../store/clock';
import { AuditQueryService } from './query-service';
import { AuditRetentionSweeper, type SweepTimers } from './retention';
import { MissionSessionService } from './session-view';

export interface AuditModule {
  readonly query: AuditQueryService;
  readonly sessions: MissionSessionService;
  readonly retention: AuditRetentionSweeper;
}

export interface AuditModuleDeps {
  readonly config: Pick<InstanceConfig, 'retentionDays'>;
  readonly store: Store;
  readonly missions: Pick<MissionService, 'get'>;
  readonly logger: Logger;
  readonly clock?: Clock;
  readonly sweepIntervalMs?: number;
  readonly timers?: SweepTimers;
}

export function createAuditModule(deps: AuditModuleDeps): AuditModule {
  const clock = deps.clock ?? systemClock;
  return {
    query: new AuditQueryService({ store: deps.store }),
    sessions: new MissionSessionService({
      store: deps.store,
      missions: deps.missions,
      clock: deps.clock ?? systemClock,
    }),
    retention: new AuditRetentionSweeper({
      audit: deps.store.audit,
      sessionHistory: new SessionHistoryRetention({
        sessions: deps.store.sessions,
        missions: deps.store.missions,
        clock,
      }),
      retentionDays: deps.config.retentionDays,
      logger: deps.logger.child({ component: 'audit' }),
      intervalMs: deps.sweepIntervalMs,
      timers: deps.timers,
    }),
  };
}

export {
  AUDIT_DECISIONS,
  AUDIT_KINDS,
  AUDIT_PARAMS,
  auditQueryString,
  decodeCursor,
  encodeCursor,
  parseAuditQuery,
  parseInstant,
  type AuditFilters,
  type AuditKind,
  type AuditParam,
  type ParsedAuditQuery,
  type RawQuery,
} from './filters';
export {
  ARGUMENTS_NOT_SHOWN,
  AUDIT_PAGE_SIZE,
  AuditQueryService,
  BOOTSTRAP_ACTOR_ID,
  scopeOf,
  standingOn,
  withoutArguments,
  type AuditAdminView,
  type AuditCallView,
  type AuditConnectionRef,
  type AuditEntryView,
  type AuditFilterOptions,
  type AuditMissionRef,
  type AuditPage,
  type AuditQueryDeps,
  type AuditTokenRef,
  type AuditStanding,
  type AuditViewer,
} from './query-service';
export {
  AuditRetentionSweeper,
  RETENTION_SWEEP_INTERVAL_MS,
  type RetentionSweeperDeps,
  type SweepTimers,
} from './retention';
export {
  ALL_EVENTS,
  eventView,
  holderParam,
  MissionSessionService,
  parseHolderParam,
  PAST_PERIODS_SHOWN,
  SESSION_EVENTS_PAGE_SIZE,
  type MissionSessionDeps,
  type MissionSessionView,
  type SessionEventView,
  type SessionHolderActivity,
  type SessionHolderRef,
  type SessionHolderView,
  type SessionLabelActivity,
  type SessionTimelineFilter,
  type SessionOpenRequest,
  type SessionPeriodRow,
  type SessionRiskRow,
} from './session-view';
export { eventDetailLines, isSessionEventKind, type EventDetailLine } from './session-event-detail';
