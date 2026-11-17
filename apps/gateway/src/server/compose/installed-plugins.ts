/**
 * The installed plugins of this start (ADR plugins-activated-by-an-administrator-on-trial;
 * handbook plugin-loading): the versions the store marks `trial` or `active`, loaded from
 * the data volume; what each trial became is recorded and audited before anything else
 * runs. `plugins.safe_mode`, or a store in memory, loads none.
 */
import type { AuditWriter } from '@vaubaan/gateway-core';
import { STARTUP_ACTOR_ID } from '@vaubaan/gateway-core';

import type { InstanceConfig } from '../config';
import type { Logger } from '../logging';
import { installedDirFor, loadInstalled, type PinnedPlugin, type PinReadOptions } from '../plugins';
import type { Store } from '../store';
import { toIso, type Clock } from '../store/clock';

export interface InstalledPluginsStart {
  /** `<data dir>/plugins`; `null` for a store in memory. */
  readonly dir: string | null;
  readonly plugins: readonly PinnedPlugin[];
}

export async function startInstalledPlugins(input: {
  readonly config: Pick<InstanceConfig, 'plugins' | 'store'>;
  readonly store: Pick<Store, 'pluginVersions'>;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly sdkVersion: string;
  readonly importEntry?: PinReadOptions['importEntry'];
}): Promise<InstalledPluginsStart> {
  const dir = installedDirFor(input.config.store.path);
  if (dir === null) return { dir, plugins: [] };
  if (input.config.plugins.safeMode) {
    input.logger.warn('plugins.safe_mode: installed plugins are not loaded this start');
    return { dir, plugins: [] };
  }
  const versions = await input.store.pluginVersions.forStart();
  if (versions.length === 0) return { dir, plugins: [] };
  const loaded = await loadInstalled(
    dir,
    versions.map((v) => ({
      digest: v.digest,
      pluginId: v.pluginId,
      version: v.version,
      state: v.state as 'trial' | 'active',
    })),
    { sdkVersion: input.sdkVersion, importEntry: input.importEntry, logger: input.logger },
  );
  await input.store.pluginVersions.recordStart(loaded.outcomes, STARTUP_ACTOR_ID);
  const trials = new Map(versions.filter((v) => v.state === 'trial').map((v) => [v.digest, v]));
  for (const outcome of loaded.outcomes) {
    const trial = trials.get(outcome.digest);
    if (trial === undefined) continue;
    try {
      await input.audit.write({
        kind: 'admin',
        ts: toIso(input.clock.now()),
        user_id: STARTUP_ACTOR_ID,
        act: 'plugin-trial-ended',
        object: { type: 'plugin', id: trial.digest },
        before: { plugin: trial.pluginId, version: trial.version, state: 'trial' },
        after:
          outcome.outcome === 'failed'
            ? {
                plugin: trial.pluginId,
                version: trial.version,
                state: 'failed',
                failure: outcome.failure,
              }
            : { plugin: trial.pluginId, version: trial.version, state: 'active' },
      });
    } catch (err) {
      input.logger.error('audit entry not written for the end of a plugin trial', {
        digest: trial.digest,
        err,
      });
    }
  }
  return { dir, plugins: loaded.plugins };
}
