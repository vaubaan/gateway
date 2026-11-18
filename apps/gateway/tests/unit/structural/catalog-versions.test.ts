/**
 * The catalog versions this release knows (`catalog-versions.json`, ADR
 * plugins-installed-when-first-needed): what an instance installs when the versions feed
 * names none, and at a start for the plugins its accounts need. Each is pinned by its
 * archive's sha256 and is the repository's version of the plugin — the version this
 * release was tested with; the plugins only the server runs are never listed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { KNOWN_CATALOG_VERSIONS } from '../../../src/server/plugins/catalog';

const PLUGINS = join(import.meta.dirname, '../../../../../plugins');
const repositoryVersion = (id: string): string | undefined => {
  try {
    return (
      JSON.parse(readFileSync(join(PLUGINS, id, 'package.json'), 'utf8')) as { version: string }
    ).version;
  } catch {
    return undefined;
  }
};

describe('the catalog versions this release knows', () => {
  it('pins each archive by its sha256', () => {
    for (const [id, known] of KNOWN_CATALOG_VERSIONS) {
      expect(known.sha256, id).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('names each plugin at the version of this repository', () => {
    for (const [id, known] of KNOWN_CATALOG_VERSIONS) {
      expect(known.version, `${id}: plugins/${id} is ${repositoryVersion(id)}`).toBe(
        repositoryVersion(id),
      );
    }
  });

  it('covers every plugin of the repository the catalog declares, never vaubaan nor ssh', () => {
    const ids = [...KNOWN_CATALOG_VERSIONS.keys()];
    expect(ids).not.toContain('vaubaan');
    expect(ids).not.toContain('ssh');
    const repository = readdirSync(PLUGINS, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
      .map((d) => d.name)
      .filter((id) => id !== 'vaubaan' && id !== 'ssh');
    expect(ids.sort()).toEqual(repository.sort());
  });
});
