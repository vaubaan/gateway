import { fingerprintArguments } from '@vaubaan/gateway-core';
import type { NotificationEvents } from '../notifications/events';
import { permissionRequestTool, requestPermission } from './permission-request';
/**
 * Execution MCP door (spec §4.1, §2.4, §6, §7.5): the pipeline
 * of `@vaubaan/gateway-core` with its real stages, the bearer dispatch, the
 * token verifier and the upstream-credential cache, `tools/list`, `tools/call`
 * and the catalog endpoint. Built once by the composition root as
 * `root.execution`. Handbook: docs/handbook/execution-door.md.
 */
import {
  CallPipeline,
  upstreamErrorClassName,
  type CacheClient,
  type CallPipelineDeps,
} from '@vaubaan/gateway-core';
import type { PluginRegistry } from '@vaubaan/plugin-sdk';

import type { AuthModule } from '../auth';
import type { MissionGrounds } from '../authority';
import { createBudgetStage, type SessionService } from '../budget';
import type { BuildInfo } from '../compose/root';
import type { RateLimiter } from '../compose/ports';
import type { InstanceConfig } from '../config';
import type { AccountsModule } from '../accounts';
import { stackFramesOf, type Logger } from '../logging';
import type { MissionsModule } from '../missions';
import type { Store } from '../store';
import { systemClock, type Clock } from '../store/clock';
import { AccountCredentialCache } from './credential-cache';
import { CreatedResources } from './created-resources';
import { ExecutionDoor } from './door';
import { createResourceStage } from './resource-stage';
import { withDecisionTelemetry, type TelemetrySink } from './telemetry-sink';
import { createRiskStage } from './risk-stage';
import { TokenVerifier } from './token-verifier';
import { createUpstreamStage, type HostComposedExecute } from './upstream-stage';

export interface ExecutionModuleDeps {
  readonly config: Pick<
    InstanceConfig,
    | 'publicUrl'
    | 'trustedProxies'
    | 'clientIpHeader'
    | 'mcp'
    | 'execution'
    | 'selfResources'
    | 'requests'
  >;
  readonly store: Store;
  readonly registry: PluginRegistry;
  readonly auth: Pick<AuthModule, 'sessions'>;
  readonly missions: Pick<MissionsModule, 'service'>;
  /** `discoveryAfterCall`: the account's discovery after a call that created a resource. */
  readonly accounts: Pick<AccountsModule, 'credentials' | 'discoveryAfterCall' | 'futureResources'>;
  /** Re-checks the creator's authority on every request (handbook authority, Start here). */
  readonly grounds: Pick<MissionGrounds, 'inspect'>;
  /** The budget's session service (quota, rate windows, gate) — one per process. */
  readonly budget: SessionService;
  readonly cache: CacheClient;
  readonly rateLimiter: RateLimiter;
  readonly logger: Logger;
  readonly build: BuildInfo;
  readonly clock?: Clock;
  /** Receives each `plugin.execute` outcome (community telemetry); default: nothing. */
  readonly telemetry?: TelemetrySink;
  /** The `execute` of each plugin the host composes itself (`compose/vaubaan.ts`), by plugin id. */
  readonly hostExecutes?: ReadonlyMap<string, HostComposedExecute>;
  /** Told of a permission request the agent opened (spec §4.2 bis); default: nobody. */
  readonly notifications?: Pick<NotificationEvents, 'requestOpened'>;
}

export interface ExecutionHandlers {
  /** `/mcp` — MCP Streamable HTTP. */
  readonly mcp: (request: Request) => Promise<Response>;
  /** `GET /mcp/catalog`. */
  readonly catalog: (request: Request) => Promise<Response>;
}

/** The stages of the call pipeline, for the git door's own pipeline (same stages, same audit). */
export type ExecutionStages = CallPipelineDeps;

export interface ExecutionModule {
  readonly pipeline: CallPipeline;
  readonly stages: ExecutionStages;
  readonly credentialCache: AccountCredentialCache;
  /** The verifier of mission tokens: the management door identifies one with it, to refuse it by kind. */
  readonly tokens: TokenVerifier;
  readonly door: ExecutionDoor;
  readonly handlers: ExecutionHandlers;
}

