import { defineConfig } from 'vitest/config';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const rootDir = dirname(fileURLToPath(import.meta.url));

// The ESM build of libsodium-wrappers-sumo (0.7.16) references a sibling
// `libsodium.mjs` that isn't packaged — only the CJS bundle works under
// Vite's resolver. Resolve the bare specifier via CommonJS so we land on
// the `main` field (the CJS bundle) and bypass the `exports.import`
// entry.
const libsodiumCjsPath = require.resolve('libsodium-wrappers-sumo');

export default defineConfig({
  resolve: {
    alias: {
      // Mirror packages/web/tsconfig.json `paths` so route handlers and
      // their tests can import via `@/...` under vitest.
      '@/': `${resolve(rootDir, 'packages/web/src')}/`,
      'libsodium-wrappers-sumo': libsodiumCjsPath,
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['packages/*/tests/unit/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    exclude: ['node_modules', 'dist', '.next', 'packages/*/tests/e2e/**'],
    passWithNoTests: false,
    reporters: ['default'],
    // libsodium-wrappers ships an ESM entry that references a sibling
    // `libsodium.mjs` not actually present in the published tarball, so
    // bare Node ESM resolution fails. Inlining the dep routes it through
    // Vite's resolver, which honours `exports` and falls back to CJS.
    server: {
      deps: {
        inline: ['libsodium-wrappers-sumo'],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['**/*.d.ts', '**/tests/**', '**/*.config.*', 'packages/*/dist/**'],
    },
  },
});
