import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // packages/web is the Vercel rootDirectory; transpile workspace deps so
  // Next.js picks up the TS sources from sibling packages without a build step.
  transpilePackages: ['@crm/catalog', '@crm/core'],
  typedRoutes: true,
};

export default nextConfig;
