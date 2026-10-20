/**
 * The home's read models (handbook web-app, "The home — Now"). Server-only
 * barrel; the pure derivations are in `derive.ts`.
 */
import type { GatewayRoot } from '../compose';
import { systemClock } from '../store/clock';
import type { NowDeps } from './now-reader';
import type { SetupDeps } from './setup';

/** The parts of the composition root the home reads. */
export function nowDepsOf(root: GatewayRoot): NowDeps {
  return {
    store: root.store,
    registry: root.registry,
    missions: root.missions.service,
    requests: root.requests.service,
    connections: root.connections.service,
    shares: root.shares.service,
    clock: systemClock,
  };
}

export function setupDepsOf(root: GatewayRoot): SetupDeps {
  return {
    providers: root.auth.providers,
    providerApps: root.providerApps,
    telemetry: root.telemetry,
  };
}

export { byLastActivity, nearestLimit, type LimitLine } from './derive';
export {
  readNow,
  STOPPED_SHOWN,
  type NowDeps,
  type NowHolder,
  type NowView,
  type RunningMission,
  type SharedAccount,
  type SharedMission,
  type StoppedMission,
} from './now-reader';
export {
  oauthClientChecklist,
  readSetup,
  type OAuthClientChecklist,
  type SetupDeps,
  type SetupView,
} from './setup';
