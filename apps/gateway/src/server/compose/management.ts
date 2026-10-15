/**
 * Wiring of the management door (`root.management`) — the one place where the
 * services of the instance are narrowed to what the door may use.
 *
 * Spec §4.1 bis lists what the management surface never exposes: answering a
 * request, opening a gate, extending a budget, resetting a period, connecting,
 * sharing, transferring or revoking a connection, executing a provider tool.
 * The door's module declares the ports it needs (`management/ports.ts`); this
 * file builds each of them as an **object of closures** over exactly the
 * methods named there. The door therefore holds no service instance, no
 * repository and no store: nothing it could reach, by a mistake or by a
 * crafted call, performs one of those acts. `management/hard-deny.test.ts`
 * walks the object graph of the door built here against the real root.
 *
 * The admission gate (authorization server) is built here too and stays
 * `root.management.gate`; the door receives its `admit` as a function.
 */
import type { PluginRegistry } from '@vaubaan/plugin-sdk';

import type { BuildInfo, InstanceConfig } from '../config';
import type { Logger } from '../logging';
import {
  createManagementModule,
  MANAGEMENT_MISSION_METHODS,
  type ManagementCatalog,
  type ManagementMissions,
  type ManagementModule,
  type ManagementModuleDeps,
  type ManagementRateLimit,
  type ProviderCatalog,
} from '../management';
import { enumerateCatalog, type MissionService } from '../missions';
import {
  createManagementGate,
  type ManagementGate,
  type ManagementGateModuleDeps,
} from '../oauth-as';
import type { RateLimiter } from './ports';

/** Prefix of every rate-limit key of the door: disjoint from the budget's and the other surfaces'. */
export const MANAGEMENT_RATE_KEY_PREFIX = 'mgmt:';

export interface ManagementWiringDeps {
  readonly config: Pick<InstanceConfig, 'publicUrl' | 'trustedProxies' | 'clientIpHeader'>;
  readonly gate: Pick<ManagementGateModuleDeps, 'oauth' | 'missionTokens' | 'webSessions'>;
  readonly missions: MissionService;
  readonly registry: PluginRegistry;
  readonly rateLimiter: RateLimiter;
  readonly build: BuildInfo;
  readonly logger: Logger;
}

/** `root.management`: the admission gate and, behind it, the door with its tools. */
export interface ManagementDoorModule extends ManagementModule {
  /** Admission of `/mcp/manage` (authorization server): a delegated token and nothing else. */
  readonly gate: ManagementGate;
}

/**
 * The mission service as the door may use it: the methods of
 * `MANAGEMENT_MISSION_METHODS`, each bound to the service, on a plain object.
 */
export function managementMissionsOf(service: MissionService): ManagementMissions {
  const port: ManagementMissions = {
    issuanceContext: (user) => service.issuanceContext(user),
    preview: (user, draft) => service.preview(user, draft),
    issue: (user, draft, options) => service.issue(user, draft, options),
    rotate: (user, missionId, options) => service.rotate(user, missionId, options),
    revoke: (user, missionId, options) => service.revoke(user, missionId, options),
    list: (user) => service.list(user),
    get: (user, missionId) => service.get(user, missionId),
  };
  // The object carries the listed methods and no other: a method added to the
  // service reaches the door only by being added to the port's type first.
  const extra = Object.keys(port).filter(
    (key) => !(MANAGEMENT_MISSION_METHODS as readonly string[]).includes(key),
  );
  if (extra.length > 0)
    throw new Error(`management door: unexpected mission methods ${extra.join(', ')}`);
  return Object.freeze(port);
}

/** The shipped catalogs as plain data: ids, labels, presets. No plugin behaviour is handed over. */
export function managementCatalogOf(registry: PluginRegistry): ManagementCatalog {
  const catalogs = new Map<string, ProviderCatalog>();
  for (const id of registry.ids) {
    const { plugin } = registry.require(id);
    catalogs.set(
      id,
      Object.freeze({
        provider: id,
        provider_label: plugin.displayName,
        experimental: plugin.experimental === true,
        derives_env: typeof plugin.envOf === 'function',
        risks: enumerateCatalog(plugin.catalog),
        presets: registry.presetsOf(id),
      }),
    );
  }
  const providers = Object.freeze([...catalogs.keys()]);
  return Object.freeze({
    providers: () => providers,
    get: (provider: string) => catalogs.get(provider) ?? null,
  });
}

/** The `RateLimiter` port on keys of the door's own. */
export function managementRateLimitOf(rateLimiter: RateLimiter): ManagementRateLimit {
  return Object.freeze({
    take: (key: string, limit: number, windowMs: number) =>
      rateLimiter.take(`${MANAGEMENT_RATE_KEY_PREFIX}${key}`, limit, windowMs),
  });
}

export function wireManagementDoor(deps: ManagementWiringDeps): ManagementDoorModule {
  const gate = createManagementGate({ config: deps.config, ...deps.gate, logger: deps.logger });
  const ports: ManagementModuleDeps = {
    admit: (request) => gate.admit(request),
    missions: managementMissionsOf(deps.missions),
    catalog: managementCatalogOf(deps.registry),
    rateLimit: managementRateLimitOf(deps.rateLimiter),
    build: deps.build,
    logger: deps.logger,
  };
  return { gate, ...createManagementModule(ports) };
}
