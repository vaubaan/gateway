/**
 * Shares (spec §0 "Share", "Restriction"; §3.1; §4.2 "Shares received"; §7.3;
 * §7.8): the owner of a connection grants a user or a group an explicit list
 * of `RiskId`s. Built once by the composition root as `root.shares`.
 * Handbook: docs/handbook/authority.md.
 */
import type { PluginRegistry } from '@vaubaan/plugin-sdk';

import type { Authenticator } from '../auth/authenticator';
import type { MissionGrounds } from '../authority';
import type { InstanceConfig } from '../config/types';
import type { ConnectionsModule } from '../connections';
import type { Logger } from '../logging';
import type { Store } from '../store';
import { systemClock, type Clock } from '../store/clock';
import { createShareHandlers, type ShareHandlers } from './handlers';
import { ShareService } from './service';

export interface SharesModuleDeps {
  readonly config: Pick<InstanceConfig, 'publicUrl'>;
  readonly store: Store;
  readonly registry: PluginRegistry;
  readonly connections: Pick<ConnectionsModule, 'service' | 'notices'>;
  readonly grounds: Pick<MissionGrounds, 'watchConnection'>;
  readonly authenticator: Authenticator;
  readonly logger: Logger;
  readonly clock?: Clock;
}

export interface SharesModule {
  readonly service: ShareService;
  readonly handlers: ShareHandlers;
}

export function createSharesModule(deps: SharesModuleDeps): SharesModule {
  const logger = deps.logger.child({ component: 'shares' });
  const service = new ShareService({
    store: deps.store,
    registry: deps.registry,
    connections: deps.connections.service,
    grounds: deps.grounds,
    audit: deps.store.auditWriter,
    clock: deps.clock ?? systemClock,
    logger,
  });
  const handlers = createShareHandlers({
    publicUrl: deps.config.publicUrl,
    authenticator: deps.authenticator,
    shares: service,
    notices: deps.connections.notices,
    logger,
  });
  return { service, handlers };
}

export {
  isShareError,
  SHARE_ERROR_CODES,
  SHARE_ERROR_MESSAGES,
  ShareError,
  type ShareErrorCode,
} from './errors';
export { createShareHandlers, SHARE_FIELDS, sharePath, type ShareHandlers } from './handlers';
export {
  envNotes,
  groupBySeverity,
  selectAllIds,
  SEVERITY_ORDER,
  summarizeRestriction,
  type EnvLabelling,
  type SeverityGroup,
} from './restriction';
export {
  labellingOf,
  ShareService,
  unshareableReason,
  type ReceivedRisk,
  type ReceivedShare,
  type RevokeOutcome,
  type ShareContext,
  type ShareInput,
  type ShareOutcome,
  type ShareServiceDeps,
  type ShareTargetInput,
  type ShareView,
  type UnshareableReason,
} from './service';
