/**
 * Plugin risk catalogs survive the Next.js build (Turbopack, `output: 'standalone'`).
 *
 * A plugin reads `risk-catalog.yaml` from disk at import time through
 * `loadCatalogFile(catalogPathNextTo(import.meta.url))`. Next's file tracing
 * cannot follow a `readFileSync` behind a computed path, so `next.config.ts`
 * lists `plugins/*\/src/**\/*.yaml` in `outputFileTracingIncludes` (ADR
 * plugin-catalog-path-and-standalone-tracing). This test reads the build
 * output and checks that every catalog of the repository — the template's
 * included — is present under `.next/standalone`, at the path the module
 * computes relative to itself.
 *
 * Skipped when `apps/gateway/.next/standalone` is absent (no build yet). CI
 * builds before testing, so it runs there; the container smoke test
 * (`deploy/docker/smoke.sh`) boots the image, which fails if a catalog is
 * missing.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = resolve(appDir, '../..');
const pluginsDir = join(repoRoot, 'plugins');
const standaloneDir = join(appDir, '.next/standalone');
const hasBuild = existsSync(standaloneDir);

/** Every `plugins/<id>/src/risk-catalog.yaml` of the repository, relative to the root. */
function catalogsInRepo(): string[] {
  return readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(pluginsDir, entry.name, 'src/risk-catalog.yaml'))
    .filter((path) => existsSync(path))
    .map((path) => relative(repoRoot, path));
}

describe.skipIf(!hasBuild)('standalone output keeps the plugin risk catalogs (Next build)', () => {
  it('traces the template catalog next to its module', () => {
    expect(existsSync(join(standaloneDir, 'plugins/_template/src/risk-catalog.yaml'))).toBe(true);
  });

  it('traces every plugin catalog of the repository', () => {
    const catalogs = catalogsInRepo();
    expect(catalogs.length).toBeGreaterThan(0);
    const missing = catalogs.filter((path) => !existsSync(join(standaloneDir, path)));
    expect(missing).toEqual([]);
  });
});
