/**
 * `deploy/socle.json` (ADR plugin-catalog-rebuilt-from-source): the catalog versions the
 * image preinstalls. Until the compiled copies leave the server, each entry must be the
 * version compiled — the image then runs the catalog's build of the very same plugin, and
 * the gateway replaces the compiled copy only on that condition (`plugins/socle.ts`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SHIPPED_PLUGINS } from '../../../src/server/compose/shipped-plugins';

const REPO = join(import.meta.dirname, '../../../../..');
const socle = JSON.parse(readFileSync(join(REPO, 'deploy/socle.json'), 'utf8')) as {
  plugins: { id: string; version: string; sha256: string }[];
};

describe('deploy/socle.json', () => {
  it('pins each archive by its sha256, each id once', () => {
    for (const entry of socle.plugins) expect(entry.sha256, entry.id).toMatch(/^[0-9a-f]{64}$/);
    const ids = socle.plugins.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('lists only versions the server compiles, at the version compiled', () => {
    for (const { id, version } of socle.plugins) {
      const compiled = SHIPPED_PLUGINS.find((plugin) => plugin.id === id);
      expect(compiled, `${id} is not compiled into the server`).toBeDefined();
      expect(
        version,
        `${id}: the socle has ${version}, the server compiles ${compiled?.version}`,
      ).toBe(compiled?.version);
    }
  });

  it('never lists the plugins only the server can run', () => {
    const ids = socle.plugins.map((entry) => entry.id);
    expect(ids).not.toContain('vaubaan');
    expect(ids).not.toContain('ssh');
  });
});
