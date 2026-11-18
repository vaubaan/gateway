/**
 * The socle: the catalog's signed archives the image preinstalls (ADR
 * plugin-catalog-rebuilt-from-source; `deploy/socle.json`, unpacked by the image build into
 * `SOCLE_DIR/<id>/`).
 *
 * Until the compiled copies leave the server, an archive of the socle **replaces** the
 * compiled plugin of its id only when it is that very version: the image then runs what the
 * catalog built and signed, with no change of behaviour. Each folder goes through what an
 * installed version goes through at a start — every file against `vaubaan-manifest.json`,
 * the catalog's signature (trust level "Vaubaan" only), the SDK range, the import — and a
 * folder that fails is logged at `error` and leaves the compiled copy in place: a broken
 * socle never stops a start. No folder (a checkout, the tests): the compiled plugins.
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { ServicePlugin } from '@vaubaan/plugin-sdk';

import type { Logger } from '../logging';
import { installedFolderProblem, signedFilesOf } from './installed';
import { readPluginDirectory, type PinnedPlugin, type PinReadOptions } from './loader';
import { trustOf, type CatalogIdentity } from './trust';

/** Where the image unpacks the socle (deploy/docker/Dockerfile). */
export const SOCLE_DIR = '/app/socle';

export interface SocleOptions extends PinReadOptions {
  /** The plugins compiled into the server: an archive replaces one of the same version. */
  readonly compiled: readonly ServicePlugin[];
  readonly logger: Logger;
  /** Tests: another identity than the catalog's release workflow. */
  readonly catalogIdentity?: CatalogIdentity;
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}

/** Why the folder of `id` cannot replace the compiled plugin, or its plugin. */
async function readSocleFolder(
  path: string,
  id: string,
  options: SocleOptions,
): Promise<{ ok: true; pin: PinnedPlugin } | { ok: false; problem: string }> {
  const compiled = options.compiled.find((plugin) => plugin.id === id);
  if (compiled === undefined) return { ok: false, problem: 'no compiled plugin of this id' };
  const folderProblem = await installedFolderProblem(path);
  if (folderProblem !== null) return { ok: false, problem: folderProblem };
  const verdict = trustOf(await signedFilesOf(path), {
    trustedKeys: [],
    ...(options.catalogIdentity ? { catalogIdentity: options.catalogIdentity } : {}),
  });
  if (verdict.level !== 'vaubaan') {
    return {
      ok: false,
      problem: `not signed by the catalog (${verdict.level}${'reason' in verdict ? `: ${verdict.reason}` : ''})`,
    };
  }
  let pin: PinnedPlugin;
  try {
    pin = await readPluginDirectory(path, options);
  } catch (err) {
    return { ok: false, problem: err instanceof Error ? err.message : String(err) };
  }
  if (pin.id !== id) return { ok: false, problem: `the folder holds ${pin.id}` };
  if (pin.version !== compiled.version) {
    return {
      ok: false,
      problem: `the socle has ${pin.version}, the server compiled ${compiled.version}: deploy/socle.json and the plugin disagree`,
    };
  }
  return { ok: true, pin: { ...pin, trust: 'vaubaan' } };
}

/** The socle archives that replace a compiled plugin at this start. Never throws. */
export async function loadSocle(dir: string, options: SocleOptions): Promise<PinnedPlugin[]> {
  if (!(await isDirectory(dir))) return [];
  const logger = options.logger.child({ component: 'socle' });
  const loaded: PinnedPlugin[] = [];
  for (const id of (await readdir(dir)).filter((name) => !name.startsWith('.')).sort()) {
    const path = join(/* turbopackIgnore: true */ dir, id);
    if (!(await isDirectory(path))) continue;
    const read = await readSocleFolder(path, id, options);
    if (read.ok) {
      loaded.push(read.pin);
      logger.info(`plugin ${id} ${read.pin.version} from the socle, signed by the catalog`, {
        plugin: id,
      });
    } else {
      logger.error(`plugin ${id}: the socle's archive is not used, the compiled copy runs`, {
        plugin: id,
        problem: read.problem,
      });
    }
  }
  return loaded;
}
