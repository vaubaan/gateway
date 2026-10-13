/**
 * Execution MCP door (feature P1.6; spec §4.1, §2.4, §6, §7.5): the pipeline
 * of `@vaubaan/gateway-core` with its real stages, the bearer dispatch, the
 * verified-token and upstream-credential caches, `tools/list`, `tools/call`
 * and the catalog endpoint. Built once by the composition root as
 * `root.execution`. Handbook: docs/handbook/execution-door.md.
 */
import { CallPipeline, upstreamErrorClassName, type CacheClient } from '@vaubaan/gateway-core';
import type { PluginRegistry } from '@vaubaan/plugin-sdk';

import type { AuthModule } from '../auth';
import type { MissionGrounds } from '../authority';
import { createBudgetStage, type SessionService } from '../budget';
import type { BuildInfo } from '../compose/root';
import type { RateLimiter } from '../compose/ports';
import type { InstanceConfig } from '../config';
import type { ConnectionsModule } from '../connections';
import type { Logger } from '../logging';
import type { MissionsModule } from '../missions';
import type { Store } from '../store';
import { systemClock, type Clock } from '../store/clock';
import { ConnectionCredentialCache } from './credential-cache';
import { ExecutionDoor, type DelegatedTokenResolver } from './door';
import { createResourceStage } from './resource-stage';
import type { TelemetrySink } from './telemetry-sink';
import { createRiskStage } from './risk-stage';
import { TokenVerifier } from './token-verifier';
import { createUpstreamStage } from './upstream-stage';

export interface ExecutionModuleDeps {
  readonly config: Pick<InstanceConfig, 'publicUrl' | 'trustedProxies' | 'mcp'>;
  readonly store: Store;
  readonly registry: PluginRegistry;
  readonly auth: Pick<AuthModule, 'sessions'>;
  readonly missions: Pick<MissionsModule, 'service'>;
  readonly connections: Pick<ConnectionsModule, 'credentials'>;
  /** Re-checks the creator's authority on every request (handbook authority, "The door"). */
  readonly grounds: Pick<MissionGrounds, 'inspect'>;
  /** The budget's session service (quota, rate windows, gate) — one per process. */
  readonly budget: SessionService;
  readonly cache: CacheClient;
  readonly rateLimiter: RateLimiter;
  readonly logger: Logger;
  readonly build: BuildInfo;
  readonly clock?: Clock;
  /** Recognises delegated tokens so they are refused by kind; arrives with P2.3. */
  readonly delegations?: DelegatedTokenResolver;
  /** Receives each `plugin.execute` outcome (community telemetry, P2.5); default: nothing. */
  readonly telemetry?: TelemetrySink;
}

export interface ExecutionHandlers {
  /** `/mcp` — MCP Streamable HTTP. */
  readonly mcp: (request: Request) => Promise<Response>;
  /** `GET /mcp/catalog`. */
  readonly catalog: (request: Request) => Promise<Response>;
}

export interface ExecutionModule {
  readonly pipeline: CallPipeline;
  readonly credentialCache: ConnectionCredentialCache;
  /** The verifier of mission tokens: the management door identifies one with it, to refuse it by kind. */
  readonly tokens: TokenVerifier;
  readonly door: ExecutionDoor;
  readonly handlers: ExecutionHandlers;
}

const STACK_FRAMES_LOGGED = 12;

/** The `at …` lines of an error's stack — where it was thrown, without its message. */
function stackFramesOf(error: unknown): string[] {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return [];
  return error.stack
    .split('\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('at '))
    .slice(0, STACK_FRAMES_LOGGED);
}

export function createExecutionModule(deps: ExecutionModuleDeps): ExecutionModule {
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger.child({ component: 'execution-door' });
  const credentialCache = new ConnectionCredentialCache(deps.cache);

  const pipeline = new CallPipeline({
    resources: createResourceStage({
      registry: deps.registry,
      connections: deps.store.connections,
    }),
    risks: createRiskStage({ registry: deps.registry }),
    budget: createBudgetStage({ service: deps.budget, missions: deps.store.missions }),
    upstream: createUpstreamStage({
      credentials: deps.connections.credentials,
      credentialCache,
      logger,
      telemetry: deps.telemetry,
    }),
    audit: deps.store.auditWriter,
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
  });

  const tokens = new TokenVerifier({
    missions: deps.missions.service,
    cache: deps.cache,
    rateLimiter: deps.rateLimiter,
  });
  const door = new ExecutionDoor({
    config: deps.config,
    store: deps.store,
    registry: deps.registry,
    tokens,
    tokenUse: deps.store.missions,
    grounds: deps.grounds,
    webSessions: deps.auth.sessions,
    budget: deps.budget,
    pipeline,
    rateLimiter: deps.rateLimiter,
    logger,
    build: deps.build,
    clock,
    delegations: deps.delegations,
  });

  return {
    pipeline,
    credentialCache,
    tokens,
    door,
    handlers: {
      mcp: (request) => door.handleMcp(request),
      catalog: (request) => door.handleCatalog(request),
    },
  };
}

export { ConnectionCredentialCache, MAX_UPSTREAM_CREDENTIAL_TTL_SECONDS } from './credential-cache';
export {
  CALL_REJECTED_RPC_CODE,
  ExecutionDoor,
  MCP_SERVER_INFO_NAME,
  SURFACE_RATE_LIMITED_RPC_CODE,
  SURFACE_RATE_WINDOW_MS,
  TOKEN_LAST_USED_GRANULARITY_SECONDS,
  type DelegatedTokenResolver,
  type ExecutionDoorDeps,
  type TokenUseRecorder,
} from './door';
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
export {
  TokenVerifier,
  VERIFIED_TOKEN_TTL_SECONDS,
  VERIFY_ATTEMPTS_PER_WINDOW,
  VERIFY_WINDOW_MS,
  verifiedTokenCacheKey,
  verifyThrottleKey,
  type VerifyOutcome,
} from './token-verifier';
export {
  buildCatalog,
  callableProviders,
  callableTools,
  type CatalogBudgetLine,
  type CatalogConnection,
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
export { createUpstreamStage } from './upstream-stage';
