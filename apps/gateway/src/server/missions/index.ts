/**
 * Missions: authority-bounded issuance, macro-actions at a trust level, resource
 * selection, token mint / rotate / revoke, bootstrap kit; and the members and
 * per-holder tokens of a mission (`team`).
 *
 * Server-only barrel (`node:crypto` through `token.ts`). Client components import
 * the pure files directly — `model`, `catalog-view`, `preview`, `summary` —
 * never this index.
 * Handbook: docs/handbook/missions.md.
 */
import type { PluginRegistry } from '@vaubaan/plugin-sdk';

import type { Authenticator } from '../auth';
import { AccountAuthorityService, type AuthorityService, type MissionGrounds } from '../authority';
import type { MissionLogService } from '../budget';
import type { InstanceConfig } from '../config';
import type { CeilingCheck } from '../limits';
import type { Logger } from '../logging';
import type { Store } from '../store';
import { systemClock, type Clock } from '../store/clock';
import { createMissionHandlers, type MissionHandlers } from './handlers';
import { MissionService } from './mission-service';
import { createTeamHandlers, type TeamHandlers } from './team-handlers';
import { MissionTeamService } from './team-service';
import type { TokenMinter } from './token';
import type { NotificationEvents } from '../notifications/events';

export interface MissionsModule {
  readonly authority: AuthorityService;
  readonly service: MissionService;
  /** Members and tokens of a mission (spec §7.9 bis). */
  readonly team: MissionTeamService;
  /** The handlers of `/api/missions/**`: the mission's own and its team's, one table. */
  readonly handlers: MissionHandlers & TeamHandlers;
}

export interface MissionsModuleDeps {
  readonly config: Pick<InstanceConfig, 'publicUrl' | 'selfResources'> &
    Partial<Pick<InstanceConfig, 'trustRaise'>>;
  readonly store: Store;
  readonly registry: PluginRegistry;
  readonly authenticator: Authenticator;
  readonly logger: Logger;
  /** The gateway's version (`BuildInfo.version`), for what it hands to an agent; absent in a test. */
  readonly version?: string;
  /** Defaults to a `AccountAuthorityService` over the store; the root injects its own. */
  readonly authority?: AuthorityService;
  /** Derives `orphaned` on every mission read (handbook authority). */
  readonly grounds: Pick<MissionGrounds, 'inspect'>;
  readonly clock?: Clock;
  readonly mint?: TokenMinter;
  /** The budget's state read; defaults to the same read over `store.missionLogs`. */
  readonly budget?: Pick<MissionLogService, 'stateOf'>;
  /** The `limits.active_missions` ceiling (`root.limits`); absent, none. */
  readonly ceilings?: CeilingCheck;
  /** Told of a mission revoked by someone other than its creator; default: nobody. */
  readonly notifications?: Pick<NotificationEvents, 'missionRevoked'>;
}

export function createMissionsModule(deps: MissionsModuleDeps): MissionsModule {
  const authority =
    deps.authority ??
    new AccountAuthorityService({
      registry: deps.registry,
      users: deps.store.users,
      groups: deps.store.groups,
      accounts: deps.store.accounts,
      shares: deps.store.shares,
    });
  const service = new MissionService({
    store: deps.store,
    registry: deps.registry,
    authority,
    grounds: deps.grounds,
    publicUrl: deps.config.publicUrl,
    selfResources: deps.config.selfResources,
    clock: deps.clock ?? systemClock,
    logger: deps.logger.child({ component: 'missions' }),
    mint: deps.mint,
    budget: deps.budget,
    ceilings: deps.ceilings,
    trustRaiseAfterApprovals: deps.config.trustRaise?.afterApprovals,
    notifications: deps.notifications,
  });
  const team = new MissionTeamService({
    store: deps.store,
    missions: service,
    clock: deps.clock ?? systemClock,
    logger: deps.logger.child({ component: 'mission-team' }),
    mint: deps.mint,
  });
  const handlers = {
    ...createMissionHandlers({
      publicUrl: deps.config.publicUrl,
      authenticator: deps.authenticator,
      service,
    }),
    ...createTeamHandlers({
      publicUrl: deps.config.publicUrl,
      authenticator: deps.authenticator,
      team,
      version: deps.version ?? '0.0.0',
      // The audit keeps every call with the token it presented, a refusal before the
      // mission log was touched included; oldest first.
      firstCallOf: async (missionId, tokenId) => {
        const calls = await deps.store.audit.list({ missionId, kind: 'call', limit: 200 });
        const call = calls.find((entry) => entry.kind === 'call' && entry.token_id === tokenId);
        return call?.kind === 'call'
          ? {
              at: call.ts,
              outcome: call.decision === 'allowed' ? 'allowed' : 'refused',
              tool: call.tool,
              refusal_code: call.refusal_code,
            }
          : null;
      },
    }),
  };
  return { authority, service, team, handlers };
}