export function createExecutionModule(deps: ExecutionModuleDeps): ExecutionModule {
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger.child({ component: 'execution-door' });
  const credentialCache = new AccountCredentialCache(deps.cache);

  const stages: ExecutionStages = {
    permissionRefusal: (ctx, call, missing, lines) =>
      deps.store.requests.recordPermissionRefusal({
        missionId: ctx.mission.id,
        tokenId: ctx.token.id,
        holder:
          ctx.token.holder.kind === 'member'
            ? `member:${ctx.token.holder.user_id}`
            : `named:${ctx.token.holder.name}`,
        tool: call.tool,
        fingerprint: fingerprintArguments(call.args),
        riskIds: missing,
        lines: lines.map((line) => ({ resourceSetId: line.resource_set_id, riskId: line.risk_id })),
      }),
    resources: createResourceStage({
      registry: deps.registry,
      accounts: deps.store.accounts,
    }),
    risks: createRiskStage({ registry: deps.registry }),
    budget: createBudgetStage({ service: deps.budget, missions: deps.store.missions }),
    upstream: createUpstreamStage({
      hostExecutes: deps.hostExecutes,
      credentials: deps.accounts.credentials,
      credentialCache,
      logger,
      telemetry: deps.telemetry,
      callTimeoutSeconds: deps.config.execution.callTimeoutSeconds,
    }),
    audit: deps.telemetry
      ? withDecisionTelemetry(deps.store.auditWriter, deps.telemetry, (error) =>
          logger.warn('telemetry sink failed', { error: upstreamErrorClassName(error) }),
        )
      : deps.store.auditWriter,
    now: () => clock.now(),
    // A decision stage threw: the pipeline refuses and audits the call; this is the
    // operator's trace. The error's message is left out on purpose — a classifier's
    // error text can quote the arguments, which no log line carries — so the class
    // and the frames are what locate the fault.
    onStageError: (stage, error, call) =>
      logger.error('call refused: a decision stage failed', {
        stage,
        tool: call.tool,
        error_class: upstreamErrorClassName(error),
        stack_frames: stackFramesOf(error),
      }),
  };
  const pipeline = new CallPipeline(stages);

  const createdResources = new CreatedResources({
    registry: deps.registry,
    store: deps.store,
    audit: deps.store.auditWriter,
    selfResources: deps.config.selfResources,
    logger,
    clock,
    futureResources: deps.accounts.futureResources,
  });

  const tokens = new TokenVerifier({ missions: deps.missions.service });
  const door = new ExecutionDoor({
    permissionTool: permissionRequestTool,
    permissionAudit: deps.store.auditWriter,
    requestPermission: (ctx, args) =>
      requestPermission(deps.store, deps.config, ctx, args, clock, deps.notifications),
    config: deps.config,
    store: deps.store,
    registry: deps.registry,
    tokens,
    tokenUse: deps.store.missions,
    grounds: deps.grounds,
    webSessions: deps.auth.sessions,
    budget: deps.budget,
    pipeline,
    // What a creating call made joins the mission on the request path (local writes),
    // then the account's discovery runs off it (ADRs created-resources-join-the-mission,
    // created-resources-join-the-mission).
    afterCall: async (ctx, call) => {
      const created = await createdResources.record(ctx, call);
      deps.accounts.discoveryAfterCall.afterCall(ctx, call, created);
    },
    rateLimiter: deps.rateLimiter,
    logger,
    build: deps.build,
    clock,
    ...(deps.registry.gitRemotes().length > 0
      ? { gitRemote: { publicUrl: deps.config.publicUrl } }
      : {}),
  });

  return {
    pipeline,
    stages,
    credentialCache,
    tokens,
    door,
    handlers: {
      mcp: (request) => door.handleMcp(request),
      catalog: (request) => door.handleCatalog(request),
    },
  };
}

export { AccountCredentialCache, MAX_UPSTREAM_CREDENTIAL_TTL_SECONDS } from './credential-cache';
export {
  CREATED_BY_THE_MISSION,
  CreatedResources,
  type CreatedResourcesDeps,
} from './created-resources';
export {
  CALL_REJECTED_RPC_CODE,
  ExecutionDoor,
  MCP_SERVER_INFO_NAME,
  SURFACE_RATE_LIMITED_RPC_CODE,
  type ExecutionDoorDeps,
} from './door';
export {
  isDenial,
  MissionAdmission,
  SURFACE_RATE_WINDOW_MS,
  TOKEN_LAST_USED_GRANULARITY_SECONDS,
  type AdmissionDenial,
  type Admitted,
  type MissionAdmissionDeps,
  type TokenUseRecorder,
} from './admission';
export { loadMissionContext, missionResourceOf, periodOf } from './mission-context';
export {
  AGENT_LABEL_HEADER,
  AGENT_LABEL_MAX_LENGTH,
  AGENT_LABEL_META_KEY,
  agentLabelOf,
  clientOriginOf,
  parseAgentLabel,
  readAgentLabel,
  trustedProxyList,
  type AgentLabelCarrier,
  type AgentLabelParse,
  type AgentLabelReading,
  type AgentLabelRejection,
  type DroppedAgentLabel,
} from './request-meta';
export { citedRefs, createResourceStage } from './resource-stage';
export { createRiskStage } from './risk-stage';
export { TokenVerifier } from './token-verifier';
export {
  buildCatalog,
  callableServices,
  callableTools,
  type GitRemoteView,
  type CatalogBudgetLine,
  type CatalogAccount,
  type CatalogResource,
  type CatalogToken,
  type CatalogTool,
  type MissionCatalog,
} from './tools';
export {
  NOOP_TELEMETRY_SINK,
  type PluginExecution,
  type PluginOutcome,
  type TelemetrySink,
} from './telemetry-sink';
export { createUpstreamStage, type HostCaller, type HostComposedExecute } from './upstream-stage';
