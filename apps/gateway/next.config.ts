import type { NextConfig } from 'next';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Build-time stamps frozen into the bundle: shown in the UI footer and by
// `/healthz`. The commit is only ever one the build can see for itself (see
// docs/workflow/coding-workflow.md): never a variable someone set by hand.

/**
 * Stamped by `git archive` with the full id of the archived commit
 * (`.gitattributes`: `export-subst`); in a checkout it still reads `$Format:%H$`.
 */
export const COMMIT_STAMP_FILE = 'build-commit.txt';

const FULL_COMMIT_ID = /^[0-9a-f]{40}$/;
const SHORT_COMMIT_LENGTH = 7;

/** The short commit a stamp file holds, or `null` when it was never stamped (a checkout). */
export function commitFromStamp(text: string | null): string | null {
  const value = text?.trim() ?? '';
  return FULL_COMMIT_ID.test(value) ? value.slice(0, SHORT_COMMIT_LENGTH) : null;
}

/**
 * The commit of the build: the stamp written by `git archive` (a deployed
 * tree, the image built by the CI), else the checkout's own HEAD (`-dirty`
 * when tracked files differ from it), else `unknown` — never a guess.
 */
export function resolveCommitSha(sources: {
  readonly stamp: string | null;
  readonly checkout: () => string | null;
}): string {
  return commitFromStamp(sources.stamp) ?? sources.checkout() ?? 'unknown';
}

function readStamp(): string | null {
  try {
    return readFileSync(resolve(__dirname, COMMIT_STAMP_FILE), 'utf8');
  } catch {
    return null;
  }
}

