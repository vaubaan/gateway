/**
 * Missions: authority-bounded issuance, presets, resource
 * selection, token mint / rotate / revoke, bootstrap kit; and the members and
 * per-holder tokens of a mission (`team`).
 *
 * Server-only barrel (`node:crypto` and argon2 through `token.ts`). Client components import
 * the pure files directly — `model`, `catalog-view`, `preview`, `summary` —
 * never this index.
 * Handbook: docs/handbook/missions.md.
 */
import type { PluginRegistry } from '@vaubaan/plugin-sdk';

import type { Authenticator } from '../auth';
import {
  ConnectionAuthorityService,
  type AuthorityService,
  type MissionGrounds,
} from '../authority';
import type { SessionService } from '../budget';
import type { InstanceConfig } from '../config';
import type { Logger } from '../logging';
import type { Store } from '../store';
import { systemClock, type Clock } from '../store/clock';
import { createMissionHandlers, type MissionHandlers } from './handlers';
import { MissionService } from './mission-service';
import { createTeamHandlers, type TeamHandlers } from './team-handlers';
import { MissionTeamService } from './team-service';
import type { TokenMinter } from './token';

export interface MissionsModule {
  readonly authority: AuthorityService;
  readonly service: MissionService;
  /** Members and tokens of a mission (spec §7.9 bis). */
  readonly team: MissionTeamService;
  /** The handlers of `/api/missions/**`: the mission's own and its team's, one table. */
  readonly handlers: MissionHandlers & TeamHandlers;
}

export interface MissionsModuleDeps {
  readonly config: Pick<InstanceConfig, 'publicUrl' | 'selfResources'>;
  readonly store: Store;
  readonly registry: PluginRegistry;
  readonly authenticator: Authenticator;
  readonly logger: Logger;
  /** Defaults to a `ConnectionAuthorityService` over the store; the root injects its own. */
  readonly authority?: AuthorityService;
  /** Derives `orphaned` on every mission read (handbook authority). */
  readonly grounds: Pick<MissionGrounds, 'inspect'>;
  readonly clock?: Clock;
  readonly mint?: TokenMinter;
  /** The budget's state read; defaults to the same read over `store.sessions`. */
  readonly budget?: Pick<SessionService, 'stateOf'>;
}

export function createMissionsModule(deps: MissionsModuleDeps): MissionsModule {
  const authority =
    deps.authority ??
    new ConnectionAuthorityService({
      registry: deps.registry,
      users: deps.store.users,
      groups: deps.store.groups,
      connections: deps.store.connections,
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
  describePresetWidth,
  enumerateCatalog,
  isResolvable,
  presetWidth,
  severityLevel,
  severityOf,
  type PresetWidth,
} from './catalog-view';
export {
  EVERYTHING_I_HOLD,
  EVERYTHING_I_HOLD_DESCRIPTION,
  EVERYTHING_I_HOLD_LABEL,
  everythingIHold,
  expansionDigest,
  findPreset,
  presetIdsOf,
  type ExpansionDigest,
} from './everything-i-hold';
export { missionDraftSchema, parseMissionDraft, type ParsedDraft } from './draft-schema';
export { createMissionHandlers, type MissionHandlers } from './handlers';
export {
  MissionService,
  tokenHolderOf,
  type IssueOptions,
  type IssueResult,
  type LegacyHashGate,
  type LimitChangeView,
  type LimitEdit,
  type LegacyHashThrottled,
  type MissionAccess,
  type MissionDetail,
  type MissionDetailConnection,
  type MissionDetailRisk,
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
export { parseTokenName, TOKEN_NAME_MAX_LENGTH, TOKEN_NAME_RULE } from './token-name';
export type * from './model';
export { PREVIEW_ISSUE_CODES, PREVIEW_NOTICE_CODES, SEVERITY_LEVELS } from './model';
export { reachedResources, reachesLaterResources } from '../store/mission-reach';
export {
  budgetProblem,
  defaultResources,
  expandPreset,
  previewConnection,
  previewDraft,
  uncoveredOf,
} from './preview';
export { explainOrphan, type OrphanExplanation } from './orphan-reason';
export { summarize } from './summary';
export {
  LEGACY_TOKEN_HASH_ALG,
  maskedToken,
  mintMissionToken,
  MISSION_TOKEN_HASH_ALG,
  prefixOfBearer,
  type MintedToken,
  type TokenMinter,
} from './token';
