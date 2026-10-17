import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const rootDir = dirname(fileURLToPath(import.meta.url));
const appSrc = resolve(rootDir, 'apps/gateway/src');

/**
 * The test files that replace a module (`vi.mock`). They run isolated, each
 * file on a fresh module graph: without isolation, a module already loaded by
 * an earlier file of the same worker keeps the real dependency and the mock
 * never applies. `tests/unit/structural/module-mocks-isolated.test.ts` keeps
 * every `vi.mock` under these roots.
 */
export const ISOLATED_TESTS = ['apps/*/tests/unit/app/**/*.test.{ts,tsx}'];

const INCLUDE = [
  'apps/*/tests/unit/**/*.test.ts',
  'apps/*/tests/unit/**/*.test.tsx',
  'apps/*/tests/integration/**/*.test.ts',
  'packages/*/tests/unit/**/*.test.ts',
  'packages/*/tests/unit/**/*.test.tsx',
  'packages/*/tests/integration/**/*.test.ts',
  'plugins/*/tests/unit/**/*.test.ts',
  'packages/*/src/**/*.test.ts',
  'apps/*/src/**/*.test.ts',
  // Release helpers (plain Node scripts, no workspace of their own).
  'scripts/*.test.mjs',
];
const EXCLUDE = ['node_modules', 'dist', '.next', 'apps/*/tests/e2e/**'];

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
    // `include` and `exclude` belong to each project: a project that extends
    // this one would add its own to these, not replace them.
    passWithNoTests: false,
    reporters: ['default'],
    // One process per worker (`forks`: the git and ssh suites spawn processes,
    // and are three times slower on threads).
    pool: 'forks',
    projects: [
      {
        // `npm run test` runs this project with `--no-isolate`: one module
        // graph per worker, not per file. Every test file imports the
        // composition root, and re-evaluating it for each of ~400 files was
        // more than half of the run. Tests build their own root on a
        // `:memory:` store and share no module state. (Vitest 3 reads
        // `isolate` from the run, not from a project: hence the flag, and
        // isolation by default for a plain `vitest run`.)
        extends: true,
        test: {
          name: 'shared',
          include: INCLUDE,
          exclude: [...EXCLUDE, ...ISOLATED_TESTS],
        },
      },
      {
        extends: true,
        test: {
          name: 'isolated',
          include: ISOLATED_TESTS,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['**/*.d.ts', '**/tests/**', '**/*.config.*', '**/dist/**'],
    },
  },
});
