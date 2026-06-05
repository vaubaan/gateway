import type { NextConfig } from 'next';
import { execSync } from 'node:child_process';

// Build-time stamp surfaced in the sidebar footer so we can confirm at a glance
// which revision is live. Vercel exposes VERCEL_GIT_COMMIT_SHA on every build;
// for local builds we fall back to `git rev-parse`. BUILD_TIME is captured here
// (module evaluation = build time) so the value is frozen into the bundle.
function resolveCommitSha(): string {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}
const commitSha = resolveCommitSha();
const buildTime = new Date().toISOString();

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_COMMIT_SHA: commitSha,
    NEXT_PUBLIC_BUILD_TIME: buildTime,
  },
  // packages/web imports TS source directly from sibling workspace packages.
  // Tell Next.js to transpile those packages on the server side.
  transpilePackages: [
    '@vaubaan/shared',
    '@vaubaan/policy-engine',
    '@vaubaan/providers-github',
    '@vaubaan/providers-vercel',
    '@vaubaan/providers-supabase',
    '@vaubaan/providers-railway',
    '@vaubaan/mcp-gateway',
    '@vaubaan/providers-vps-ssh',
  ],
  // ssh2 uses a native .node addon — must NOT be bundled by webpack.
  serverExternalPackages: ['ssh2'],
  experimental: {
    serverActions: { allowedOrigins: ['localhost:3000', 'vaubaan.com'] },
  },
};

export default nextConfig;
