/**
 * The provider table lives in `packages/oauth-providers` (the gateway imports
 * it); the broker runs a byte-identical copy in `src/providers.ts`, because its
 * image builds from `apps/oauth-broker` alone and runs its own sources with no
 * dependency (ADR oauth-broker-runs-its-typescript-source-with-no-dependency).
 * An edit to one and not the other fails here: copy the source over the broker's.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = resolve(APP, '../../packages/oauth-providers/src/providers.ts');
const COPY = resolve(APP, 'src/providers.ts');

describe('the broker’s provider table', () => {
  it('is a byte-identical copy of packages/oauth-providers/src/providers.ts', () => {
    expect(readFileSync(COPY, 'utf8')).toBe(readFileSync(SOURCE, 'utf8'));
  });

  it('imports nothing, so the copy runs in the image as it is', () => {
    expect(readFileSync(COPY, 'utf8')).not.toMatch(/^\s*(import|export\s.*\sfrom)\s/m);
  });
});
