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
import { createVaubaanExecute, SERVICE_ID, type VaubaanPorts } from '@vaubaan/plugin-vaubaan';
import type { PluginRegistry } from '@vaubaan/plugin-sdk';

import type { HostComposedExecute } from '../execution';
import type { Logger } from '../logging';
import { enumerateCatalog, macroActionsOf, type MissionService } from '../missions';
import {
  createVaubaanPorts,
  VAUBAAN_MISSION_METHODS,
  type ServiceCatalog,
  type VaubaanCatalog,
  type VaubaanMissions,
  type VaubaanPlugins,
} from '../vaubaan';
import type { AdministratorsService } from '../auth/administrators';
import type { PluginInventoryEntry } from '../plugins';
import type { PluginInstallService } from '../plugins/install-service';
import type { Store } from '../store';

export interface VaubaanWiringDeps {
  readonly missions: MissionService;
  readonly registry: PluginRegistry;
  readonly plugins: VaubaanPlugins;
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
    editView: (user, missionId) => service.editView(user, missionId),
    previewEdit: (user, missionId, raw) => service.previewEdit(user, missionId, raw),
    edit: (user, missionId, raw, options) => service.edit(user, missionId, raw, options),
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
  const catalogs = new Map<string, ServiceCatalog>();
  for (const id of registry.ids) {
    const { plugin } = registry.require(id);
    catalogs.set(
      id,
      Object.freeze({
        service: id,
        service_label: plugin.displayName,
        derives_env: typeof plugin.envOf === 'function',
        risks: enumerateCatalog(plugin.catalog),
        macro_actions: macroActionsOf(plugin.catalog),
      }),
    );
  }
  const services = Object.freeze([...catalogs.keys()]);
  return Object.freeze({
    services: () => services,
    get: (service: string) => catalogs.get(service) ?? null,
  });
}

/**
 * The plugins of the instance as the plugin acts may use them, on a plain object of
 * four closures: whether a user is an administrator, an upload (inert), the activation
 * page's address, the status. The install service itself is never handed over: nothing
 * reachable from the plugin activates, refuses, rolls back or removes a plugin.
 */
export function vaubaanPluginsOf(deps: {
  readonly install: PluginInstallService;
  readonly administrators: AdministratorsService;
  readonly users: Store['users'];
  readonly entries: readonly PluginInventoryEntry[];
  readonly publicUrl: URL;
}): VaubaanPlugins {
  const { install, administrators, users, entries, publicUrl } = deps;
  return Object.freeze({
    isAdministrator: async (userId: string) => {
      const user = await users.getById(userId);
      return user !== null && (await administrators.isAdministrator(user));
    },
    upload: async (bytes: Uint8Array, actor: { userId: string; viaMissionId: string }) => {
      const result = await install.upload(bytes, actor);
      return result.ok
        ? {
            ok: true as const,
            version: {
              pluginId: result.version.pluginId,
              version: result.version.version,
              digest: result.version.digest,
            },
          }
        : { ok: false as const, code: result.code, message: result.message };
    },
    activationUrl: (digest: string) => new URL(`/admin/plugins#version-${digest}`, publicUrl).href,
    status: async () => ({
      plugins: entries
        .filter((entry) => entry.enabled)
        .map((entry) => ({ plugin: entry.id, version: entry.version, origin: entry.origin })),
      installed: (await install.list())
        .filter((v) => v.state !== 'removed')
        .map((v) => ({
          plugin: v.pluginId,
          version: v.version,
          digest: v.digest,
          state: v.state,
          trust: v.trust,
          failure: v.failure,
        })),
    }),
  });
}

export function wireVaubaanPlugin(deps: VaubaanWiringDeps): VaubaanPluginModule {
  const ports = createVaubaanPorts({
    missions: vaubaanMissionsOf(deps.missions),
    catalog: vaubaanCatalogOf(deps.registry),
    plugins: deps.plugins,
    logger: deps.logger,
  });
  // Bound only when the configuration enables the plugin: otherwise no account of it
  // exists to reach, and the door has nothing to run.
  const hostExecutes = new Map<string, HostComposedExecute>();
  if (deps.registry.has(SERVICE_ID)) hostExecutes.set(SERVICE_ID, createVaubaanExecute(ports));
  return { ports, hostExecutes };
}
