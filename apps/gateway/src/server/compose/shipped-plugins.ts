/**
 * The plugins compiled into the server (ADR plugins-installed-when-first-needed): the
 * management plugin, run by the host (`compose/vaubaan.ts`; ADR
 * platform-management-is-a-plugin-on-the-execution-door), and `ssh`, whose native addon
 * cannot travel in an archive. Every other plugin comes from the catalog: installed when a
 * person first connects its service, by an administrator, or pinned by the operator in
 * `plugins.dir`. The root composes these with the installed versions and the pins and
 * filters them by `plugins.enabled` (`server/plugins`). Tests and the demo choose their
 * own set (`buildRoot`'s `bundled`; `tests/support/plugins/repository.ts`).
 *
 * `createRegistry` validates every plugin and rejects duplicate ids, so a broken plugin
 * fails the boot instead of the first call. `buildShippedRegistry` is this set alone.
 */
import { createRegistry, type PluginRegistry, type ServicePlugin } from '@vaubaan/plugin-sdk';
import sshPlugin from '@vaubaan/plugin-ssh';
import vaubaanPlugin from '@vaubaan/plugin-vaubaan';

export const SHIPPED_PLUGINS: readonly ServicePlugin[] = [
  sshPlugin,
  // The gateway's own management tools: a host account, bound by the root to the
  // mission service (`compose/vaubaan.ts`; ADR platform-management-is-a-plugin-on-the-execution-door).
  vaubaanPlugin,
];

export async function buildShippedRegistry(): Promise<PluginRegistry> {
  return createRegistry(SHIPPED_PLUGINS);
}
