/**
 * The screenshots of a plugin's connect guide (ADR plugin-contract-and-credential-spec,
 * amendment 2026-11-13; handbook accounts "Screenshots of the connect guide"):
 * files of `GUIDE_SCREENSHOT_DIR` in the plugin's folder, served to signed-in users by
 * `GET /reference/<id>/connect/<file>`.
 *
 * Two origins, one rule:
 *
 *   bundled  `plugins/<id>/docs/connect/<file>` of the repository, traced into the
 *            standalone image by `outputFileTracingIncludes` (next.config.ts);
 *   pinned   `<pin directory>/docs/connect/<file>`, which
 *            `scripts/build-plugin-bundle.mjs` copies beside `index.js`.
 *
 * Only a file the registered plugin's guide declares is read, by a name that matches
 * `GUIDE_SCREENSHOT_FILE_PATTERN`: nothing outside that folder is ever reached.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GUIDE_SCREENSHOT_DIR,
  GUIDE_SCREENSHOT_FILE_PATTERN,
  type PluginRegistry,
} from '@vaubaan/plugin-sdk';

import type { PluginInventoryEntry } from './inventory';

/**
 * `plugins/` of the repository, resolved relative to this module (the pattern of
 * `DEFAULT_MIGRATIONS_DIR`: `path.resolve`, never `new URL(…, import.meta.url)`, which
 * the bundler rewrites into an asset).
 */
export const BUNDLED_PLUGINS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../plugins/',
);

/** The path a screenshot is served at, for the connect page and the Reference. */
export function connectFileUrl(serviceId: string, file: string): string {
  return `/reference/${encodeURIComponent(serviceId)}/connect/${encodeURIComponent(file)}`;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  webp: 'image/webp',
};

export interface ConnectFile {
  readonly body: Uint8Array;
  readonly contentType: string;
}

export interface ConnectFileSources {
  readonly registry: PluginRegistry;
  readonly inventory: readonly PluginInventoryEntry[];
  /** Tests: another `plugins/` for the bundled ones. */
  readonly bundledDir?: string;
}

/**
 * The bytes and type of a screenshot the registered plugin `serviceId` declares, or
 * `null`: an unknown or disabled plugin, a name outside the pattern, a file its guide
 * does not declare, or one missing on disk.
 */
export async function readConnectFile(
  sources: ConnectFileSources,
  serviceId: string,
  file: string,
): Promise<ConnectFile | null> {
  const match = GUIDE_SCREENSHOT_FILE_PATTERN.exec(file);
  if (!match) return null;
  const registered = sources.registry.get(serviceId);
  if (!registered) return null;
  const spec = registered.plugin.credential;
  const declared = spec.kind === 'api-key' ? spec.guide.screenshots : undefined;
  if (!declared || !Object.hasOwn(declared, file)) return null;
  const entry = sources.inventory.find((e) => e.id === serviceId && e.enabled);
  if (!entry) return null;
  const folder = entry.path ?? join(sources.bundledDir ?? BUNDLED_PLUGINS_DIR, serviceId);
  try {
    // turbopackIgnore: a computed path the bundler would otherwise trace as the whole
    // project; the files reach the image through `outputFileTracingIncludes`.
    const body = await readFile(
      /* turbopackIgnore: true */ join(folder, GUIDE_SCREENSHOT_DIR, file),
    );
    return { body, contentType: CONTENT_TYPES[match[1] ?? ''] ?? 'application/octet-stream' };
  } catch {
    // expected: no such screenshot in the plugin's folder: the route answers 404
    return null;
  }
}
