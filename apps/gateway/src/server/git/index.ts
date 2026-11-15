/**
 * The git remote (spec §4.1 ter; ADR gateway-as-git-remote): the second door
 * of the execution surface. Built by the composition root after the execution
 * module, from its admission (one instance), its decision stages and its
 * audit writer; the upstream stage of its pipeline relays fetches and hands
 * the push tool to the plugins' `execute`. Handbook: docs/handbook/git-remote.md.
 */
import { CallPipeline } from '@vaubaan/gateway-core';
import type { PluginRegistry } from '@vaubaan/plugin-sdk';

import type { InstanceConfig } from '../config';
import type { AccountsModule } from '../accounts';
import type { ExecutionModule } from '../execution';
import type { Logger } from '../logging';
import type { Store } from '../store';
import { systemClock, type Clock } from '../store/clock';
import { GitDoor } from './door';
import { inMemoryInFlightPushes } from './in-flight';
import { startPendingRefSweeper, type PendingRefSweeper } from './sweeper';
import { createGitUpstreamStage, gitMeter, RelayJobs } from './upstream';

export interface GitModuleDeps {
  readonly config: Pick<InstanceConfig, 'git'>;
  readonly store: Pick<Store, 'pendingRefs'>;
  readonly registry: PluginRegistry;
  readonly execution: Pick<ExecutionModule, 'door' | 'stages' | 'credentialCache'>;
  readonly accounts: Pick<AccountsModule, 'credentials'>;
  readonly logger: Logger;
  readonly clock?: Clock;
  /** Interval of the temporary-ref sweeper (tests). */
  readonly sweepIntervalMs?: number;
}

export interface GitModule {
  readonly door: GitDoor;
  readonly pipeline: CallPipeline;
  readonly sweeper: PendingRefSweeper;
  /** `/git/**` — every method the route exports lands here. */
  readonly handle: (request: Request) => Promise<Response>;
}

export function createGitModule(deps: GitModuleDeps): GitModule {
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger.child({ component: 'git-remote' });
  const { stages, credentialCache } = deps.execution;
  const credentials = deps.accounts.credentials;
  const jobs = new RelayJobs();
  const pipeline = new CallPipeline({
    ...stages,
    upstream: createGitUpstreamStage({
      registry: deps.registry,
      jobs,
      plugins: stages.upstream,
      credentials,
      credentialCache,
      logger,
    }),
    meter: gitMeter,
  });
  const door = new GitDoor({
    config: deps.config,
    registry: deps.registry,
    admission: deps.execution.door.admission,
    pipeline,
    jobs,
    pendingRefs: deps.store.pendingRefs,
    inFlight: inMemoryInFlightPushes(),
    credentials,
    credentialCache,
    logger,
  });
  const sweeper = startPendingRefSweeper({
    pendingRefs: deps.store.pendingRefs,
    registry: deps.registry,
    credentials,
    credentialCache,
    clock,
    logger,
    ...(deps.sweepIntervalMs !== undefined ? { intervalMs: deps.sweepIntervalMs } : {}),
  });
  return { door, pipeline, sweeper, handle: (request) => door.handle(request) };
}

export { bearerOf, GitDoor, type GitDoorDeps } from './door';
export {
  gitRemoteBase,
  GIT_DOOR_SEGMENT,
  parseGitPath,
  type GitEndpoint,
  type GitPath,
} from './paths';
export { commandListIssue, provisional, readPushCommands } from './command-list';
export * from './constants';
export { inMemoryInFlightPushes, type InFlightPushes } from './in-flight';
export { Push } from './push';
export { deleteTemporaryRefs, isTemporaryRef, temporaryRefName } from './temporary-refs';
export {
  PENDING_REF_GIVE_UP_MS,
  PENDING_REF_SWEEP_BATCH,
  PENDING_REF_SWEEP_INTERVAL_MS,
  startPendingRefSweeper,
  type PendingRefSweeper,
} from './sweeper';
export { refusalLine, refusalText } from './words';
