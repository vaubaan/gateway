import type { MissionService } from '../missions/mission-service';
/**
 * Requests to the creator: the inbox, the creator's
 * view of a claim or of an approval request, its decision and events, the
 * expiry sweeper, and the one builder of the request URL a refusal carries.
 *
 * Server-only barrel. Client components import the pure files directly
 * (`claim`, `approval`, `state`, `url`), never this index.
 * Handbook: docs/handbook/requests.md.
 */
import type { PluginRegistry } from '@vaubaan/plugin-sdk';

import type { Authenticator } from '../auth';
import type { MissionGrounds } from '../authority';
import type { RateLimiter } from '../compose/ports';
import type { InstanceConfig } from '../config';
import type { CeilingCheck } from '../limits';
import type { Logger } from '../logging';
import type { Store } from '../store';
import { systemClock, type Clock } from '../store/clock';
import { clientIpResolver } from './client-ip';
import { createRequestHandlers, type RequestHandlers } from './handlers';
import { RequestService } from './request-service';
import { startRequestSweeper, type RequestSweeper } from './sweeper';
import { requestUrlBuilder } from './url';

export interface RequestsModule {
  readonly service: RequestService;
  readonly handlers: RequestHandlers;
  readonly sweeper: RequestSweeper;
  /**
   * `<public_url>/r/<id>` — the `requestUrl` dependency of the budget's
   * `MissionLogService`: the URL in a refusal and the route that answers it
   * come from the same builder.
   */
  readonly requestUrl: (requestId: string) => string;
}

export interface RequestsModuleDeps {
  readonly missions?: Pick<MissionService, 'permissionOptions'>;
  readonly config: Pick<
    InstanceConfig,
    'publicUrl' | 'trustedProxies' | 'clientIpHeader' | 'approvals'
  >;
  readonly store: Store;
  readonly registry: PluginRegistry;
  /** Derives `orphaned` on every mission read (handbook authority). */
  readonly grounds: Pick<MissionGrounds, 'derive'>;
  readonly authenticator: Authenticator;
  readonly rateLimiter: RateLimiter;
  readonly logger: Logger;
  readonly clock?: Clock;
  /** Period of the expiry sweeper; defaults to `REQUEST_SWEEP_INTERVAL_MS`. */
  readonly sweepIntervalMs?: number;
  /** The `limits.active_missions` ceiling (`root.limits`); absent, none. */
  readonly ceilings?: CeilingCheck;
}

export function createRequestsModule(deps: RequestsModuleDeps): RequestsModule {
  const logger = deps.logger.child({ component: 'requests' });
  const service = new RequestService({
    missions: deps.missions,
    store: deps.store,
    registry: deps.registry,
    grounds: deps.grounds,
    publicUrl: deps.config.publicUrl,
    approvalValiditySeconds: deps.config.approvals.expirySeconds,
    clock: deps.clock ?? systemClock,
    logger,
    ceilings: deps.ceilings,
  });
  const handlers = createRequestHandlers({
    publicUrl: deps.config.publicUrl,
    authenticator: deps.authenticator,
    rateLimiter: deps.rateLimiter,
    clientIp: clientIpResolver(deps.config.trustedProxies, deps.config.clientIpHeader),
    service,
  });
  const sweeper = startRequestSweeper({
    sweep: () => service.sweep(),
    logger,
    intervalMs: deps.sweepIntervalMs,
  });
  return { service, handlers, sweeper, requestUrl: requestUrlBuilder(deps.config.publicUrl) };
}

export {
  APPROVAL_PROBLEM_CODES,
  APPROVAL_RESOLUTIONS,
  approvalOptions,
  checkApprovalDecision,
  formatDelay,
  parseApprovalDecision,
  type ApprovalDecision,
  type ApprovalOption,
  type ApprovalProblem,
  type ApprovalProblemCode,
  type ApprovalResolution,
  type ApprovalSituation,
  type ParsedApprovalDecision,
} from './approval';
export {
  checkClaimDecision,
  CLAIM_PROBLEM_CODES,
  CLAIM_RESOLUTIONS,
  claimOptions,
  formatUtc,
  parseClaimDecision,
  type ClaimDecision,
  type ClaimMissionState,
  type ClaimOption,
  type ClaimProblem,
  type ClaimProblemCode,
  type ClaimSituation,
  type ParsedClaimDecision,
} from './claim';
export { clientIpOf, clientIpResolver, trustedProxyList, UNKNOWN_CLIENT } from './client-ip';
export { describeEvent, eventLineOf, type MissionLogEventLine } from './events';
export {
  ADDRESSED_TO_CREATOR,
  createRequestHandlers,
  REQUEST_PAGE_RATE_LIMIT,
  REQUEST_PAGE_RATE_WINDOW_MS,
  type DecideProblemCode,
  type RequestHandlerDeps,
  type RequestHandlers,
} from './handlers';
export { askedBy, REFUSED_CALL_KIND, type AskedBy } from './asker';
export {
  RequestService,
  MISSION_LOG_EVENTS_SHOWN,
  type ApprovalCall,
  type ApprovalGateLine,
  type RequestAsker,
  type RequestCall,
  type RequestMissionView,
  type WaitingItem,
  type ApprovalView,
  type ClaimView,
  type DecideResult,
  type GrantedApproval,
  type RequestServiceDeps,
  type RequestSummary,
  type RequestView,
  type RiskBudgetLine,
  type TouchedRiskLine,
  type ViewResult,
} from './request-service';
export {
  effectiveState,
  isDecidable,
  isTerminal,
  nextState,
  type RequestTransition,
} from './state';
export {
  REQUEST_SWEEP_INTERVAL_MS,
  startRequestSweeper,
  type RequestSweeper,
  type RequestSweeperDeps,
} from './sweeper';
export {
  INBOX_PATH,
  inboxRequestPath,
  REQUEST_PATH_PREFIX,
  requestPath,
  requestUrl,
  requestUrlBuilder,
} from './url';
