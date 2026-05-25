import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // packages/web imports TS source directly from sibling workspace packages.
  // Tell Next.js to transpile those packages on the server side.
  transpilePackages: [
    '@vaubaan/shared',
    '@vaubaan/policy-engine',
    '@vaubaan/providers-github',
    '@vaubaan/providers-vercel',
    '@vaubaan/providers-supabase',
    '@vaubaan/mcp-gateway',
  ],
  experimental: {
    serverActions: { allowedOrigins: ['localhost:3000', 'vaubaan.com'] },
  },
};

export default nextConfig;
