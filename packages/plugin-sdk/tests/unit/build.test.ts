/**
 * The published SDK carries `@vaubaan/shared` and `@vaubaan/policy-engine` inside
 * (handbook plugin-sdk, Publication): their imports are rewritten to `dist/internal/`,
 * declaration files point at the emitted `.js`, and the published manifest no longer
 * depends on them.
 */
import { describe, expect, it } from 'vitest';

import { rewriteDeclarationExtensions, rewriteSpecifiers } from '../../scripts/build.ts';
import { publishedDependencies } from '../../scripts/publish-manifest.ts';

const DIST = '/pkg/dist';

describe('SDK build', () => {
  it('points the inlined packages at dist/internal, from any depth', () => {
    expect(
      rewriteSpecifiers(`import { a } from '@vaubaan/shared';`, `${DIST}/index.js`, DIST),
    ).toBe(`import { a } from './internal/shared/index.js';`);
    expect(
      rewriteSpecifiers(
        `export type { R } from "@vaubaan/policy-engine";`,
        `${DIST}/testing/kit.d.ts`,
        DIST,
      ),
    ).toBe(`export type { R } from "../internal/policy-engine/index.js";`);
    expect(
      rewriteSpecifiers(
        `import { t } from '@vaubaan/shared/risk-id';`,
        `${DIST}/internal/policy-engine/qualify.js`,
        DIST,
      ),
    ).toBe(`import { t } from '../shared/risk-id.js';`);
  });

  it('leaves comments, other packages and Symbol.for keys alone', () => {
    const source = [
      `// see @vaubaan/shared`,
      `import yaml from 'js-yaml';`,
      `const k = Symbol.for('@vaubaan/policy-engine/no-single-env');`,
    ].join('\n');
    expect(rewriteSpecifiers(source, `${DIST}/index.js`, DIST)).toBe(source);
  });

  it('points declaration files at the emitted modules', () => {
    expect(rewriteDeclarationExtensions(`export * from './plugin.ts';`)).toBe(
      `export * from './plugin.js';`,
    );
    expect(rewriteDeclarationExtensions(`import type { X } from "../shared/index.ts";`)).toBe(
      `import type { X } from "../shared/index.js";`,
    );
    expect(rewriteDeclarationExtensions(`import type { Y } from 'js-yaml';`)).toBe(
      `import type { Y } from 'js-yaml';`,
    );
  });

  it('publishes without the inlined workspace packages', () => {
    expect(
      publishedDependencies({
        '@vaubaan/policy-engine': '*',
        '@vaubaan/shared': '*',
        'js-yaml': '^5.5.0',
      }),
    ).toEqual({ 'js-yaml': '^5.5.0' });
  });
});
