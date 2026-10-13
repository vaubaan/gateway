import type { NextConfig } from 'next';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Build-time stamps frozen into the bundle: shown in the UI footer and by
// `/healthz`. Docker builds pass GIT_COMMIT_SHA (no .git in the image);
// local builds fall back to `git rev-parse`.
function resolveCommitSha(): string {
  if (process.env.GIT_COMMIT_SHA) return process.env.GIT_COMMIT_SHA.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
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

const commitSha = resolveCommitSha();

const nextConfig: NextConfig = {
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
  // default external list; ssh2 is not. argon2's prebuilt .node binaries are
  // traced explicitly because nft does not follow node-gyp-build lookups.
  // better-sqlite3 is reached through /healthz → composition root → store, so
  // nft traces it on its own; its runtime files (lib, bindings) stay listed as
  // the guarantee for the prebuilt binary, whatever the route graph becomes.
  serverExternalPackages: ['ssh2'],
  outputFileTracingIncludes: {
    '/*': [
      '../../node_modules/argon2/prebuilds/**',
      '../../node_modules/better-sqlite3/package.json',
      '../../node_modules/better-sqlite3/lib/**',
      '../../node_modules/better-sqlite3/build/Release/*.node',
      '../../node_modules/bindings/**',
      '../../node_modules/file-uri-to-path/**',
      // The store applies these at boot (apps/gateway/src/server/store/migrate.ts).
      './migrations/*.sql',
    ],
  },
  // Same build id on every replica of one image (hosted deployments need it).
  generateBuildId: () => commitSha,
  // The TLS terminator compresses (see deploy/caddy/Caddyfile); keeping Next's
  // gzip off avoids buffering streamed MCP responses.
  // Behind the reverse proxy Next compares Origin with X-Forwarded-Host (the
  // Caddyfile forwards it); no allowed-origins list is configured here because
  // next.config values are frozen at build time and would not follow the
  // instance configuration (ADR docker-image-and-config-format).
  compress: false,
};

export default nextConfig;