function git(args: string): string {
  return execSync(`git ${args}`, {
    cwd: __dirname,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/** HEAD of the checkout this build runs in, or `null` without one (an archive, the image). */
function checkoutCommit(): string | null {
  try {
    const head = git('rev-parse HEAD').slice(0, SHORT_COMMIT_LENGTH);
    const dirty = git('status --porcelain --untracked-files=no') !== '';
    return dirty ? `${head}-dirty` : head;
  } catch {
    return null;
  }
}

function readPackageJson(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

function resolveVersion(): string {
  try {
    const version = readPackageJson(resolve(__dirname, '../../package.json')).version;
    return typeof version === 'string' ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Every `@vaubaan/*` workspace this app depends on, read from its own
 * package.json: one source for the packages Next must transpile (they are
 * imported as TypeScript source), never a second provider list.
 */
function workspaceDependencies(): string[] {
  const deps = readPackageJson(resolve(__dirname, 'package.json')).dependencies;
  if (typeof deps !== 'object' || deps === null) return [];
  return Object.keys(deps).filter((name) => name.startsWith('@vaubaan/'));
}

const commitSha = resolveCommitSha({ stamp: readStamp(), checkout: checkoutCommit });

/** Files of this directory that no trace may carry into the standalone output. */
const NEVER_SHIPPED = [
  './tests/**',
  './src/**/*.test.ts',
  './src/**/*.test.tsx',
  './tsconfig.tsbuildinfo',
];

/**
 * The paths the interface had before its words changed (ADR
 * interface-redesign-vocabulary-and-design-system): connection → account,
 * request → waiting for you, audit → activity, provider → reference. Every old
 * path answers with a permanent redirect (308: the method and the body of a
 * form post are kept, the query string too), so bookmarks, links in tickets and
 * the address an agent was handed keep working.
 *
 * One path is NOT redirected: `/connections/callback/<provider>`. It is
 * registered at the provider as the callback of the company's app — part of
 * the protocol, like `/r/<id>`, `/mcp` and `/api/**`, which keep their names.
 *
 * `tests/unit/app/legacy-redirects.test.ts` holds each rule to a page or a
 * route that exists.
 */
export const LEGACY_REDIRECTS: readonly {
  readonly source: string;
  readonly destination: string;
}[] = [
  { source: '/connections', destination: '/accounts' },
  // A first segment that is not `callback`, then anything under it.
  { source: '/connections/:first((?!callback(?:/|$))[^/]+)', destination: '/accounts/:first' },
  {
    source: '/connections/:first((?!callback(?:/|$))[^/]+)/:rest*',
    destination: '/accounts/:first/:rest*',
  },
  { source: '/requests', destination: '/waiting' },
  { source: '/requests/:path*', destination: '/waiting/:path*' },
  { source: '/audit', destination: '/activity' },
  { source: '/providers', destination: '/reference' },
  { source: '/providers/:path*', destination: '/reference/:path*' },
  // What a colleague gave access to is the second region of Accounts ("Shared with you").
  { source: '/shares', destination: '/accounts' },
  // Connected apps ("delegations") are a page of Settings.
  { source: '/delegations', destination: '/settings/connected-apps' },
  { source: '/delegations/:id/revoke', destination: '/settings/connected-apps/:id/revoke' },
  // The accounts without owner are the last region of Accounts (see
  // docs/handbook/web-app.md); the reassign action stays under /admin.
  { source: '/admin/connections', destination: '/accounts#without-owner' },
];

const nextConfig: NextConfig = {
  // `npm run type-check` has checked this app when VAUBAAN_BUILD_TYPECHECKED=1
  // (`npm run ci`, the CI jobs that build): the build skips its second tsc pass.
  // Any other build (the image, a developer's) type-checks as usual.
  typescript: { ignoreBuildErrors: process.env.VAUBAAN_BUILD_TYPECHECKED === '1' },
  redirects: async () => LEGACY_REDIRECTS.map((rule) => ({ ...rule, permanent: true })),
  env: {
    NEXT_PUBLIC_COMMIT_SHA: commitSha,
    NEXT_PUBLIC_GATEWAY_VERSION: resolveVersion(),
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
  },
  // apps/gateway imports TS source directly from sibling workspace packages.
  // Tell Next.js to transpile those packages on the server side.
  transpilePackages: workspaceDependencies(),
  // The harness owns AGENTS.md / CLAUDE.md in this repository; keep `next dev`
  // from writing its own agent-rules file next to the app.
  agentRules: false,
  // One image, one process: the standalone server.js (ADR docker-image-and-config-format).
  output: 'standalone',
  outputFileTracingRoot: resolve(__dirname, '../../'),
  // Native addons must not be bundled. argon2 and better-sqlite3 are in Next's
  // default external list; ssh2 is not. Both load a prebuilt N-API binary
  // shipped in their package through a path computed at run time, which nft
  // does not follow: argon2's `prebuilds/<platform>-<arch>/` (node-gyp-build)
  // and better-sqlite3's `prebuilds/<platform>-<arch>.node` (since 13) are
  // traced explicitly, the latter for the building platform (the image builds
  // on each architecture). nft itself, reading better-sqlite3's loader, adds
  // the binaries of the other systems for the same architecture (about 6 MB
  // never loaded, as argon2's `prebuilds/**` already ships).
  // better-sqlite3's package.json and lib/ stay listed as the guarantee of its
  // loader, whatever the route graph becomes.
  // imapflow (the Gmail plugin's IMAP client) is not an addon, but it loads
  // pino, whose worker-thread transports resolve files at run time: kept
  // external, it is traced and copied as the package it is.
  serverExternalPackages: ['ssh2', 'imapflow'],
  outputFileTracingIncludes: {
    '/*': [
      '../../node_modules/argon2/prebuilds/**',
      '../../node_modules/better-sqlite3/package.json',
      '../../node_modules/better-sqlite3/lib/**',
      `../../node_modules/better-sqlite3/prebuilds/${process.platform}*-${process.arch}.node`,
      // The store applies these at boot (apps/gateway/src/server/store/migrate.ts).
      './migrations/*.sql',
      // Plugins read their risk catalog from disk at import time
      // (`loadCatalogFile(catalogPathNextTo(import.meta.url))`); nft cannot see a
      // readFileSync behind a computed path, so every plugin YAML is traced here
      // (docs/handbook/plugin-sdk.md).
      '../../plugins/*/src/**/*.yaml',
      // The screenshots of the connect guides, read by `readConnectFile`
      // (src/server/plugins/connect-files.ts) behind a computed path, like the catalogs.
      '../../plugins/*/docs/connect/**',
    ],
  },
  // Tests never ship. `catalogPathNextTo` (`packages/plugin-sdk/src/catalog-path.ts`)
  // joins a path computed at run time, which makes Turbopack trace the whole
  // application directory into every entry that reaches the plugins ("Dynamic
  // filesystem access causes tracing of the whole project"): without this list the
  // standalone tree, which the image copies whole, carried `tests/**` and every
  // `*.test.ts` beside the sources. Paths are relative to this directory; `/*`
  // matches every route. Turbopack applies this option to route traces only: the
  // trace of the boot hook (`src/instrumentation.ts`) is not a route's and no key
  // reaches it, so it is cleaned at the source or not at all (handbook web-app,
  // Start here).
  outputFileTracingExcludes: { '/*': NEVER_SHIPPED },
  // Same build id on every replica of one image (hosted deployments need it).
  generateBuildId: () => commitSha,
  // The TLS terminator compresses (see deploy/caddy/Caddyfile); keeping Next's
  // gzip off avoids buffering streamed MCP responses.
  // Behind the reverse proxy Next compares Origin with X-Forwarded-Host (the
  // Caddyfile forwards it); no allowed-origins list is configured here because
  // next.config values are frozen at build time and would not follow the
  // instance configuration (ADR docker-image-and-config-format).
  compress: false,
  // No page uses `next/image`: the optimizer endpoint (`/_next/image`) would only
  // be unauthenticated surface parsing attacker-chosen bytes through sharp and
  // libvips (security review 2026-10-15, M1). Unoptimized, Next serves no
  // optimizer route.
  images: { unoptimized: true },
};

export default nextConfig;
