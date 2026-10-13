/**
 * Missions (feature P1.5): authority-bounded issuance, presets, resource
 * selection, token mint / rotate / revoke, bootstrap kit.
 *
 * Server-only barrel (argon2 through `token.ts`). Client components import
 * the pure files directly — `model`, `catalog-view`, `preview`, `summary` —
 * never this index.
 * Handbook: docs/handbook/missions.md.
 */
import type { PluginRegistry } from '@vaubaan/plugin-sdk';

import type { Authenticator } from '../auth';
import { ConnectionAuthorityService, type AuthorityService } from '../authority';
import type { SessionService } from '../budget';
import type { InstanceConfig } from '../config';
import type { Logger } from '../logging';
import type { Store } from '../store';
import { systemClock, type Clock } from '../store/clock';
import { createMissionHandlers, type MissionHandlers } from './handlers';
import { MissionService } from './mission-service';
import type { TokenMinter } from './token';

export interface MissionsModule {
  readonly authority: AuthorityService;
  readonly service: MissionService;
  readonly handlers: MissionHandlers;
}

export interface MissionsModuleDeps {
  readonly config: Pick<InstanceConfig, 'publicUrl'>;
  readonly store: Store;
  readonly registry: PluginRegistry;
  readonly authenticator: Authenticator;
  readonly logger: Logger;
  /** Defaults to a `ConnectionAuthorityService` over the store; the root injects its own. */
  readonly authority?: AuthorityService;
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
    publicUrl: deps.config.publicUrl,
    clock: deps.clock ?? systemClock,
    logger: deps.logger.child({ component: 'missions' }),
    mint: deps.mint,
    budget: deps.budget,
  });
  const handlers = createMissionHandlers({
    publicUrl: deps.config.publicUrl,
    authenticator: deps.authenticator,
    service,
  });
  return { authority, service, handlers };
}

export {
  AGENT_LABEL_HEADER,
  AGENT_LABEL_META_KEY,
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
export { parseMissionDraft, type ParsedDraft } from './draft-schema';
export { createMissionHandlers, type MissionHandlers } from './handlers';
export {
  MissionService,
  type IssueOptions,
  type IssueResult,
  type MissionDetail,
  type MissionDetailConnection,
  type MissionDetailRisk,
  type MissionIssuedAudit,
  type MissionOverview,
  type MissionServiceDeps,
  type RevealedToken,
  type RevokeResult,
  type RotateResult,
  type SetGateResult,
  type TokenVerification,
  type VerifiedToken,
} from './mission-service';
export type * from './model';
export { PREVIEW_ISSUE_CODES, PREVIEW_NOTICE_CODES, SEVERITY_LEVELS } from './model';
export { budgetProblem, previewConnection, previewDraft, uncoveredOf } from './preview';
export { summarize } from './summary';
export {
  maskedToken,
  mintMissionToken,
  MISSION_TOKEN_HASH_ALG,
  prefixOfBearer,
  type MintedToken,
  type TokenMinter,
} from './token';
