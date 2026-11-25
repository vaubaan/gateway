/**
 * Audit: the Audit page's search, the Mission log page's
 * view, the retention sweeper. Read-only over the store, apart from the
 * purge.
 * Handbook: docs/handbook/audit.md.
 */
import { MissionLogRetention } from '../budget/retention';
import type { CredentialKind } from '@vaubaan/shared';

import type { InstanceConfig } from '../config';
import type { Logger } from '../logging';
import type { MissionService } from '../missions';
import type { Store } from '../store';
import { systemClock, type Clock } from '../store/clock';
import { AuditQueryService } from './query-service';
import { AuditRetentionSweeper, type SweepTimers } from './retention';
import { MissionLogViewService } from './mission-log-view';
import { ActivityOverviewService } from './overview';
import { ActivityTimelineService } from './timeline';

export interface AuditModule {
  readonly query: AuditQueryService;
  readonly missionLogs: MissionLogViewService;
  readonly timeline: ActivityTimelineService;
  readonly overview: ActivityOverviewService;
  readonly retention: AuditRetentionSweeper;
}

export interface AuditModuleDeps {
  readonly config: Pick<InstanceConfig, 'retentionDays'>;
  readonly store: Store;
  readonly missions: Pick<MissionService, 'get' | 'standing'>;
  /** The kind of credential a service's plugin takes first (Overview: a pasted key's expiry). */
  readonly credentialKindOf: (service: string) => CredentialKind | null;
  readonly logger: Logger;
  readonly clock?: Clock;
  readonly sweepIntervalMs?: number;
  readonly timers?: SweepTimers;
}

export function createAuditModule(deps: AuditModuleDeps): AuditModule {
  const clock = deps.clock ?? systemClock;
  return {
    query: new AuditQueryService({ store: deps.store }),
    missionLogs: new MissionLogViewService({
      store: deps.store,
      missions: deps.missions,
      clock,
    }),
    timeline: new ActivityTimelineService({ store: deps.store, clock }),
    overview: new ActivityOverviewService({
      store: deps.store,
      missions: deps.missions,
      credentialKindOf: deps.credentialKindOf,
      clock,
    }),
    retention: new AuditRetentionSweeper({
      audit: deps.store.audit,
      missionLogHistory: new MissionLogRetention({
        missionLogs: deps.store.missionLogs,
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
  ActivityOverviewService,
  DEFAULT_OVERVIEW_PERIOD,
  EXPIRING_SOON_DAYS,
  OVERVIEW_PARAMS,
  OVERVIEW_PERIODS,
  parseOverviewPeriod,
  sinceOf,
  totalsByMission,
  type ActivityOverview,
  type ActivityOverviewDeps,
  type OverviewAccount,
  type OverviewCounts,
  type OverviewExpiry,
  type OverviewHolder,
  type OverviewLine,
  type OverviewMission,
  type OverviewPeriod,
} from './overview';
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
  MissionLogViewService,
  parseHolderParam,
  PAST_PERIODS_SHOWN,
  type MissionLogViewDeps,
  type MissionLogView,
  type MissionLogEventView,
  type MissionLogHolderActivity,
  type MissionLogHolderRef,
  type MissionLogHolderView,
  type MissionLogLabelActivity,
  type MissionLogOpenRequest,
  type MissionLogPeriodRow,
  type MissionLogRiskRow,
} from './mission-log-view';
