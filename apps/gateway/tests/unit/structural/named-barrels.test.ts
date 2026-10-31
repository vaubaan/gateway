/**
 * Structural: the barrels of the shared packages name their public API (packages
 * audit 2026-10-31, F5). An `export *` makes every helper of a module public the
 * day it is written, and a pull request then changes a package's contract without
 * a line saying so. The telemetry package already named its exports; the three
 * others follow, and this test keeps it so. A name a package keeps for itself is
 * imported from its module by the package's own tests.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const BARRELS = [
  'packages/shared/src/index.ts',
  'packages/gateway-core/src/index.ts',
  'packages/policy-engine/src/index.ts',
  'packages/telemetry/src/index.ts',
] as const;

describe('package barrels', () => {
  it.each(BARRELS)('%s names every export, none with export *', (barrel) => {
    const text = readFileSync(resolve(REPO, barrel), 'utf8');
    expect(text).not.toMatch(/^\s*export\s+\*/m);
    expect(text).toMatch(/^export (type )?\{/m);
  });
});
