/**
 * Locate `risk-catalog.yaml` next to the module that loads it.
 *
 * ADR : docs/decisions/plugin-catalog-path-and-standalone-tracing.md.
 *
 * `new URL('./risk-catalog.yaml', import.meta.url)` — the obvious pattern —
 * is rewritten by bundlers that recognise the literal : Turbopack (Next.js
 * 16, `apps/gateway`) turns it into a `/_next/static/media/*.yaml` asset URL
 * and `readFileSync` fails during `next build`. Building the path with
 * `node:path` from `import.meta.url` is left alone, because the bundler
 * sees a plain expression. This helper is the one place that knows this ;
 * every plugin writes
 *
 *   loadCatalogFile(catalogPathNextTo(import.meta.url))
 *
 * and the path is a real filesystem path in vitest, `next dev`, `next build`
 * and the standalone server (where `apps/gateway/next.config.ts` traces every
 * `plugins/*\/src/**\/*.yaml` into the output).
 *
 * The `join` below is marked `turbopackIgnore` : left alone, Turbopack treats
 * the computed path as "dynamic filesystem access" and traces the whole
 * application directory — tests and their fixtures included — into the
 * standalone output (ADR local-demo-mode D7). The catalogs do not depend on
 * that : they are traced by name.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Default file name of a plugin's catalog. */
export const CATALOG_FILE_NAME = 'risk-catalog.yaml';

/**
 * Filesystem path of `fileName` in the directory of `moduleUrl` (pass
 * `import.meta.url`). Throws when the URL is not a `file:` URL — the sign
 * that a bundler rewrote it, which would otherwise surface as a confusing
 * `ENOENT` far from its cause.
 */
export function catalogPathNextTo(
  moduleUrl: string | URL,
  fileName: string = CATALOG_FILE_NAME,
): string {
  const url = typeof moduleUrl === 'string' ? parseModuleUrl(moduleUrl) : moduleUrl;
  if (url.protocol !== 'file:') {
    throw new Error(
      `catalogPathNextTo: expected a file: URL (import.meta.url), got '${url.href}' — ` +
        'a bundler rewrote the module URL; load the catalog from a plain filesystem path',
    );
  }
  return join(/* turbopackIgnore: true */ dirname(fileURLToPath(url)), fileName);
}

function parseModuleUrl(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new Error(
      `catalogPathNextTo: '${raw}' is not a URL — pass import.meta.url, not a relative path`,
    );
  }
}
