/**
 * Plugin risk catalogs survive the Next.js build (Turbopack, `output: 'standalone'`).
 *
 * A plugin reads `risk-catalog.yaml` from disk at import time through
 * `loadCatalogFile(catalogPathNextTo(import.meta.url))`. Next's file tracing
 * cannot follow a `readFileSync` behind a computed path, so `next.config.ts`
 * lists `plugins/*\/src/**\/*.yaml` in `outputFileTracingIncludes` (see
 * docs/handbook/plugin-sdk.md). This test reads the build
 * output and checks that every catalog of the repository — the template's
 * included — is present under `.next/standalone`, at the path the module
 * computes relative to itself.
 *
 * The same output must hold no test file. The plugin loader's computed path
 * (`catalogPathNextTo`) carries a `turbopackIgnore` hint: without it the build
 * answers "dynamic filesystem access" by tracing the whole application
 * directory, tests included. `outputFileTracingExcludes` in `next.config.ts`
 * is the second guard, for the route traces. The last test asserts that no
 * trace names a test file and that the standalone tree holds none.
 *
 * Skipped when `apps/gateway/.next/standalone` is absent (no build yet). CI
 * builds before testing, so it runs there; the container smoke test
 * (`deploy/docker/smoke.sh`) boots the image, which fails if a catalog is
 * missing.
 *
 * The screenshots of the connect guides (`plugins/*\/docs/connect/**`) are read the
 * same way, behind a computed path (`readConnectFile`), and traced the same way.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = resolve(appDir, '../..');
const pluginsDir = join(repoRoot, 'plugins');
const standaloneDir = join(appDir, '.next/standalone');
const hasBuild = existsSync(standaloneDir);

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Every file under `dir`, relative to it, `node_modules` and the build's own `.next` apart. */
function filesUnder(dir: string, base: string = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' || entry.name === '.next' ? [] : filesUnder(path, base);
    }
    return [relative(base, path)];
  });
}

/** Every `*.nft.json` (the files a route needs at run time) under the build's server output. */
function routeTraces(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routeTraces(path);
    return entry.name.endsWith('.nft.json') ? [path] : [];
  });
}

/** A file of the application's own test tree or a test file beside its sources. */
function isTestFile(path: string): boolean {
  const normalized = path.split('\\').join('/');
  if (normalized.includes('/node_modules/') || normalized.startsWith('node_modules/')) return false;
  return /(^|\/)apps\/gateway\/tests\//.test(normalized) || TEST_FILE.test(normalized);
}

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

  it('traces the screenshots of the connect guides', () => {
    const shots = readdirSync(pluginsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const dir = join(pluginsDir, entry.name, 'docs/connect');
        return existsSync(dir)
          ? readdirSync(dir).map((file) => relative(repoRoot, join(dir, file)))
          : [];
      });
    expect(shots.filter((path) => !existsSync(join(standaloneDir, path)))).toEqual([]);
  });

  it('ships no test file: no trace names one and the standalone tree holds none', () => {
    const serverDir = join(appDir, '.next/server');
    const testFilesOf = (trace: string): string[] => {
      const { files } = JSON.parse(readFileSync(trace, 'utf8')) as { files: string[] };
      return files
        .map((file) => relative(repoRoot, resolve(dirname(trace), file)))
        .filter(isTestFile);
    };
    // No route (page or handler) and no boot hook needs a test file at run time.
    const traces = routeTraces(serverDir);
    expect(traces.length).toBeGreaterThan(0);
    expect([...new Set(traces.flatMap(testFilesOf))]).toEqual([]);
    // What the image copies.
    expect(filesUnder(standaloneDir).filter(isTestFile)).toEqual([]);
    // The server the image runs is still there.
    expect(existsSync(join(standaloneDir, 'apps/gateway/server.js'))).toBe(true);
  });
});
