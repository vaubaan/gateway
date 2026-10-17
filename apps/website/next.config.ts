import type { NextConfig } from 'next';
import { createMDX } from 'fumadocs-mdx/next';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The `@vaubaan/*` workspaces this app imports as TypeScript source, read
 * from its own package.json so the list is written once.
 */
function workspaceDependencies(): string[] {
  const parsed: unknown = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8'));
  const deps =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as { dependencies?: Record<string, string> }).dependencies
      : undefined;
  return Object.keys(deps ?? {}).filter((name) => name.startsWith('@vaubaan/'));
}

const nextConfig: NextConfig = {
  // `npm run type-check` has checked this app when VAUBAAN_BUILD_TYPECHECKED=1
  // (`npm run ci`, the CI jobs that build): the build skips its second tsc pass.
  // Any other build (the image, a developer's) type-checks as usual.
  typescript: { ignoreBuildErrors: process.env.VAUBAAN_BUILD_TYPECHECKED === '1' },
  transpilePackages: workspaceDependencies(),
  poweredByHeader: false,
  // The site sets no cookie and loads nothing from a third party (website spec §1.1).
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
        ],
      },
      {
        // The Markdown twins of the pages (website spec §2.6), generated into public/.
        source: '/:path(.+\\.md)',
        headers: [{ key: 'Content-Type', value: 'text/markdown; charset=utf-8' }],
      },
      {
        // The same address answers HTML or Markdown depending on Accept (src/proxy.ts).
        source: '/:section(docs|plugins|trust)/:rest*',
        headers: [{ key: 'Vary', value: 'Accept' }],
      },
    ];
  },
};

// Compiles content/docs (source.config.ts) into .source/ (ADR website-nextjs-on-vercel D2).
const withMDX = createMDX();

export default withMDX(nextConfig);