export {
  AGENT_LABEL_HEADER,
  AGENT_LABEL_MAX_LENGTH,
  AGENT_LABEL_META_KEY,
  AGENT_LABEL_PUNCTUATION,
  buildBootstrapKit,
  EXECUTION_DOOR_PATH,
  MCP_SERVER_NAME,
  MISSION_TOKEN_ENV,
  REFUSAL_GUIDANCE,
  type BootstrapKit,
  type BootstrapKitInput,
} from './bootstrap-kit';
export {
  byRowWorstFirst,
  enumerateCatalog,
  hardestToRepair,
  isResolvable,
} from '../../lib/missions/catalog-view';
export {
  EVERYTHING_I_HOLD,
  EVERYTHING_I_HOLD_DESCRIPTION,
  EVERYTHING_I_HOLD_LABEL,
  everythingIHold,
  expansionDigest,
  type EverythingIHold,
  type ExpansionDigest,
} from '../../lib/missions/everything-i-hold';
export { missionDraftSchema, parseMissionDraft, type ParsedDraft } from './draft-schema';
export {
  TRUST_LEVEL_BUDGET_FACTOR,
  TRUST_LEVEL_GATES,
  expandMacroAction,
  macroActionOfRisk,
  macroActionsOf,
  rowOf,
  TRUST_LEVELS,
  type TrustLevel,
} from '../../lib/missions/macro-actions';
export { createMissionHandlers, type MissionHandlers } from './handlers';
export {
  MissionService,
  tokenHolderOf,
  type EditPreviewResult,
  type EditResult,
  type IssueOptions,
  type IssueResult,
  type LimitReachedResult,
  type LimitChangeView,
  type LimitEdit,
  type MissionAccess,
  type MissionDetail,
  type MissionDetailAccount,
  type MissionDetailRisk,
  type MissionEditView,
  type MissionIssuedAudit,
  type MissionOrphanReason,
  type MissionOverview,
  type MissionRole,
  type MissionServiceDeps,
  type PreviewOptions,
  type RevealedToken,
  type RevokeResult,
  type RotateResult,
  type SetGateResult,
  type SetLimitsResult,
  type TokenRetirement,
  type TokenVerification,
  type VerifiedToken,
  withAssumedEnvs,
} from './mission-service';
export { createTeamHandlers, type TeamHandlers } from './team-handlers';
export { nextTrustLevel, trustRaiseOffers, type TrustRaiseOffer } from './trust-raise';
export {
  MissionTeamService,
  type AddMemberResult,
  type IssuedTokenResult,
  type LeaveResult,
  type MissionTeam,
  type MissionTeamDeps,
  type NamedTokenResult,
  type RemoveMemberResult,
  type ReplaceNamedTokenResult,
  type RevokeTokenResult,
  type TeamHolderView,
  type TeamMemberView,
  type TeamTokenView,
} from './team-service';
export {
  parseTokenName,
  TOKEN_NAME_MAX_LENGTH,
  TOKEN_NAME_RULE,
} from '../../lib/missions/token-name';
export type * from '../../lib/missions/model';
export { PREVIEW_ISSUE_CODES, PREVIEW_NOTICE_CODES } from '../../lib/missions/model';
export { reachedResources, takesFutureResources } from '../store/mission-reach';
export {
  budgetProblem,
  defaultResources,
  previewAccount,
  previewDraft,
  MISSION_NAME_MAX_LENGTH,
  uncoveredOf,
} from '../../lib/missions/preview';
export { hasChanges, type MissionChanges } from '../../lib/missions/mission-edit';
export { explainOrphan, type OrphanExplanation } from './orphan-reason';
export { summarize } from '../../lib/missions/summary';
export {
  maskedToken,
  mintMissionToken,
  MISSION_TOKEN_HASH_ALG,
  prefixOfBearer,
  type MintedToken,
  type TokenMinter,
} from './token';
