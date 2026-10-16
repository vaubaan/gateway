// Flat ESLint config (ESLint 9). Applies to JS/TS across the monorepo.
// Strict TS rules per CLAUDE.md: noImplicitAny, strictNullChecks, no-floating-promises.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '**/dist/**',
      '**/.next/**',
      // Parallel-agent worktrees are independent git checkouts (gitignored) —
      // don't lint them as part of the main project.
      '.claude/worktrees/**',
      '**/out/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/.turbo/**',
      '**/.cache/**',
      // Test cases of the Semgrep rules: written to break them (scripts/sast.sh).
      '.semgrep/**',
      '.build/**',
      // Config files don't go through type-aware linting (no tsconfig include).
      'eslint.config.js',
      '**/postcss.config.mjs',
      '**/next.config.ts',
      '**/playwright.config.ts',
      'vitest.config.ts',
      // Next.js generates this file; the triple-slash reference is required.
      '**/next-env.d.ts',
      // fumadocs-mdx generates the site's collections (apps/website, `npm run generate`).
      'apps/website/.source/**',
      'apps/website/source.config.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.config.{js,cjs,mjs,ts}', '*.config.*.{js,cjs,mjs,ts}'],
          defaultProject: 'tsconfig.json',
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        {
          // React event handlers (onSubmit, onClick) routinely receive async fns;
          // the void return is fine here. Keep argument/return checks elsewhere.
          checksVoidReturn: { attributes: false },
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      // `async fn() { return value }` is fine when implementing a Promise-returning
      // contract (interface or override). The rule is stylistic and creates friction.
      '@typescript-eslint/require-await': 'off',
      // The policy engine deliberately String-coerces unknown values; the rule
      // would force us to special-case objects that we never expect.
      '@typescript-eslint/no-base-to-string': 'off',
      // Many test mocks pass methods as properties; for unit-test ergonomics we
      // accept the trade-off. Production callsites are reviewed independently.
      '@typescript-eslint/unbound-method': 'off',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  // CLI-ish ops scripts log to stdout by design; console is OK.
  {
    files: ['scripts/**/*.ts', 'scripts/**/*.mjs'],
    rules: {
      'no-console': 'off',
      // .mjs files run via tsconfig allowDefaultProject without strict
      // type-aware inference for Node stdlib return types (readdirSync
      // is inferred as any[]). The narrowing happens at runtime; ops
      // scripts don't carry the same type budget as production code.
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
  prettier,
);
