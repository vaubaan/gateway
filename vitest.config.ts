import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const rootDir = dirname(fileURLToPath(import.meta.url));
const webSrc = resolve(rootDir, 'packages/web/src');

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  resolve: {
    alias: {
      '@/': `${webSrc}/`,
    },
  },
  test: {
    environment: 'node',
    globals: false,
    env: { SKIP_LIVE: '1' },
    include: [
      'packages/*/tests/unit/**/*.test.ts',
      'packages/*/tests/unit/**/*.test.tsx',
      'packages/*/tests/integration/**/*.test.ts',
      'packages/providers/*/tests/unit/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
    ],
    exclude: ['node_modules', 'dist', '.next', 'packages/*/tests/e2e/**'],
    environmentMatchGlobs: [['packages/web/tests/unit/components/**', 'jsdom']],
    passWithNoTests: false,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['**/*.d.ts', '**/tests/**', '**/*.config.*', 'packages/*/dist/**'],
    },
  },
});
