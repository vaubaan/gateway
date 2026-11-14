/**
 * Wiring of the `vaubaan` plugin (`root.vaubaan`) — the one place where the
 * services of the instance are narrowed to what the gateway's own management
 * tools may use (spec §4.1 bis; ADR
 * platform-management-is-a-plugin-on-the-execution-door).
 *
 * Spec §4.1 bis lists what the management tools never do: answer a request,
 * open a gate, extend a budget, reset a period, connect, share, transfer or
 * revoke an account, call another service's tool. The host module declares the
 * ports it needs (`vaubaan/ports.ts`); this file builds each of them as an
 * **object of closures** over exactly the methods named there. The plugin's
 * `execute` therefore holds no service instance, no repository and no store:
 * nothing it could reach, by a mistake or by a crafted call, performs one of
 * those acts. `vaubaan/hard-deny.test.ts` walks the object graph of the ports
 * built here against the real root.
 *
 * The execution door runs the bound `execute` in place of the plugin's
 * declared one (`hostExecutes`), with the caller added to the context. The
 * call has then passed the door like any other: the mission key, its accepted
 * risks, its resources, its budget and gates, the audit.
 */
import { createVaubaanExecute, PROVIDER_ID, type VaubaanPorts } from '@vaubaan/plugin-vaubaan';
import type { PluginRegistry } from '@vaubaan/plugin-sdk';

import type { HostComposedExecute } from '../execution';
import type { Logger } from '../logging';
import { enumerateCatalog, macroActionsOf, type MissionService } from '../missions';
import {
  createVaubaanPorts,
  VAUBAAN_MISSION_METHODS,
  type ProviderCatalog,
  type VaubaanCatalog,
  type VaubaanMissions,
} from '../vaubaan';

export interface VaubaanWiringDeps {
  readonly missions: MissionService;
  readonly registry: PluginRegistry;
  readonly logger: Logger;
}

/** `root.vaubaan`: the ports the plugin is bound to, and the `execute` the door runs. */
export interface VaubaanPluginModule {
  readonly ports: VaubaanPorts;
  /** The `execute` of each host-composed plugin, by id: empty when `vaubaan` is not enabled. */
  readonly hostExecutes: ReadonlyMap<string, HostComposedExecute>;
}

/**
 * The mission service as the plugin may use it: the methods of
 * `VAUBAAN_MISSION_METHODS`, each bound to the service, on a plain object.
 */
export function vaubaanMissionsOf(service: MissionService): VaubaanMissions {
  const port: VaubaanMissions = {
    issuanceContext: (user) => service.issuanceContext(user),
    preview: (user, draft) => service.preview(user, draft),
    issue: (user, draft, options) => service.issue(user, draft, options),
    rotate: (user, missionId, options) => service.rotate(user, missionId, options),
    revoke: (user, missionId, options) => service.revoke(user, missionId, options),
    list: (user) => service.list(user),
    get: (user, missionId) => service.get(user, missionId),
  };
  // The object carries the listed methods and no other: a method added to the
  // service reaches the plugin only by being added to the port's type first.
  const extra = Object.keys(port).filter(
    (key) => !(VAUBAAN_MISSION_METHODS as readonly string[]).includes(key),
  );
  if (extra.length > 0) {
    throw new Error(`vaubaan plugin: unexpected mission methods ${extra.join(', ')}`);
  }
  return Object.freeze(port);
}

/** The shipped catalogs as plain data: ids, labels, macro-actions. No plugin behaviour is handed over. */
export function vaubaanCatalogOf(registry: PluginRegistry): VaubaanCatalog {
  const catalogs = new Map<string, ProviderCatalog>();
  for (const id of registry.ids) {
    const { plugin } = registry.require(id);
    catalogs.set(
      id,
      Object.freeze({
        provider: id,
        provider_label: plugin.displayName,
        derives_env: typeof plugin.envOf === 'function',
        risks: enumerateCatalog(plugin.catalog),
        macro_actions: macroActionsOf(plugin.catalog),
      }),
    );
  }
  const providers = Object.freeze([...catalogs.keys()]);
  return Object.freeze({
    providers: () => providers,
    get: (provider: string) => catalogs.get(provider) ?? null,
  });
}

export function wireVaubaanPlugin(deps: VaubaanWiringDeps): VaubaanPluginModule {
  const ports = createVaubaanPorts({
    missions: vaubaanMissionsOf(deps.missions),
    catalog: vaubaanCatalogOf(deps.registry),
    logger: deps.logger,
  });
  // Bound only when the configuration enables the plugin: otherwise no account of it
  // exists to reach, and the door has nothing to run.
  const hostExecutes = new Map<string, HostComposedExecute>();
  if (deps.registry.has(PROVIDER_ID)) hostExecutes.set(PROVIDER_ID, createVaubaanExecute(ports));
  return { ports, hostExecutes };
}
