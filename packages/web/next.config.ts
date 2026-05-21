import type { NextConfig } from 'next';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// libsodium-wrappers-sumo@0.7.16 publishes an ESM entry that references a
// sibling `libsodium-sumo.mjs` that isn't in the published tarball — only
// the CJS bundle works. Same workaround as `vitest.config.ts`.
// Use CJS resolution so we land on `exports.require` (the CJS bundle).
const libsodiumCjsPath = require.resolve('libsodium-wrappers-sumo');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // packages/web is the Vercel rootDirectory; transpile workspace deps so
  // Next.js picks up the TS sources from sibling packages without a build step.
  transpilePackages: ['@crm/catalog', '@crm/core'],
  typedRoutes: true,
  webpack: (config) => {
    // Sibling packages (@crm/core, @crm/catalog) use `import './foo.js'`
    // for TS source — Node ESM / `moduleResolution: Bundler` rewrites
    // `.js` → `.ts` at type-check time, but Webpack's resolver doesn't.
    // Teach it to do the same so `next build` resolves the TS sources.
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      'libsodium-wrappers-sumo': libsodiumCjsPath,
    };
    return config;
  },
};

export default nextConfig;
