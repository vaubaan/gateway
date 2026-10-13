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

function resolveVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
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
  transpilePackages: [
    '@vaubaan/shared',
    '@vaubaan/policy-engine',
    '@vaubaan/plugin-github',
    '@vaubaan/plugin-vercel',
    '@vaubaan/plugin-supabase',
    '@vaubaan/plugin-railway',
    '@vaubaan/gateway-core',
    '@vaubaan/plugin-ssh',
  ],
  // The harness owns AGENTS.md / CLAUDE.md in this repository; keep `next dev`
  // from writing its own agent-rules file next to the app.
  agentRules: false,
  // One image, one process: the standalone server.js (ADR docker-image-and-config-format).
  output: 'standalone',
  outputFileTracingRoot: resolve(__dirname, '../../'),
  // Native addons must not be bundled. argon2 and better-sqlite3 are in Next's
  // default external list; ssh2 is not. argon2's prebuilt .node binaries are
  // traced explicitly because nft does not follow node-gyp-build lookups.
  // better-sqlite3 is listed with its runtime files (lib, bindings) because
  // nothing in the route graph imports the store yet, so nft never reaches
  // the package; the globs become redundant, not harmful, once it does.
  serverExternalPackages: ['ssh2'],
  outputFileTracingIncludes: {
    '/*': [
      '../../node_modules/argon2/prebuilds/**',
      '../../node_modules/better-sqlite3/package.json',
      '../../node_modules/better-sqlite3/lib/**',
      '../../node_modules/better-sqlite3/build/Release/*.node',
      '../../node_modules/bindings/**',
      '../../node_modules/file-uri-to-path/**',
    ],
  },
  // Same build id on every replica of one image (hosted deployments need it).
  generateBuildId: () => commitSha,
  // The TLS terminator compresses (see deploy/caddy/Caddyfile); keeping Next's
  // gzip off avoids buffering streamed MCP responses.
  compress: false,
  experimental: {
    serverActions: {
      // Behind a reverse proxy, Next compares Origin with X-Forwarded-Host; an
      // explicit list is only needed for unusual setups.
      allowedOrigins: process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(',')
        : undefined,
    },
  },
};

export default nextConfig;
