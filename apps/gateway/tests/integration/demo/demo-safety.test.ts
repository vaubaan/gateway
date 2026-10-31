/**
 * The demo mode never reaches a real instance (handbook demo-mode, Invariants).
 *
 * Three guarantees, each held here:
 *
 * 1. the demo refuses to start in a production environment or in a shell
 *    configured for a real instance (`tests/demo/guards.ts`);
 * 2. no file of the demo — and no test file at all — is in the standalone
 *    output the image is made of, and no built route or chunk knows the
 *    `/__demo` prefix (read from the build; skipped when there is none, CI
 *    builds before testing);
 * 3. the application itself has no demo seam: no route file under `src/app`
 *    serves `/__demo`, nothing under `src/` names the demo folder, and a
 *    normally composed root sends a GitHub installation to github.com and has
 *    no identity provider until an operator configures one.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { githubCredential } from '@vaubaan/plugin-github';
import { describe, expect, it } from 'vitest';

import { CONFIG_FILE_ENV } from '../../../src/server/config';
import { DEMO_IDP_PATH } from '../../demo/demo-idp';
import { DEMO_PREFIX } from '../../demo/demo-instance';
import { assertDemoAllowed, DEFAULT_DEMO_PORT, demoPort, DemoRefusal } from '../../demo/guards';
import { buildTestRoot } from '../missions/support';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const nextDir = join(appDir, '.next');
const standaloneDir = join(nextDir, 'standalone');
const hasBuild = existsSync(standaloneDir);

/** Every file under `dir`, `node_modules` left out (dependencies are not ours to scan). */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

describe('the demo refuses to start next to anything real', () => {
  it('starts in a development shell', () => {
    expect(() => assertDemoAllowed({})).not.toThrow();
    expect(() => assertDemoAllowed({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertDemoAllowed({ NODE_ENV: 'test' })).not.toThrow();
  });

  it('refuses NODE_ENV=production', () => {
    expect(() => assertDemoAllowed({ NODE_ENV: 'production' })).toThrow(DemoRefusal);
  });

  it('refuses a shell that names a configuration file', () => {
    expect(() => assertDemoAllowed({ [CONFIG_FILE_ENV]: '/etc/vaubaan/gateway.yaml' })).toThrow(
      /VAUBAAN_CONFIG_FILE is set/,
    );
  });

  it('refuses a shell that carries a real public URL', () => {
    expect(() => assertDemoAllowed({ VAUBAAN_PUBLIC_URL: 'https://gateway.acme.com' })).toThrow(
      /VAUBAAN_PUBLIC_URL is set/,
    );
  });

  it('reads DEMO_PORT, 0 meaning "any free port", and refuses anything else', () => {
    expect(demoPort({})).toBe(DEFAULT_DEMO_PORT);
    expect(demoPort({ DEMO_PORT: '4321' })).toBe(4321);
    expect(demoPort({ DEMO_PORT: '0' })).toBe(0);
    expect(() => demoPort({ DEMO_PORT: 'http' })).toThrow(DemoRefusal);
    expect(() => demoPort({ DEMO_PORT: '70000' })).toThrow(DemoRefusal);
  });
});

describe('everything the demo serves is under one prefix', () => {
  it('keeps the identity provider under /__demo', () => {
    expect(DEMO_PREFIX).toBe('/__demo');
    expect(DEMO_IDP_PATH.startsWith(`${DEMO_PREFIX}/`)).toBe(true);
  });
});

describe('the application has no demo seam', () => {
  const sources = filesUnder(join(appDir, 'src'));

  it('has no route file under src/app that serves the demo prefix', () => {
    const routes = sources.filter((path) => path.includes(`${sep}app${sep}`));
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.filter((path) => relative(appDir, path).includes('__demo'))).toEqual([]);
  });

  it('names neither the demo prefix nor the demo folder anywhere under src/', () => {
    const naming = sources
      .filter((path) => /\.(ts|tsx|md|css)$/.test(path))
      .filter((path) => /__demo|tests\/demo/.test(readFileSync(path, 'utf8')));
    expect(naming.map((path) => relative(appDir, path))).toEqual([]);
  });

  it('composes a root with the shipped GitHub plugin and no identity provider', async () => {
    const root = await buildTestRoot();
    try {
      const github = root.registry.require('github').plugin;
      // The very object the plugin ships: the demo registers it as is.
      expect(github.credential).toBe(githubCredential);
      expect(github.credential.kind).toBe('api-key');
      if (github.credential.kind === 'api-key') {
        expect(github.credential.createUrl).toMatch(/^https:\/\/github\.com\//);
      }
      expect(root.config.publicUrl.protocol).toBe('https:');
      expect(await root.auth.providers.views()).toEqual([]);
    } finally {
      await root.close();
    }
  });
});

describe.skipIf(!hasBuild)('the standalone output carries no demo and no test file', () => {
  it('traced the application itself', () => {
    expect(existsSync(join(standaloneDir, 'apps/gateway/server.js'))).toBe(true);
  });

  it('contains no file from a tests/ or demo/ folder', () => {
    const leaked = filesUnder(standaloneDir)
      .map((path) => relative(standaloneDir, path))
      .filter((path) => /(^|\/)(tests|demo)\//.test(path.split(sep).join('/')));
    expect(leaked).toEqual([]);
  });

  it('contains no file that names the demo prefix', () => {
    const naming = filesUnder(standaloneDir).filter((path) =>
      readFileSync(path).includes(DEMO_PREFIX),
    );
    expect(naming.map((path) => relative(standaloneDir, path))).toEqual([]);
  });

  it('built no route under the demo prefix', () => {
    const manifest = JSON.parse(
      readFileSync(join(nextDir, 'app-path-routes-manifest.json'), 'utf8'),
    ) as Record<string, string>;
    const routes = Object.values(manifest);
    expect(routes).toContain('/missions');
    expect(routes.filter((route) => route.includes('__demo'))).toEqual([]);
  });
});
