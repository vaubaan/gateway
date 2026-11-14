/**
 * Audit: the Audit page's search, the Mission session page's
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
import { ActivityTimelineService } from './timeline';

export interface AuditModule {
  readonly query: AuditQueryService;
  readonly sessions: MissionSessionService;
  readonly timeline: ActivityTimelineService;
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
      clock,
    }),
    timeline: new ActivityTimelineService({ store: deps.store, clock }),
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
  type AuditAccountRef,
  type AuditEntryView,
  type AuditFilterOptions,
  holdersOf,
  type AuditMissionRef,
  type AuditPage,
  type AuditQueryDeps,
  type AuditTokenRef,
  type AuditStanding,
  type AuditViewer,
} from './query-service';
export {
  keysetOf,
  PAGE_PARAMS,
  pageOf,
  parsePage,
  type PagePosition,
  type Paged,
  type ParsedPage,
} from './paging';
export {
  ActivityTimelineService,
  eventScopeOf,
  NO_TIMELINE_FILTER,
  parseTimelineQuery,
  TIMELINE_PAGE_SIZE,
  TIMELINE_PARAMS,
  timelineQueryString,
  type ActivityTimelineDeps,
  type ParsedTimelineQuery,
  type TimelineEventView,
  type TimelineFilters,
  type TimelineMissionRef,
  type TimelineOpenRequest,
  type TimelinePage,
} from './timeline';
export {
  AuditRetentionSweeper,
  RETENTION_SWEEP_INTERVAL_MS,
  type RetentionSweeperDeps,
  type SweepTimers,
} from './retention';
export {
  eventView,
  holderParam,
  LATEST_EVENTS,
  MissionSessionService,
  parseHolderParam,
  PAST_PERIODS_SHOWN,
  type MissionSessionDeps,
  type MissionSessionView,
  type SessionEventView,
  type SessionHolderActivity,
  type SessionHolderRef,
  type SessionHolderView,
  type SessionLabelActivity,
  type SessionOpenRequest,
  type SessionPeriodRow,
  type SessionRiskRow,
} from './session-view';
