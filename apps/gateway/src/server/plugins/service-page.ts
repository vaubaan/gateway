/**
 * The page data of a service's Reference (spec §4.2): the plugin the registry
 * holds — bundled or pinned, so a pinned older plugin shows its own catalog —
 * reduced by `pluginInfo` of `@vaubaan/plugin-page`, the builder the public
 * site runs at build (handbook web-app, "The Reference is the plugin's page").
 * What only the instance knows goes in the context: its screenshots are served
 * at `/reference/<id>/connect/<file>`, and a declared example its plugin cannot
 * classify leaves the calls out instead of failing the page (`lenient`).
 *
 * Built once per loaded plugin: the registry's objects live as long as the
 * process, and the page data depends on nothing else.
 */
import { pluginInfo, type PluginInfo } from '@vaubaan/plugin-page/info';
import type { ServicePlugin } from '@vaubaan/plugin-sdk';

import { connectFileUrl } from './connect-files';

const built = new WeakMap<ServicePlugin, PluginInfo>();

export function servicePageInfo(plugin: ServicePlugin): PluginInfo {
  const known = built.get(plugin);
  if (known) return known;
  const info = pluginInfo(plugin, { figureSrc: connectFileUrl, examples: 'lenient' });
  built.set(plugin, info);
  return info;
}
