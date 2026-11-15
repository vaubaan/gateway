/**
 * Pages of the service that show what a waiting call would do, for the
 * person who answers it (spec §4.1 ter; ADR gateway-as-git-remote D5): for a
 * git push, the service's comparison of each pushed ref, readable because
 * the pushed commits stay under a temporary ref while the request is open.
 * Derived from the plugin (`gitRemote.compareUrl`) and the arguments in
 * clear; nothing once the arguments are erased. Pure.
 */
import { type PluginRegistry } from '@vaubaan/plugin-sdk';
import { GIT_UPDATE_KINDS, type GitReviewedUpdate } from '@vaubaan/plugin-sdk/git';
import { splitToolName } from '@vaubaan/shared';

export interface ServicePage {
  /** What the page shows (`refs/heads/feature/x`). */
  readonly label: string;
  readonly url: string;
}

function isUpdate(value: unknown): value is GitReviewedUpdate {
  if (typeof value !== 'object' || value === null) return false;
  const u = value as Record<string, unknown>;
  return (
    typeof u.ref === 'string' &&
    (u.old === null || typeof u.old === 'string') &&
    (u.new === null || typeof u.new === 'string') &&
    GIT_UPDATE_KINDS.some((kind) => kind === u.kind)
  );
}

export function servicePagesOf(
  registry: Pick<PluginRegistry, 'get'>,
  tool: string,
  args: unknown,
): ServicePage[] {
  const split = splitToolName(tool);
  const remote = split ? registry.get(split.serviceId)?.plugin.gitRemote : undefined;
  if (!remote?.compareUrl || tool !== remote.pushTool) return [];
  if (typeof args !== 'object' || args === null) return [];
  const { repository, updates } = args as { repository?: unknown; updates?: unknown };
  if (typeof repository !== 'string' || !Array.isArray(updates)) return [];
  return updates.filter(isUpdate).flatMap((update) => {
    const url = remote.compareUrl?.(repository, update) ?? null;
    return url ? [{ label: update.ref, url }] : [];
  });
}
