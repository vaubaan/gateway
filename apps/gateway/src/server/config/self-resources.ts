/**
 * Self resources — the provider resources that host or run this instance
 * (SEC 2026-10-15 H1). A Railway connection lists the project the gateway
 * runs in; a mission on it with `railway.read-variables` would read
 * `VAUBAAN_MASTER_KEY`. The host therefore keeps a set of resources no
 * mission can reach, whatever the plugin, the connection or the policy says.
 *
 * Two sources, merged:
 *
 * - the platform: Railway injects `RAILWAY_PROJECT_ID` into every container
 *   it runs, so an instance on Railway always counts its own project; Fly
 *   sets `FLY_APP_NAME` in every machine, so an instance on Fly always counts
 *   its own app (`fly:<app name>`, the ref the Fly plugin discovers). The
 *   configuration cannot take either out;
 * - the `self_resources` key (`VAUBAAN_SELF_RESOURCES`), a list of
 *   `<provider>:<ref>` entries, for any other host (a Vercel project, a
 *   Supabase project holding a backup, the SSH host the gateway runs on).
 *
 * Handbook: docs/handbook/configuration.md ("Self resources").
 */
import type { EnvSource } from './secret-refs';
import type { SelfResource } from './types';

/** The variable Railway sets in every service container: the id of its project. */
export const RAILWAY_PROJECT_ENV = 'RAILWAY_PROJECT_ID';

/** The Railway plugin id: the provider of the resource the platform names. */
const RAILWAY_PROVIDER = 'railway';

/** The variable Fly sets in every machine: the name of its app. */
export const FLY_APP_ENV = 'FLY_APP_NAME';

/** The Fly plugin id: its resources are apps, by name. */
const FLY_PROVIDER = 'fly';

/** `<provider>:<ref>` — a plugin id, then the ref as discovery stores it (no whitespace). */
const ENTRY = /^([a-z][a-z0-9_-]*):(\S+)$/;

/**
 * The self resources of this instance: the platform's first, then the
 * configured ones, without duplicates. Each malformed entry is reported
 * through `report` (a configuration issue: the instance does not start).
 */
export function readSelfResources(
  entries: readonly string[],
  env: EnvSource,
  report: (message: string) => void,
): SelfResource[] {
  const out: SelfResource[] = [];
  const add = (resource: SelfResource): void => {
    if (!isSelfResource(out, resource.provider, resource.ref)) out.push(resource);
  };
  const railwayProject = env[RAILWAY_PROJECT_ENV]?.trim();
  if (railwayProject) add({ provider: RAILWAY_PROVIDER, ref: railwayProject, source: 'railway' });
  const flyApp = env[FLY_APP_ENV]?.trim();
  if (flyApp) add({ provider: FLY_PROVIDER, ref: flyApp, source: 'fly' });
  for (const entry of entries) {
    const match = ENTRY.exec(entry);
    if (!match) {
      report(`"${entry}" is not <provider>:<ref> (for example railway:<project id>)`);
      continue;
    }
    add({ provider: match[1]!, ref: match[2]!, source: 'config' });
  }
  return out;
}

/** True when `provider` / `ref` names one of the instance's own resources. */
export function isSelfResource(
  selfResources: readonly Pick<SelfResource, 'provider' | 'ref'>[],
  provider: string,
  ref: string,
): boolean {
  return selfResources.some((s) => s.provider === provider && s.ref === ref);
}
