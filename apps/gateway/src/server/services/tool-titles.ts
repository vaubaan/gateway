/**
 * What a tool does, in a few words, for a page that heads a request with it:
 * the title its plugin declares (`ServicePlugin.toolTitles` — "Merge a pull
 * request"), read from the plugin registry, the single list of services.
 *
 * Read-only, for people: nothing is decided from a title, and it is not part
 * of `tools/list`. A tool whose plugin is gone, or gives it no title, has
 * none — the page then prints the tool's name, as the protocol spells it.
 */
import type { PluginRegistry } from '@vaubaan/plugin-sdk';
import { splitToolName } from '@vaubaan/shared';

export function toolTitleOf(registry: Pick<PluginRegistry, 'get'>, tool: string): string | null {
  const service = splitToolName(tool)?.serviceId;
  if (!service) return null;
  return registry.get(service)?.plugin.toolTitles?.[tool] ?? null;
}
