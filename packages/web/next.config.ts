import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // packages/web imports TS source directly from sibling workspace packages.
  // Tell Next.js to transpile those packages on the server side.
  transpilePackages: [
    '@vauban/shared',
    '@vauban/policy-engine',
    '@vauban/providers-github',
    '@vauban/providers-vercel',
    '@vauban/providers-supabase',
    '@vauban/mcp-gateway',
  ],
  experimental: {
    serverActions: { allowedOrigins: ['localhost:3000', 'vauban.run'] },
  },
};

export default nextConfig;
