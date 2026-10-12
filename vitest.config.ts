import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const rootDir = dirname(fileURLToPath(import.meta.url));
const appSrc = resolve(rootDir, 'apps/gateway/src');

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  resolve: {
    alias: {
      '@/': `${appSrc}/`,
    },
  },
  test: {
    environment: 'node',
    globals: false,
    env: { SKIP_LIVE: '1' },
    include: [
      'apps/*/tests/unit/**/*.test.ts',
      'apps/*/tests/unit/**/*.test.tsx',
      'apps/*/tests/integration/**/*.test.ts',
      'packages/*/tests/unit/**/*.test.ts',
      'packages/*/tests/unit/**/*.test.tsx',
      'packages/*/tests/integration/**/*.test.ts',
      'plugins/*/tests/unit/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
    ],
    exclude: ['node_modules', 'dist', '.next', 'apps/*/tests/e2e/**'],
    environmentMatchGlobs: [['apps/gateway/tests/unit/components/**', 'jsdom']],
    passWithNoTests: false,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['**/*.d.ts', '**/tests/**', '**/*.config.*', '**/dist/**'],
    },
  },
});
