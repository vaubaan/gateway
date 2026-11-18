/**
 * Plugin risk catalogs survive the Next.js build (Turbopack, `output: 'standalone'`).
 *
 * A plugin reads `risk-catalog.yaml` from disk at import time through
 * `loadCatalogFile(catalogPathNextTo(import.meta.url))`. Next's file tracing
 * cannot follow a `readFileSync` behind a computed path, so `next.config.ts`
 * lists the YAML of the plugins compiled into the server (`vaubaan`, `ssh`) in
 * `outputFileTracingIncludes` (see docs/handbook/plugin-sdk.md). This test reads the
 * build output and checks that those catalogs are under `.next/standalone`, at the path
 * the module computes relative to itself, and that no other plugin's file is: every
 * other plugin is installed from the catalog (ADR plugins-installed-when-first-needed).
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
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = resolve(appDir, '../..');
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

/** The plugins compiled into the server (`SHIPPED_PLUGINS`; ADR plugins-installed-when-first-needed). */
const COMPILED = ['ssh', 'vaubaan'];

describe.skipIf(!hasBuild)('standalone output keeps the plugin risk catalogs (Next build)', () => {
  it('traces the catalogs of the plugins compiled into the server, next to their modules', () => {
    for (const id of COMPILED) {
      expect(existsSync(join(standaloneDir, `plugins/${id}/src/risk-catalog.yaml`)), id).toBe(true);
    }
  });

  it('carries no file of any other plugin: they are installed from the catalog', () => {
    const others = existsSync(join(standaloneDir, 'plugins'))
      ? readdirSync(join(standaloneDir, 'plugins')).filter((id) => !COMPILED.includes(id))
      : [];
    expect(others).toEqual([]);
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
